import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, CreateInvalidationCommand, GetDistributionCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { project } from './project';
import { requiredEnvironment, string } from './validation';

export type Infrastructure = {
  bucket: string;
  distributionId: string;
  distributionDomain: string;
  certificateArn: string;
  hostedZoneId: string;
};

const requestOptions = {
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
};

export function s3Client(): S3Client {
  return new S3Client({ ...requestOptions, region: requiredEnvironment('AWS_REGION') });
}

export async function checkInfrastructure(): Promise<Infrastructure> {
  const region = requiredEnvironment('AWS_REGION');
  const stackName = requiredEnvironment('FLEETIA_PREVIEW_STACK');
  if (stackName !== `${project.id}-preview`) {
    throw new Error('Unexpected preview stack name');
  }
  const identity = await new STSClient({ ...requestOptions, region }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== requiredEnvironment('FLEETIA_AWS_ACCOUNT_ID')) {
    throw new Error('AWS account does not match the configured personal account');
  }
  const result = await new CloudFormationClient({ ...requestOptions, region }).send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = result.Stacks?.[0];
  if (!stack || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus ?? '')) {
    throw new Error('Preview CDK stack is missing, updating, or failed');
  }
  const outputs = new Map(stack.Outputs?.map((output) => [output.OutputKey, output.OutputValue]));
  if (outputs.get('PreviewDomain') !== project.domain) {
    throw new Error('Preview domain does not match the registered project');
  }
  const infrastructure: Infrastructure = {
    bucket: string(outputs.get('BucketName')),
    distributionId: string(outputs.get('DistributionId')),
    distributionDomain: string(outputs.get('DistributionDomainName')),
    certificateArn: string(outputs.get('CertificateArn')),
    hostedZoneId: string(outputs.get('HostedZoneId')),
  };
  const [distribution, certificate, records] = await Promise.all([
    new CloudFrontClient({ ...requestOptions, region }).send(new GetDistributionCommand({ Id: infrastructure.distributionId })),
    new ACMClient({ ...requestOptions, region: 'us-east-1' }).send(new DescribeCertificateCommand({ CertificateArn: infrastructure.certificateArn })),
    new Route53Client({ ...requestOptions, region }).send(new ListResourceRecordSetsCommand({
      HostedZoneId: infrastructure.hostedZoneId,
      StartRecordName: `*.${project.domain}`, StartRecordType: 'A', MaxItems: 2,
    })),
    s3Client().send(new HeadBucketCommand({ Bucket: infrastructure.bucket })),
  ]);
  const config = distribution.Distribution?.DistributionConfig;
  if (distribution.Distribution?.Status !== 'Deployed' || !config?.Enabled ||
      !config.Aliases?.Items?.includes(`*.${project.domain}`) ||
      config.ViewerCertificate?.ACMCertificateArn !== infrastructure.certificateArn ||
      !config.Origins?.Items?.some((origin) => origin.DomainName?.startsWith(`${infrastructure.bucket}.s3.`) && origin.OriginAccessControlId)) {
    throw new Error('CloudFront domain, certificate, private origin, or deployment state does not match');
  }
  if (certificate.Certificate?.Status !== 'ISSUED' ||
      !certificate.Certificate.SubjectAlternativeNames?.includes(`*.${project.domain}`)) {
    throw new Error('Preview wildcard certificate is not issued');
  }
  const wildcard = records.ResourceRecordSets?.find((entry) =>
    entry.Type === 'A' && entry.Name?.replace(/\\052/g, '*') === `*.${project.domain}.`);
  if (wildcard?.AliasTarget?.DNSName?.replace(/\.$/, '') !== infrastructure.distributionDomain) {
    throw new Error('Preview wildcard DNS does not point to the expected CloudFront distribution');
  }
  return infrastructure;
}

export async function invalidate(infrastructure: Infrastructure, callerReference: string): Promise<void> {
  const client = new CloudFrontClient({ ...requestOptions, region: requiredEnvironment('AWS_REGION') });
  const result = await client.send(new CreateInvalidationCommand({
    DistributionId: infrastructure.distributionId,
    InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: 1, Items: ['/*'] } },
  }));
  await waitUntilInvalidationCompleted({ client, maxWaitTime: 900 }, {
    DistributionId: infrastructure.distributionId, Id: string(result.Invalidation?.Id),
  });
}
