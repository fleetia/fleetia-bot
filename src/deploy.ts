import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { cacheControl, contentType, inspectArtifact, type ArtifactFile } from './artifact';
import { checkInfrastructure, invalidate, s3Client, type Infrastructure } from './aws';
import type { Request } from './commands';
import { getPullRequest, github, hasOpenBranch, verifyRequest } from './github';
import { project } from './project';
import { checkOwnership, isLatest, readState, writeState, type BranchState, type StoredState } from './state';
import { record } from './validation';

export type DeploymentResult = { deploy: boolean; detail: string; deployedSha: string };

function result(detail: string, state: BranchState | null, deploy = false): DeploymentResult {
  return { deploy, detail, deployedSha: state?.deployedSha ?? '' };
}

function sameRequest(request: Request, state: StoredState | null): state is StoredState {
  checkOwnership(request, state?.value ?? null);
  return state !== null && state.value.request.order === request.order &&
    state.value.request.sha === request.sha && state.value.request.action === request.action;
}

async function currentState(client: S3Client, infrastructure: Infrastructure, request: Request): Promise<StoredState> {
  const state = await readState(client, infrastructure.bucket, request.branchId);
  if (!sameRequest(request, state)) {
    throw new Error('Deployment was superseded by another request');
  }
  return state;
}

async function recordFailure(client: S3Client, infrastructure: Infrastructure, request: Request, detail: string): Promise<void> {
  try {
    const state = await readState(client, infrastructure.bucket, request.branchId);
    if (sameRequest(request, state)) {
      await writeState(client, infrastructure.bucket, { ...state.value, phase: 'failed', detail }, state);
    }
  } catch {
    // Preserve the original failure when the state store is also unavailable.
  }
}

async function fetchPreview(request: Request, key: string, accept: string): Promise<Response> {
  return fetch(`https://${request.branchId}.${project.domain}/${key}`, {
    headers: { accept, 'cache-control': 'no-cache' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
}

async function removePrefix(client: S3Client, infrastructure: Infrastructure, request: Request): Promise<void> {
  const prefix = `${request.branchId}/`;
  const tokens = new Set<string>();
  let continuationToken: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const objects = await client.send(new ListObjectsV2Command({
      Bucket: infrastructure.bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: continuationToken,
    }), { abortSignal: AbortSignal.timeout(30_000) });
    const keys = (objects.Contents ?? []).map((object) => {
      if (!object.Key || !object.Key.startsWith(prefix)) {
        throw new Error('S3 listing escaped the requested branch prefix');
      }
      return { Key: object.Key };
    });
    for (let index = 0; index < keys.length; index += 1000) {
      await currentState(client, infrastructure, request);
      const deleted = await client.send(new DeleteObjectsCommand({
        Bucket: infrastructure.bucket, Delete: { Objects: keys.slice(index, index + 1000), Quiet: true },
      }), { abortSignal: AbortSignal.timeout(30_000) });
      if (deleted.Errors?.length) {
        throw new Error('S3 did not delete every requested preview object');
      }
    }
    if (!objects.IsTruncated) {
      return;
    }
    continuationToken = objects.NextContinuationToken;
    if (!continuationToken || tokens.has(continuationToken)) {
      throw new Error('S3 returned an invalid pagination cursor');
    }
    tokens.add(continuationToken);
  }
  throw new Error('Preview deletion exceeded its pagination limit');
}

export async function prepare(request: Request): Promise<DeploymentResult> {
  await verifyRequest(request);
  const infrastructure = await checkInfrastructure();
  const client = s3Client();
  const previous = await readState(client, infrastructure.bucket, request.branchId);
  checkOwnership(request, previous?.value ?? null);
  if (request.action === 'status') {
    if (!previous) {
      return result('No deployment has been requested for this branch.', null);
    }
    const pr = await getPullRequest(request.pr);
    if (pr.branch !== request.branch || pr.repository !== request.repository) {
      throw new Error('PR source changed');
    }
    const comparison = previous.value.deployedSha === null ? 'No verified deployment exists.'
      : previous.value.deployedSha === pr.sha ? 'The last verified deployment matches the current PR head.'
        : 'The current PR head differs from the last verified deployment.';
    let detail = `${previous.value.phase}: ${previous.value.detail} ${comparison} Current PR SHA: ${pr.sha}.`;
    if (['building', 'publishing', 'deleting'].includes(previous.value.phase)) {
      const run = record(await github(`/repos/${project.repository}/actions/runs/${previous.value.request.runId}`));
      const status = typeof run.status === 'string' ? run.status : 'unknown';
      const conclusion = typeof run.conclusion === 'string' ? ` (${run.conclusion})` : '';
      detail += ` Last deployment workflow: ${status}${conclusion}.`;
    }
    return result(detail, previous.value);
  }
  if (!isLatest(request, previous?.value ?? null)) {
    return result('Ignored: a newer branch request already exists.', previous?.value ?? null);
  }
  if (request.action === 'delete' && request.commentId === undefined && await hasOpenBranch(request.branch)) {
    return result('Kept the preview because this branch has an open PR.', previous?.value ?? null);
  }
  const state: BranchState = {
    request, phase: request.action === 'deploy' ? 'building' : 'deleting',
    deployedSha: previous?.value.deployedSha ?? null,
    detail: request.action === 'deploy' ? 'Building the requested commit.' : 'Deleting preview content and cached responses.',
  };
  await writeState(client, infrastructure.bucket, state, previous);
  if (request.action === 'deploy') {
    return result(state.detail, state, true);
  }
  try {
    await removePrefix(client, infrastructure, request);
    await invalidate(infrastructure, `delete-${request.branchId}-${request.runId}-${createHash('sha256').update(request.order).digest('hex').slice(0, 16)}`);
    const response = await fetchPreview(request, 'index.html', 'text/html');
    if (response.status !== 403 && response.status !== 404) {
      throw new Error('The preview index is still available after deletion');
    }
    await response.body?.cancel();
    const latest = await currentState(client, infrastructure, request);
    const deleted: BranchState = { ...state, phase: 'deleted', deployedSha: null, detail: 'Preview deleted; the public index is unavailable.' };
    await writeState(client, infrastructure.bucket, deleted, latest);
    return result(deleted.detail, deleted);
  } catch (error) {
    await recordFailure(client, infrastructure, request, 'Deletion failed; public content or cached responses may remain.');
    throw error;
  }
}

async function upload(client: S3Client, infrastructure: Infrastructure, request: Request, file: ArtifactFile): Promise<void> {
  const body = await readFile(file.path);
  if (body.byteLength !== file.size || createHash('sha256').update(body).digest('hex') !== file.sha256) {
    throw new Error('Artifact changed after inspection');
  }
  await client.send(new PutObjectCommand({
    Bucket: infrastructure.bucket, Key: `${request.branchId}/${file.key}`, Body: body,
    ContentType: contentType(file.key), CacheControl: cacheControl(file.key),
  }), { abortSignal: AbortSignal.timeout(30_000) });
}

async function verifyPublished(request: Request, files: ArtifactFile[]): Promise<void> {
  const response = await fetchPreview(request, '__fleetia.json', 'application/json');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The published deployment manifest is unavailable');
  }
  const manifest = record(await response.json());
  const proof = files.map(({ key, size, sha256 }) => ({ key, size, sha256 }));
  if (manifest.sha !== request.sha || manifest.branch !== request.branch || manifest.runId !== request.runId ||
      JSON.stringify(manifest.files) !== JSON.stringify(proof)) {
    throw new Error('The served manifest does not identify this deployment');
  }
  const index = files.find((file) => file.key === 'index.html');
  if (!index) {
    throw new Error('The artifact has no root index');
  }
  const assets = files.filter((file) => /\.(?:js|css)$/.test(file.key) && file.key !== 'sw.js').slice(0, 2);
  if (assets.length === 0) {
    throw new Error('The artifact has no JavaScript or CSS to verify');
  }
  for (const file of [index, ...assets]) {
    const served = await fetchPreview(request, file.key, file.key.endsWith('.html') ? 'text/html' : '*/*');
    if (!served.ok) {
      throw new Error('A published HTML or asset request failed');
    }
    const bytes = new Uint8Array(await served.arrayBuffer());
    if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error('Served HTML or asset content does not match this build');
    }
  }
}

export async function publish(request: Request, directory: string): Promise<DeploymentResult> {
  if (request.action !== 'deploy') {
    throw new Error('Only deploy requests can publish an artifact');
  }
  await verifyRequest(request);
  const infrastructure = await checkInfrastructure();
  const client = s3Client();
  const previous = await currentState(client, infrastructure, request);
  if (!['building', 'publishing', 'failed'].includes(previous.value.phase)) {
    throw new Error('This request is not awaiting publication; run a new deploy command');
  }
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('The artifact root must be a regular directory');
    }
    const files = await inspectArtifact(directory);
    await writeState(client, infrastructure.bucket, { ...previous.value, phase: 'publishing', detail: 'Uploading preview content; the public version may change.' }, previous);
    let checkedHtml = false;
    for (const file of files) {
      if (file.key.endsWith('.html') && !checkedHtml) {
        await verifyRequest(request);
        await currentState(client, infrastructure, request);
        checkedHtml = true;
      }
      await upload(client, infrastructure, request, file);
    }
    await verifyRequest(request);
    await currentState(client, infrastructure, request);
    const manifest = {
      sha: request.sha, branch: request.branch, runId: request.runId,
      files: files.map(({ key, size, sha256 }) => ({ key, size, sha256 })),
    };
    await client.send(new PutObjectCommand({
      Bucket: infrastructure.bucket, Key: `${request.branchId}/__fleetia.json`, Body: JSON.stringify(manifest),
      ContentType: 'application/json', CacheControl: 'no-cache',
    }), { abortSignal: AbortSignal.timeout(30_000) });
    await verifyPublished(request, files);
    await verifyRequest(request);
    const latest = await currentState(client, infrastructure, request);
    const ready: BranchState = { request, phase: 'ready', deployedSha: request.sha, detail: 'Preview deployed; served HTML, assets, and deployment SHA verified.' };
    await writeState(client, infrastructure.bucket, ready, latest);
    return result(ready.detail, ready);
  } catch (error) {
    await recordFailure(client, infrastructure, request, 'Publication failed; some public files may have changed and the served version is not verified.');
    throw error;
  }
}
