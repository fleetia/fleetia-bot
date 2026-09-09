import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { parseRequest, type Request } from './commands';
import { record, string } from './validation';

export type BranchState = {
  request: Request;
  phase: 'building' | 'publishing' | 'ready' | 'deleting' | 'deleted' | 'failed';
  deployedSha: string | null;
  detail: string;
};
export type StoredState = { value: BranchState; etag: string };

export function checkOwnership(request: Request, previous: BranchState | null): void {
  if (previous && (previous.request.branch !== request.branch || previous.request.repository !== request.repository)) {
    throw new Error('Branch URL collision: this prefix belongs to another source branch');
  }
}

export function isLatest(request: Request, previous: BranchState | null): boolean {
  checkOwnership(request, previous);
  return previous === null || previous.request.order <= request.order;
}

export function parseState(value: unknown): BranchState {
  const input = record(value);
  const phase = string(input.phase);
  if (!['building', 'publishing', 'ready', 'deleting', 'deleted', 'failed'].includes(phase)) {
    throw new Error('Invalid stored deployment phase');
  }
  const sha = input.deployedSha === null ? null : string(input.deployedSha);
  if (sha !== null && !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid stored deployment SHA');
  }
  return {
    request: parseRequest(input.request), phase: phase as BranchState['phase'],
    deployedSha: sha, detail: string(input.detail),
  };
}

export async function readState(client: S3Client, bucket: string, branch: string): Promise<StoredState | null> {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `_control/${branch}.json` }));
    if (!object.Body) {
      throw new Error('Empty branch state');
    }
    const value: unknown = JSON.parse(await object.Body.transformToString());
    return { value: parseState(value), etag: string(object.ETag) };
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

export async function writeState(client: S3Client, bucket: string, value: BranchState, previous: StoredState | null): Promise<StoredState> {
  checkOwnership(value.request, previous?.value ?? null);
  const result = await client.send(new PutObjectCommand({
    Bucket: bucket, Key: `_control/${value.request.branchId}.json`,
    Body: JSON.stringify(value), ContentType: 'application/json', CacheControl: 'no-store',
    ...(previous ? { IfMatch: previous.etag } : { IfNoneMatch: '*' }),
  }));
  return { value, etag: string(result.ETag) };
}
