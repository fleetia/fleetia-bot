import { readFileSync } from 'node:fs';

import { App, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';

export type PreviewConfig = {
  account: string;
  hostedZoneId: string;
  region: string;
  repository: string;
  domain: string;
  project: string;
  oidcProviderArn: string;
  oidcSubject: string;
};

export function createRouterCode(domain: string): string {
  return readFileSync(new URL('./router.js', import.meta.url), 'utf8').replace(
    '__PREVIEW_DOMAIN__',
    JSON.stringify(domain),
  );
}

export function createPreviewStacks(app: App, config: PreviewConfig): {
  certificateStack: Stack;
  previewStack: Stack;
} {
  const subject = /^repo:([^:@/]+)(?:@([1-9]\d*))?\/([^:@/]+)(?:@([1-9]\d*))?:ref:refs\/heads\/main$/.exec(config.oidcSubject);
  if (!subject || `${subject[1]}/${subject[3]}` !== config.repository || Boolean(subject[2]) !== Boolean(subject[4])) {
    throw new Error('OIDC subject must identify the configured repository and main branch exactly');
  }
  const certificateStack = new Stack(app, `${config.project}-preview-certificate`, {
    env: { account: config.account, region: 'us-east-1' },
    crossRegionReferences: true,
  });
  const certificateZone = route53.HostedZone.fromHostedZoneAttributes(certificateStack, 'Zone', {
    hostedZoneId: config.hostedZoneId,
    zoneName: 'star-light.space',
  });
  const certificate = new acm.Certificate(certificateStack, 'Certificate', {
    domainName: `*.${config.domain}`,
    validation: acm.CertificateValidation.fromDns(certificateZone),
  });
  const previewStack = new Stack(app, `${config.project}-preview`, {
    env: { account: config.account, region: config.region },
    crossRegionReferences: true,
  });
  const bucket = new s3.Bucket(previewStack, 'Bucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const router = new cloudfront.Function(previewStack, 'Router', {
    runtime: cloudfront.FunctionRuntime.JS_2_0,
    code: cloudfront.FunctionCode.fromInline(createRouterCode(config.domain)),
  });
  const cachePolicy = new cloudfront.CachePolicy(previewStack, 'CachePolicy', {
    minTtl: Duration.seconds(0),
    defaultTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
  });
  const distribution = new cloudfront.Distribution(previewStack, 'Distribution', {
    certificate,
    domainNames: [`*.${config.domain}`],
    minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy,
      compress: true,
      functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: router }],
    },
    errorResponses: [
      { httpStatus: 403, ttl: Duration.seconds(0) },
      { httpStatus: 404, ttl: Duration.seconds(0) },
    ],
  });
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY,
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    actions: ['s3:GetObject'],
    resources: [bucket.arnForObjects('_control/*')],
  }));
  const zone = route53.HostedZone.fromHostedZoneAttributes(previewStack, 'Zone', {
    hostedZoneId: config.hostedZoneId,
    zoneName: 'star-light.space',
  });
  new route53.ARecord(previewStack, 'WildcardAlias', {
    zone,
    recordName: `*.${config.domain}`,
    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
  });
  new route53.AaaaRecord(previewStack, 'WildcardIpv6Alias', {
    zone,
    recordName: `*.${config.domain}`,
    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
  });

  const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    previewStack, 'GithubOidc', config.oidcProviderArn,
  );
  const role = new iam.Role(previewStack, 'DeploymentRole', {
    assumedBy: new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': config.oidcSubject,
      },
    }),
    maxSessionDuration: Duration.hours(1),
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [bucket.bucketArn],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [bucket.arnForObjects('*')],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['cloudfront:GetDistribution', 'cloudfront:GetDistributionConfig', 'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
    resources: [distribution.distributionArn],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:DescribeStacks'],
    resources: [previewStack.stackId, certificateStack.stackId],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['acm:DescribeCertificate'], resources: [certificate.certificateArn],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['route53:GetHostedZone', 'route53:ListResourceRecordSets'],
    resources: [`arn:${previewStack.partition}:route53:::hostedzone/${config.hostedZoneId}`],
  }));

  const outputs: Record<string, string> = {
    BucketName: bucket.bucketName,
    DistributionId: distribution.distributionId,
    DistributionDomainName: distribution.distributionDomainName,
    DeploymentRoleArn: role.roleArn,
    CertificateArn: certificate.certificateArn,
    HostedZoneId: config.hostedZoneId,
    PreviewDomain: config.domain,
  };
  for (const [name, value] of Object.entries(outputs)) {
    new CfnOutput(previewStack, name, { value });
  }
  return { certificateStack, previewStack };
}
