import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli';
import { requestOrder, type Request } from '../src/commands';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), verifySource: vi.fn(), prepare: vi.fn(), publish: vi.fn(), report: vi.fn(),
}));
vi.mock('../src/github', () => ({ resolveRequest: mocks.resolve, verifyWorkflowSource: mocks.verifySource, report: mocks.report }));
vi.mock('../src/deploy', () => ({ prepare: mocks.prepare, publish: mocks.publish }));
const request: Request = {
  action: 'deploy', repository: 'fleetia/kbo-knit', pr: 1, branch: 'feature', branchId: 'feature', sha: 'a'.repeat(40),
  runId: 12, order: requestOrder('2026-09-09T08:00:00Z', 1), commentId: 1, commandBody: '@fleetia-bot deploy',
};
let directory: string;
let output: string;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'fleetia-cli-test-'));
  output = join(directory, 'output');
  await writeFile(join(directory, 'event.json'), JSON.stringify({ repository: { full_name: request.repository } }));
  vi.stubEnv('GITHUB_OUTPUT', output);
  vi.stubEnv('GITHUB_RUN_ID', '12');
  vi.stubEnv('GITHUB_EVENT_NAME', 'issue_comment');
  vi.stubEnv('GITHUB_EVENT_PATH', join(directory, 'event.json'));
  vi.stubEnv('BOT_REF', 'b'.repeat(40));
  vi.stubEnv('REQUEST', JSON.stringify(request));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function value(body: string, name: string): string | undefined {
  const pattern = new RegExp(`^${name}<<(fleetia_[^\\n]+)\\n([\\s\\S]*?)\\n\\1$`, 'gm');
  return [...body.matchAll(pattern)].at(-1)?.[2];
}

describe('workflow CLI contract', () => {
  it('verifies the pinned workflow before accepting the event and exports exact request identity', async () => {
    mocks.resolve.mockResolvedValue(request);
    await run('resolve');
    expect(mocks.verifySource).toHaveBeenCalledWith('b'.repeat(40), 12);
    expect(mocks.verifySource.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0] ?? 0);
    const body = await readFile(output, 'utf8');
    expect(value(body, 'accepted')).toBe('true');
    expect(value(body, 'request')).toBe(JSON.stringify(request));
    expect(value(body, 'sha')).toBe(request.sha);
    expect(value(body, 'branch_id')).toBe(request.branchId);
  });
  it('leaves requests unaccepted when workflow provenance fails', async () => {
    mocks.verifySource.mockRejectedValue(new Error('wrong workflow SHA'));
    await expect(run('resolve')).rejects.toThrow('wrong workflow');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(value(await readFile(output, 'utf8'), 'accepted')).toBe('false');
  });
  it('keeps status/deletion from enabling the build and safely preserves multiline details', async () => {
    mocks.prepare.mockResolvedValue({ deploy: false, detail: 'deleted\nnot a workflow output', deployedSha: '' });
    await run('prepare');
    const body = await readFile(output, 'utf8');
    expect(value(body, 'deploy')).toBe('false');
    expect(value(body, 'detail')).toBe('deleted\nnot a workflow output');
  });
  it('passes only the parsed request and configured artifact directory to publication', async () => {
    vi.stubEnv('ARTIFACT_DIR', directory);
    mocks.publish.mockResolvedValue({ deploy: false, detail: 'Verified', deployedSha: request.sha });
    await run('publish');
    expect(mocks.publish).toHaveBeenCalledWith(request, directory);
    expect(value(await readFile(output, 'utf8'), 'deployed_sha')).toBe(request.sha);
  });
  it('passes workflow result details to the trusted comment helper', async () => {
    vi.stubEnv('REPORT_STATUS', 'failure');
    vi.stubEnv('REPORT_DETAIL', 'Build failed');
    vi.stubEnv('REPORT_DEPLOYED_SHA', '');
    await run('report');
    expect(mocks.report).toHaveBeenCalledWith(request, 'failure', 'Build failed', '');
  });
  it('rejects malformed request identity before invoking deployment', async () => {
    vi.stubEnv('REQUEST', JSON.stringify({ ...request, branchId: 'other' }));
    await expect(run('prepare')).rejects.toThrow('identity');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
