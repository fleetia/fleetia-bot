import { createHash } from 'node:crypto';
import { integer, record, string } from './validation';

export type Command = 'deploy' | 'delete' | 'status';
export type Request = {
  action: Command;
  repository: string;
  pr: number;
  branch: string;
  branchId: string;
  sha: string;
  order: string;
  commentId?: number;
  commandBody?: string;
  runId: number;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA = /^[a-f0-9]{40}$/;

export function parseCommand(body: string): Command | null {
  switch (body.trim()) {
    case '@fleetia-bot deploy': return 'deploy';
    case '@fleetia-bot deploy delete': return 'delete';
    case '@fleetia-bot status': return 'status';
    default: return null;
  }
}

export function branchId(branch: string): string {
  if (branch.length === 0 || /[\x00-\x20\x7f]/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  if (LABEL.test(branch)) {
    return branch;
  }
  const slug = branch.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '') || 'branch';
  return `${slug}-${createHash('sha256').update(branch).digest('hex').slice(0, 12)}`;
}

export function requestOrder(date: string, id: number, isClose = false): string {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) {
    throw new Error('Invalid request timestamp');
  }
  return `${String(time).padStart(15, '0')}:${isClose ? '1' : '0'}:${String(id).padStart(20, '0')}`;
}

export function parseRequest(value: unknown): Request {
  const input = record(value);
  const action = string(input.action);
  if (action !== 'deploy' && action !== 'delete' && action !== 'status') {
    throw new Error('Invalid action');
  }
  const branch = string(input.branch);
  const id = string(input.branchId);
  const sha = string(input.sha);
  const order = string(input.order);
  if (id !== branchId(branch) || !SHA.test(sha) || !/^\d{15}:[01]:\d{20}$/.test(order)) {
    throw new Error('Invalid request identity');
  }
  return {
    action, repository: string(input.repository), pr: integer(input.pr), branch,
    branchId: id, sha, order, runId: integer(input.runId),
    ...(input.commentId === undefined ? {} : {
      commentId: integer(input.commentId), commandBody: string(input.commandBody),
    }),
  };
}
