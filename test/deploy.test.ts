import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOrder, type Request } from '../src/commands';
import { prepare, publish } from '../src/deploy';
import type { BranchState } from '../src/state';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(async (): Promise<void> => undefined),
  open: vi.fn(async (): Promise<boolean> => false),
  invalidate: vi.fn(async (): Promise<void> => undefined),
  pull: vi.fn(),
  github: vi.fn(async (): Promise<unknown> => ({ status: 'completed', conclusion: 'failure' })),
}));
let client: S3Client;
vi.mock('../src/github', () => ({ getPullRequest: mocks.pull, verifyRequest: mocks.verify, hasOpenBranch: mocks.open, github: mocks.github }));
vi.mock('../src/aws', () => ({
  s3Client: (): S3Client => client,
  checkInfrastructure: async () => ({ bucket: 'preview', distributionId: 'distribution', distributionDomain: 'test.cloudfront.net', certificateArn: 'certificate', hostedZoneId: 'zone' }),
  invalidate: mocks.invalidate,
}));

const request: Request = {
  action: 'deploy', repository: 'fleetia/kbo-knit', pr: 42, branch: 'feature-login', branchId: 'feature-login',
  sha: 'a'.repeat(40), order: requestOrder('2026-09-09T08:00:00Z', 1), runId: 12,
  commentId: 1, commandBody: '@fleetia-bot deploy',
};
const objects = new Map<string, { body: string | Uint8Array; type?: string; etag: string }>();
const operations: string[] = [];
let directory: string;
let etag = 0;
let deletionErrors = false;
let corruptServedAsset = false;
let forcePublicIndex = false;

function state(): BranchState | null {
  const value = objects.get(`_control/${request.branchId}.json`);
  return value ? JSON.parse(Buffer.from(value.body).toString()) as BranchState : null;
}
function seedState(value: BranchState): void {
  objects.set(`_control/${request.branchId}.json`, { body: JSON.stringify(value), etag: `etag-${++etag}` });
}
function pending(source = request): BranchState {
  return { request: source, phase: 'building', deployedSha: 'b'.repeat(40), detail: 'Building' };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.verify.mockReset().mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(false);
  mocks.pull.mockResolvedValue({ branch: request.branch, repository: request.repository, sha: request.sha });
  mocks.invalidate.mockReset().mockImplementation(async () => { operations.push('invalidate'); });
  objects.clear(); operations.length = 0; etag = 0;
  deletionErrors = false; corruptServedAsset = false; forcePublicIndex = false;
  directory = await mkdtemp(join(tmpdir(), 'fleetia-deploy-test-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html><script src="/assets/app-12345678.js"></script></html>');
  await writeFile(join(directory, 'assets/app-12345678.js'), 'export const ready = true;');
  await writeFile(join(directory, 'assets/app-12345678.css'), 'body { color: black; }');
  await writeFile(join(directory, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  client = new S3Client({ region: 'ap-northeast-2' });
  vi.spyOn(client, 'send').mockImplementation(async (command) => {
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? '');
      if (!object) { throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); }
      return { Body: { transformToString: async () => Buffer.from(object.body).toString() }, ETag: object.etag };
    }
    if (command instanceof PutObjectCommand) {
      const input = command.input;
      const key = input.Key ?? '';
      const existing = objects.get(key);
      if ((input.IfNoneMatch === '*' && existing) || (input.IfMatch && input.IfMatch !== existing?.etag)) {
        throw Object.assign(new Error('State conflict'), { name: 'PreconditionFailed' });
      }
      if (typeof input.Body !== 'string' && !(input.Body instanceof Uint8Array)) { throw new Error('Unsupported test body'); }
      const next = `etag-${++etag}`;
      objects.set(key, { body: input.Body, type: input.ContentType, etag: next });
      operations.push(key.startsWith('_control/') ? `state:${state()?.phase}` : `put:${key}`);
      return { ETag: next };
    }
    if (command instanceof ListObjectsV2Command) {
      operations.push('list');
      const keys = [...objects.keys()].filter((key) => key.startsWith(command.input.Prefix ?? '') && key > (command.input.ContinuationToken ?? '')).sort();
      const page = keys.slice(0, 1000);
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: keys.length > 1000, NextContinuationToken: page.at(-1) };
    }
    if (command instanceof DeleteObjectsCommand) {
      operations.push(`delete:${command.input.Delete?.Objects?.length}`);
      if (deletionErrors) { return { Errors: [{ Key: request.branchId + '/index.html', Code: 'AccessDenied' }] }; }
      for (const entry of command.input.Delete?.Objects ?? []) { objects.delete(entry.Key ?? ''); }
      return {};
    }
    throw new Error('Unexpected S3 command');
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(`https://${request.branchId}.kbo-knit.star-light.space`);
    expect(options?.redirect).toBe('error');
    operations.push(`fetch:${url.pathname}`);
    const object = objects.get(`${request.branchId}${url.pathname}`);
    if (forcePublicIndex && url.pathname === '/index.html') { return new Response('still live'); }
    if (!object) { return new Response('missing', { status: 404 }); }
    if (corruptServedAsset && url.pathname.endsWith('.js')) { return new Response('stale asset'); }
    return new Response(Buffer.from(object.body), { headers: { 'content-type': object.type ?? 'text/plain' } });
  }));
});
afterEach(async () => { client.destroy(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

describe('preview lifecycle', () => {
  it('records building with CAS before releasing an accepted build', async () => {
    const outcome = await prepare(request);
    expect(outcome.deploy).toBe(true);
    expect(state()).toMatchObject({ request, phase: 'building', deployedSha: null });
    expect(operations).toEqual(['state:building']);
  });

  it('keeps status read-only and does not advance request ordering', async () => {
    seedState({ ...pending(), phase: 'ready', deployedSha: request.sha });
    const outcome = await prepare({ ...request, action: 'status', order: requestOrder('2026-09-09T09:00:00Z', 2) });
    expect(outcome).toMatchObject({ deploy: false, deployedSha: request.sha });
    expect(outcome.detail).toContain('matches the current PR head');
    expect(state()?.request.order).toBe(request.order);
    expect(operations).toEqual([]);
  });

  it('reports failed or cancelled build runs without changing their persisted state', async () => {
    seedState(pending());
    mocks.github.mockResolvedValueOnce({ status: 'completed', conclusion: 'cancelled' });
    const outcome = await prepare({ ...request, action: 'status' });
    expect(outcome.detail).toContain('completed (cancelled)');
    expect(outcome.detail).toContain('differs from the last verified deployment');
    expect(state()?.phase).toBe('building');
    expect(operations).toEqual([]);
  });

  it('rejects older deploy and delete requests after a newer deletion tombstone', async () => {
    const newer = { ...request, action: 'delete' as const, order: requestOrder('2026-09-09T09:00:00Z', 2) };
    seedState({ ...pending(newer), phase: 'deleted', deployedSha: null });
    expect((await prepare(request)).deploy).toBe(false);
    expect((await prepare({ ...request, action: 'delete' })).deploy).toBe(false);
    expect(operations).toEqual([]);
    expect(state()?.request.order).toBe(newer.order);
  });

  it('preserves prefix ownership even for a newer command', async () => {
    seedState({ ...pending(), request: { ...request, branch: 'different-source' } });
    await expect(prepare(request)).rejects.toThrow();
    expect(operations).toEqual([]);
  });

  it('retains a reopened/shared branch on close but permits a manual delete', async () => {
    mocks.open.mockResolvedValue(true);
    const { commentId: _, commandBody: __, ...closed } = request;
    expect((await prepare({ ...closed, action: 'delete' })).detail).toContain('open PR');
    expect(operations).toEqual([]);
    expect((await prepare({ ...request, action: 'delete' })).detail).toContain('deleted');
    expect(state()?.phase).toBe('deleted');
  });

  it('deletes only its branch in bounded batches after a tombstone, then verifies edge removal', async () => {
    seedState({ ...pending(), phase: 'ready' });
    for (let index = 0; index < 1001; index += 1) {
      objects.set(`${request.branchId}/asset-${String(index).padStart(4, '0')}`, { body: 'asset', etag: 'asset' });
    }
    objects.set('other/index.html', { body: 'other', etag: 'other' });
    await prepare({ ...request, action: 'delete' });
    expect(operations).toEqual(['state:deleting', 'list', 'delete:1000', 'list', 'delete:1', 'invalidate', 'fetch:/index.html', 'state:deleted']);
    expect(objects.has('other/index.html')).toBe(true);
    expect(objects.has(`_control/${request.branchId}.json`)).toBe(true);
    expect(state()?.deployedSha).toBeNull();
  });

  it.each(['s3', 'invalidation', 'index'])('records failed deletion when %s does not confirm removal', async (failure) => {
    objects.set(`${request.branchId}/index.html`, { body: 'old', etag: 'old' });
    deletionErrors = failure === 's3';
    forcePublicIndex = failure === 'index';
    if (failure === 'invalidation') { mocks.invalidate.mockRejectedValueOnce(new Error('wait timeout')); }
    await expect(prepare({ ...request, action: 'delete' })).rejects.toThrow();
    expect(state()?.phase).toBe('failed');
    expect(state()?.detail).toContain('may remain');
    expect(operations).not.toContain('state:deleted');
  });

  it('uploads assets, HTML and SW in order, leaves old chunks, and verifies the actual manifest and content', async () => {
    seedState(pending());
    objects.set(`${request.branchId}/assets/old-12345678.js`, { body: 'old', etag: 'old' });
    const outcome = await publish(request, directory);
    expect(outcome.deployedSha).toBe(request.sha);
    const writes = operations.filter((operation) => operation.startsWith('put:'));
    expect(writes).toEqual([
      `put:${request.branchId}/assets/app-12345678.css`, `put:${request.branchId}/assets/app-12345678.js`,
      `put:${request.branchId}/index.html`, `put:${request.branchId}/sw.js`, `put:${request.branchId}/__fleetia.json`,
    ]);
    expect(objects.has(`${request.branchId}/assets/old-12345678.js`)).toBe(true);
    expect(state()).toMatchObject({ phase: 'ready', deployedSha: request.sha });
    const proof = JSON.parse(Buffer.from(objects.get(`${request.branchId}/__fleetia.json`)?.body ?? '').toString());
    expect(proof).toMatchObject({ sha: request.sha, branch: request.branch, runId: request.runId });
    expect(proof.files).toContainEqual({ key: 'index.html', size: (await readFile(join(directory, 'index.html'))).byteLength,
      sha256: createHash('sha256').update(await readFile(join(directory, 'index.html'))).digest('hex') });
    expect(mocks.verify).toHaveBeenCalledTimes(4);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('blocks publication when its preparation has been superseded', async () => {
    seedState(pending({ ...request, order: requestOrder('2026-09-09T09:00:00Z', 2) }));
    await expect(publish(request, directory)).rejects.toThrow('superseded');
    expect(operations).toEqual([]);
  });

  it('rechecks the request immediately before public HTML and never overwrites a newer state on failure', async () => {
    seedState(pending());
    mocks.verify.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => {
      seedState({ ...pending({ ...request, action: 'delete', order: requestOrder('2026-09-09T09:00:00Z', 2) }), phase: 'deleting' });
    });
    await expect(publish(request, directory)).rejects.toThrow('superseded');
    expect(operations.some((operation) => operation.endsWith('/index.html'))).toBe(false);
    expect(state()?.phase).toBe('deleting');
  });

  it('records an honest publication failure when CloudFront serves a mismatched asset', async () => {
    seedState(pending());
    corruptServedAsset = true;
    await expect(publish(request, directory)).rejects.toThrow('does not match');
    expect(state()).toMatchObject({ phase: 'failed', deployedSha: 'b'.repeat(40) });
    expect(state()?.detail).toContain('some public files may have changed');
    expect(operations).not.toContain('state:ready');
  });

  it('revalidates current PR and exact SHA before writing anything', async () => {
    seedState(pending());
    mocks.verify.mockRejectedValueOnce(new Error('PR head changed'));
    await expect(publish(request, directory)).rejects.toThrow('head changed');
    expect(operations).toEqual([]);
  });
});
