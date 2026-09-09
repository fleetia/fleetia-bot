import { branchId, parseCommand, requestOrder, type Request } from './commands';
import { project } from './project';
import { integer, list, record, requiredEnvironment, string } from './validation';

export type PullRequest = {
  number: number;
  state: string;
  branch: string;
  sha: string;
  repository: string;
  closedAt: string | null;
};

export async function github(
  path: string,
  method = 'GET',
  body?: unknown,
  token = requiredEnvironment('GITHUB_TOKEN'),
): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28', 'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export function parsePullRequest(value: unknown): PullRequest {
  const pr = record(value);
  const head = record(pr.head);
  return {
    number: integer(pr.number), state: string(pr.state), branch: string(head.ref),
    sha: string(head.sha), repository: string(record(head.repo).full_name),
    closedAt: pr.closed_at === null ? null : string(pr.closed_at),
  };
}

export async function getPullRequest(number: number): Promise<PullRequest> {
  return parsePullRequest(await github(`/repos/${project.repository}/pulls/${number}`));
}

export async function hasOpenBranch(branch: string): Promise<boolean> {
  const owner = project.repository.split('/')[0];
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${branch}`, per_page: '100' });
  const prs = list(await github(`/repos/${project.repository}/pulls?${query}`));
  return prs.map(parsePullRequest).some((pr) => pr.repository === project.repository && pr.branch === branch);
}

export async function resolveRequest(event: unknown, eventName: string, runId: number): Promise<Request | null> {
  const payload = record(event);
  if (record(payload.repository).full_name !== project.repository) {
    return null;
  }
  if (eventName === 'issue_comment') {
    if (payload.action !== 'created') {
      return null;
    }
    const issue = record(payload.issue);
    if (!issue.pull_request) {
      return null;
    }
    const comment = record(payload.comment);
    if (record(comment.user).id !== project.ownerId) {
      return null;
    }
    const body = string(comment.body);
    const action = parseCommand(body);
    if (action === null) {
      return null;
    }
    const pr = await getPullRequest(integer(issue.number));
    if (pr.repository !== project.repository || (action === 'deploy' && pr.state !== 'open')) {
      return null;
    }
    return {
      action, repository: project.repository, pr: pr.number, branch: pr.branch,
      branchId: branchId(pr.branch), sha: pr.sha, runId,
      order: requestOrder(string(comment.created_at), integer(comment.id)),
      commentId: integer(comment.id), commandBody: body,
    };
  }
  if (eventName === 'pull_request_target' && payload.action === 'closed') {
    const pr = parsePullRequest(payload.pull_request);
    if (pr.repository !== project.repository || pr.closedAt === null) {
      return null;
    }
    return {
      action: 'delete', repository: project.repository, pr: pr.number, branch: pr.branch,
      branchId: branchId(pr.branch), sha: pr.sha, runId,
      order: requestOrder(pr.closedAt, pr.number, true),
    };
  }
  return null;
}

export async function verifyRequest(request: Request): Promise<void> {
  if (request.repository !== project.repository) {
    throw new Error('Unregistered repository');
  }
  if (request.commentId !== undefined) {
    const comment = record(await github(`/repos/${project.repository}/issues/comments/${request.commentId}`));
    if (record(comment.user).id !== project.ownerId || comment.body !== request.commandBody ||
        parseCommand(string(comment.body)) !== request.action) {
      throw new Error('The command comment was changed or is no longer authorized');
    }
    const suffix = `/issues/${request.pr}`;
    if (!string(comment.issue_url).endsWith(suffix)) {
      throw new Error('The command belongs to another PR');
    }
  }
  const pr = await getPullRequest(request.pr);
  if (pr.repository !== project.repository || pr.branch !== request.branch) {
    throw new Error('PR source changed');
  }
  if (request.action === 'deploy' && (pr.state !== 'open' || pr.sha !== request.sha)) {
    throw new Error('PR closed or its commit changed; request a new deployment');
  }
}

export async function verifyWorkflowSource(botRef: string, runId: number): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(botRef)) {
    throw new Error('bot-ref must be a full commit SHA');
  }
  const run = record(await github(`/repos/${project.repository}/actions/runs/${runId}`));
  const workflows = list(run.referenced_workflows);
  if (!workflows.some((entry) => {
    const workflow = record(entry);
    return workflow.sha === botRef && string(workflow.path).startsWith('fleetia/fleetia-bot/.github/workflows/preview.yml@');
  })) {
    throw new Error('bot-ref does not match the pinned reusable workflow');
  }
}

export async function report(request: Request, status: string, detail: string, deployedSha: string): Promise<void> {
  const marker = '<!-- fleetia-bot:preview -->';
  const comments: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const entries = list(await github(`/repos/${project.repository}/issues/${request.pr}/comments?per_page=100&page=${page}`));
    comments.push(...entries.map(record));
    if (entries.length < 100) {
      break;
    }
    if (page === 20) {
      throw new Error('Too many PR comments to safely select a status comment');
    }
  }
  const superseded = comments.some((comment) => {
    if (record(comment.user).id !== project.ownerId || typeof comment.body !== 'string') {
      return false;
    }
    const action = parseCommand(comment.body);
    return (action === 'deploy' || action === 'delete') &&
      requestOrder(string(comment.created_at), integer(comment.id)) > request.order;
  });
  if (superseded) {
    return;
  }
  const existing = comments.find((comment) => record(comment.user).login === 'fleetia-bot[bot]' &&
    typeof comment.body === 'string' && comment.body.startsWith(marker));
  const previousOrder = typeof existing?.body === 'string'
    ? /<!-- request-order: ([\d:]+) -->/.exec(existing.body)?.[1] : undefined;
  if (previousOrder && previousOrder > request.order) {
    return;
  }
  if (request.action === 'status' && existing &&
      Date.parse(string(existing.updated_at)) >= Number(request.order.split(':')[0])) {
    return;
  }
  const markerOrder = request.action === 'status'
    ? previousOrder ?? '000000000000000:0:00000000000000000000'
    : request.order;
  const escape = (text: string): string => text.replace(/[<>]/g, '').replace(/\r/g, '').slice(0, 1800);
  const body = [
    marker, `<!-- request-order: ${markerOrder} -->`, `### Fleetia preview · ${escape(status)}`,
    '', escape(detail), '', `- 브랜치: \`${escape(request.branch)}\``,
    `- 요청 SHA: \`${request.sha}\``,
    ...(deployedSha ? [`- 배포 SHA: \`${escape(deployedSha)}\``] : []),
    `- 프리뷰: https://${request.branchId}.${project.domain}`,
    `- 실행: https://github.com/${project.repository}/actions/runs/${request.runId}`,
    '', '로그인·동기화는 Iserlohn 테스트 API의 허용된 네트워크에서 확인할 수 있습니다.',
  ].join('\n');
  const token = requiredEnvironment('BOT_TOKEN');
  if (existing) {
    await github(`/repos/${project.repository}/issues/comments/${integer(existing.id)}`, 'PATCH', { body }, token);
  } else {
    await github(`/repos/${project.repository}/issues/${request.pr}/comments`, 'POST', { body }, token);
  }
}
