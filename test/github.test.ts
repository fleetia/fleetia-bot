import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOrder, type Request } from '../src/commands';
import { report, resolveRequest, verifyRequest, verifyWorkflowSource } from '../src/github';

const sha = 'b'.repeat(40);
const request: Request = {
  action: 'deploy', repository: 'fleetia/kbo-knit', pr: 42, branch: 'feature-score', branchId: 'feature-score',
  sha, runId: 100, order: requestOrder('2026-09-09T08:00:00Z', 123),
  commentId: 123, commandBody: '@fleetia-bot deploy',
};
const pr = {
  number: 42, state: 'open', closed_at: null,
  head: { ref: 'feature-score', sha, repo: { full_name: 'fleetia/kbo-knit' } },
};
const comment = {
  id: 123, body: '@fleetia-bot deploy', created_at: '2026-09-09T08:00:00Z',
  user: { id: 46233501, login: 'tracy-cho' },
  issue_url: 'https://api.github.com/repos/fleetia/kbo-knit/issues/42',
};
const event = {
  action: 'created', repository: { full_name: 'fleetia/kbo-knit' },
  issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/fleetia/kbo-knit/pulls/42' } },
  comment,
};

const fetchMock = vi.fn<typeof fetch>();

function respond(value: unknown): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitHub preview request trust', () => {
  it('resolves the PR head through the API instead of deploying the issue_comment default-branch SHA', async () => {
    respond(pr);
    expect(await resolveRequest(event, 'issue_comment', 100)).toEqual(request);
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/fleetia/kbo-knit/pulls/42', expect.objectContaining({ method: 'GET' }));
  });

  it('ignores edited, unauthorized, ordinary issue, and non-command comments without fetching code', async () => {
    for (const payload of [
      { ...event, action: 'edited' },
      { ...event, comment: { ...comment, user: { id: 999 } } },
      { ...event, issue: { number: 42 } },
      { ...event, comment: { ...comment, body: '@fleetia-bot deploy extra' } },
      { ...event, repository: { full_name: 'other/kbo-knit' } },
    ]) {
      expect(await resolveRequest(payload, 'issue_comment', 100)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects fork heads and already closed PR deployment requests', async () => {
    respond({ ...pr, head: { ...pr.head, repo: { full_name: 'outsider/kbo-knit' } } });
    expect(await resolveRequest(event, 'issue_comment', 100)).toBeNull();
    respond({ ...pr, state: 'closed', closed_at: '2026-09-09T08:00:01Z' });
    expect(await resolveRequest(event, 'issue_comment', 100)).toBeNull();
  });

  it('converts a close event to an ordered deletion without treating its actor as an owner command', async () => {
    const closed = { ...pr, state: 'closed', closed_at: '2026-09-09T08:00:00Z' };
    const result = await resolveRequest({ ...event, action: 'closed', pull_request: closed }, 'pull_request_target', 101);
    expect(result).toMatchObject({ action: 'delete', sha, branchId: 'feature-score', runId: 101 });
    expect(result !== null && result.order > request.order).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks the unchanged owner command and exact head SHA before privileged work', async () => {
    respond(comment);
    respond(pr);
    await expect(verifyRequest(request)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...comment, body: '@fleetia-bot deploy delete' },
    { ...comment, user: { id: 999 } },
    { ...comment, issue_url: 'https://api.github.com/repos/fleetia/kbo-knit/issues/43' },
  ])('rejects a command whose live body, author or PR changed', async (changed) => {
    respond(changed);
    await expect(verifyRequest(request)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } },
    { ...pr, head: { ...pr.head, ref: 'other' } },
    { ...pr, head: { ...pr.head, repo: { full_name: 'other/kbo-knit' } } },
    { ...pr, state: 'closed', closed_at: '2026-09-09T08:00:01Z' },
  ])('rejects a PR whose source, commit or open state changed', async (changed) => {
    respond(comment);
    respond(changed);
    await expect(verifyRequest(request)).rejects.toThrow();
  });

  it('requires the exact common-workflow commit reported by GitHub', async () => {
    const ref = 'd'.repeat(40);
    respond({ referenced_workflows: [{ path: `fleetia/fleetia-bot/.github/workflows/preview.yml@${ref}`, sha: ref }] });
    await expect(verifyWorkflowSource(ref, 100)).resolves.toBeUndefined();
    respond({ referenced_workflows: [{ path: `fleetia/fleetia-bot/.github/workflows/preview.yml@${ref}`, sha: 'e'.repeat(40) }] });
    await expect(verifyWorkflowSource(ref, 100)).rejects.toThrow('pinned reusable workflow');
    await expect(verifyWorkflowSource('main', 100)).rejects.toThrow('full commit SHA');
  });

  it('does not announce an old deployment after a newer delete comment is waiting', async () => {
    respond([{ ...comment, id: 124, created_at: '2026-09-09T08:00:01Z', body: '@fleetia-bot deploy delete' }]);
    await report(request, 'success', 'ready', sha);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updates the existing bot comment and preserves its request order during status', async () => {
    vi.stubEnv('BOT_TOKEN', 'app-comment-token');
    respond([{
      id: 700, user: { id: 800, login: 'fleetia-bot[bot]' },
      body: `<!-- fleetia-bot:preview -->\n<!-- request-order: ${request.order} -->`,
      updated_at: '2026-09-09T08:00:01Z',
    }]);
    respond({});
    await report({ ...request, action: 'status', order: requestOrder('2026-09-09T08:00:02Z', 125) }, 'success', 'ready', sha);
    const options = fetchMock.mock.calls[1]?.[1];
    expect(options?.method).toBe('PATCH');
    expect(options?.headers).toMatchObject({ authorization: 'Bearer app-comment-token' });
    expect(options?.body).toContain(`<!-- request-order: ${request.order} -->`);
  });
});
