import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { createRouterCode } from '../infra/preview-stack.js';

type Request = {
  method: string;
  uri: string;
  headers: Record<string, { value: string }>;
  querystring: Record<string, { value: string }>;
};
type Response = { statusCode: number };

function route(uri: string, options: { host?: string; accept?: string; method?: string; destination?: string } = {}): Request | Response {
  const request: Request = {
    method: options.method ?? 'GET',
    uri,
    headers: {
      host: { value: options.host ?? 'feature-score.kbo-knit.star-light.space' },
      accept: { value: options.accept ?? 'text/html,application/xhtml+xml' },
      ...(options.destination ? { 'sec-fetch-dest': { value: options.destination } } : {}),
    },
    querystring: { filter: { value: 'all' } },
  };
  const result: unknown = runInNewContext(
    `${createRouterCode('kbo-knit.star-light.space')}\nhandler({ request });`,
    { request },
    { timeout: 1000 },
  );
  return result as Request | Response;
}

describe('CloudFront deployed router', () => {
  it('isolates branch keys before cache lookup and preserves the query string', () => {
    expect(route('/assets/app-abc123.js', { accept: '*/*' })).toMatchObject({
      uri: '/feature-score/assets/app-abc123.js', querystring: { filter: { value: 'all' } },
    });
    expect(route('/assets/app-abc123.js', { host: 'fix-score.kbo-knit.star-light.space' })).toMatchObject({
      uri: '/fix-score/assets/app-abc123.js',
    });
  });

  it.each(['/', '/teams', '/teams/lg/', '/patterns/new'])('serves the branch SPA for navigation to %s', (uri) => {
    expect(route(uri)).toMatchObject({ uri: '/feature-score/index.html' });
  });

  it.each(['/assets/missing.js', '/assets/missing', '/data/teams.json', '/data/missing', '/static/missing', '/sw.js', '/manifest.webmanifest'])('preserves missing static resource %s instead of returning HTML', (uri) => {
    expect(route(uri)).toMatchObject({ uri: `/feature-score${uri}` });
  });

  it('does not convert an API/fetch request to SPA navigation', () => {
    expect(route('/teams', { accept: 'application/json' })).toMatchObject({ uri: '/feature-score/teams' });
    expect(route('/teams', { destination: 'empty' })).toMatchObject({ uri: '/feature-score/teams' });
  });

  it.each([
    'd123.cloudfront.net', 'kbo-knit.star-light.space', 'x.y.kbo-knit.star-light.space',
    'UPPER.kbo-knit.star-light.space', '-branch.kbo-knit.star-light.space',
    'branch-.kbo-knit.star-light.space', '_control.kbo-knit.star-light.space',
    'x.kbo-knit.star-light.space.evil.com', `${'a'.repeat(64)}.kbo-knit.star-light.space`,
  ])('rejects unrecognized host %s', (host) => {
    expect(route('/', { host })).toMatchObject({ statusCode: 403 });
  });

  it.each([
    '/../other/index.html', '/x/../../_control/state.json', '/%2e%2e/other/index.html',
    '/x%2fy', '/x%5Cy', '/%252e%252e/other', '/x\\y', '//other/index.html',
    '/_control/state.json', '/%5fcontrol/state.json', '/x/%00/y', '/bad%uri',
    '/./index.html', '/x/%2E/y', '/x?y', '/x#y',
  ])('rejects prefix escape or control request %s', (uri) => {
    expect(route(uri)).toMatchObject({ statusCode: 403 });
  });

  it('rejects writes but supports HEAD navigation', () => {
    expect(route('/', { method: 'POST' })).toMatchObject({ statusCode: 403 });
    expect(route('/', { method: 'HEAD' })).toMatchObject({ uri: '/feature-score/index.html', method: 'HEAD' });
  });
});
