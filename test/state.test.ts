import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { requestOrder, type Request } from '../src/commands';
import { checkOwnership, isLatest, parseState, readState, writeState, type BranchState } from '../src/state';

const request: Request = {
  action: 'deploy', repository: 'fleetia/kbo-knit', pr: 42, branch: 'feature-score', branchId: 'feature-score',
  sha: 'a'.repeat(40), order: requestOrder('2026-09-09T08:00:00Z', 1), runId: 1,
};
const state: BranchState = { request, phase: 'ready', deployedSha: request.sha, detail: 'Deployed' };

describe('durable branch state', () => {
  it('fails closed for malformed state and accepts the declared lifecycle phases', () => {
    for (const phase of ['building', 'publishing', 'ready', 'deleting', 'deleted', 'failed']) {
      expect(parseState({ ...state, phase }).phase).toBe(phase);
    }
    for (const value of [null, [], { ...state, phase: 'unknown' }, { ...state, deployedSha: 'main' },
      { ...state, request: { ...request, branchId: 'other' } }, { ...state, detail: null }]) {
      expect(() => parseState(value)).toThrow();
    }
  });

  it('blocks prefix ownership collisions even when the incoming request is newer', () => {
    const newer = { ...request, order: requestOrder('2026-09-09T08:00:01Z', 2) };
    expect(isLatest(newer, state)).toBe(true);
    expect(() => checkOwnership({ ...newer, branch: 'Feature/score' }, state)).toThrow('collision');
    expect(() => isLatest({ ...newer, repository: 'other/kbo-knit' }, state)).toThrow('collision');
    expect(isLatest(request, { ...state, request: newer })).toBe(false);
    expect(isLatest(request, null)).toBe(true);
  });

  it('uses conditional writes for both first creation and updates to prevent lost state', async () => {
    const client = new S3Client({ region: 'ap-northeast-2' });
    const send = vi.spyOn(client, 'send').mockImplementation(async () => ({ ETag: 'next-etag' }));
    await writeState(client, 'preview-bucket', state, null);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Key: '_control/feature-score.json', IfNoneMatch: '*', CacheControl: 'no-store',
    });
    await writeState(client, 'preview-bucket', state, { value: state, etag: 'previous-etag' });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ IfMatch: 'previous-etag' });
    send.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'PreconditionFailed' }));
    await expect(writeState(client, 'preview-bucket', state, null)).rejects.toThrow('conflict');
    client.destroy();
  });

  it('treats only an absent key as empty state, not permission failures', async () => {
    const client = new S3Client({ region: 'ap-northeast-2' });
    const send = vi.spyOn(client, 'send');
    send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(readState(client, 'preview-bucket', request.branchId)).resolves.toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(readState(client, 'preview-bucket', request.branchId)).rejects.toThrow('denied');
    client.destroy();
  });
});
