import { App } from 'aws-cdk-lib';

import { createPreviewStacks } from './preview-stack.js';

const app = new App();

function readContext(name: string, fallback?: string): string {
  const value: unknown = app.node.tryGetContext(name) ?? fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing CDK context: ${name}`);
  }
  return value;
}

const account = readContext('account', process.env.CDK_DEFAULT_ACCOUNT);
const project = readContext('project', 'kbo-knit');
const domain = readContext('domain', 'kbo-knit.star-light.space');
const repository = readContext('repository', 'fleetia/kbo-knit');
const oidcProviderArn = readContext('oidcProviderArn');
const oidcSubject = readContext('oidcSubject');
if (!/^\d{12}$/.test(account) || !/^[a-z0-9-]+$/.test(project)
  || !/^[a-z0-9-]+\.star-light\.space$/.test(domain)
  || !/^[\w.-]+\/[\w.-]+$/.test(repository)
  || oidcProviderArn !== `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`) {
  throw new Error('Invalid preview infrastructure context');
}
createPreviewStacks(app, {
  account, project, domain, repository, oidcProviderArn, oidcSubject,
  hostedZoneId: readContext('hostedZoneId').replace(/^\/hostedzone\//, ''),
  region: readContext('region', 'ap-northeast-2'),
});
