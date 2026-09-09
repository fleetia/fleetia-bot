import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { createPreviewStacks } from '../infra/preview-stack.js';

function synthesize(): { preview: Template; certificate: Template } {
  const app = new App();
  const stacks = createPreviewStacks(app, {
    account: '123456789012', region: 'ap-northeast-2', hostedZoneId: 'ZEXAMPLE',
    repository: 'fleetia/kbo-knit', project: 'kbo-knit', domain: 'kbo-knit.star-light.space',
    oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
  });
  return { preview: Template.fromStack(stacks.previewStack), certificate: Template.fromStack(stacks.certificateStack) };
}

describe('preview infrastructure', () => {
  it('uses a retained private bucket with signed OAC and denies CloudFront access to deployment controls', () => {
    const { preview } = synthesize();
    preview.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: { PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      } },
    });
    preview.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { SigningBehavior: 'always', SigningProtocol: 'sigv4', OriginAccessControlOriginType: 's3' },
    });
    preview.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Effect: 'Deny', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject',
        Resource: { 'Fn::Join': ['', Match.arrayWith(['/_control/*'])] },
      })]) },
    });
  });

  it('routes before cache lookup, permits zero TTL and never maps missing files to a success HTML response', () => {
    const { preview, certificate } = synthesize();
    certificate.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: '*.kbo-knit.star-light.space', ValidationMethod: 'DNS',
    });
    preview.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: { MinTTL: 0, DefaultTTL: 0, MaxTTL: 31536000 },
    });
    preview.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['*.kbo-knit.star-light.space'],
        DefaultCacheBehavior: { FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: Match.anyValue() }] },
        CustomErrorResponses: [
          { ErrorCode: 403, ErrorCachingMinTTL: 0 }, { ErrorCode: 404, ErrorCachingMinTTL: 0 },
        ],
      },
    });
  });

  it('reuses OIDC and limits deployment trust to the product default branch', () => {
    const { preview } = synthesize();
    preview.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    preview.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [{
        Action: 'sts:AssumeRoleWithWebIdentity', Effect: 'Allow',
        Principal: { Federated: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com' },
        Condition: { StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': 'repo:fleetia/kbo-knit:ref:refs/heads/main',
        } },
      }] },
    });
    const policies = JSON.stringify(preview.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('s3:*');
    expect(policies).not.toContain('cloudformation:*');
    expect(policies).not.toContain('cloudfront:UpdateDistribution');
    preview.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [Match.anyValue(), 'Arn'] }, '/*']] } }),
    ]) } });
    for (const name of ['BucketName', 'DistributionId', 'DistributionDomainName', 'DeploymentRoleArn', 'CertificateArn', 'HostedZoneId', 'PreviewDomain']) {
      preview.hasOutput(name, {});
    }
  });
});
