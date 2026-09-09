import { describe, expect, it } from 'vitest';
import { branchId, parseCommand, parseRequest, requestOrder } from '../src/commands';

describe('preview commands and identity', () => {
  it('accepts only the three complete commands', () => {
    expect(parseCommand('  @fleetia-bot deploy\n')).toBe('deploy');
    expect(parseCommand('@fleetia-bot deploy delete')).toBe('delete');
    expect(parseCommand('@fleetia-bot status')).toBe('status');
    for (const body of ['please @fleetia-bot deploy', '@fleetia-bot deploy now', '@fleetia-bot deploy\nrm -rf /', '@fleetia-bot Deploy']) {
      expect(parseCommand(body)).toBeNull();
    }
  });

  it('preserves valid labels and differentiates branches which normalize to the same slug', () => {
    expect(branchId('fix-score')).toBe('fix-score');
    const slash = branchId('feature/score');
    const dash = branchId('feature-score');
    expect(slash).toMatch(/^feature-score-[a-f0-9]{12}$/);
    expect(slash).not.toBe(dash);
    expect(branchId('FEATURE/score')).not.toBe(slash);
    expect(branchId('feature/'.repeat(30))).toMatch(/^[a-z0-9-]{1,63}$/);
    expect(branchId('도안')).toMatch(/^branch-[a-f0-9]{12}$/);
    expect(() => branchId('feature bad')).toThrow();
  });

  it('orders by event timestamp, then closes before any same-second deploy can supersede them', () => {
    const timestamp = '2026-09-09T08:00:00Z';
    expect(requestOrder(timestamp, 12) > requestOrder(timestamp, 2)).toBe(true);
    expect(requestOrder(timestamp, 1, true) > requestOrder(timestamp, 999999)).toBe(true);
    expect(requestOrder('2026-09-09T08:00:01Z', 1) > requestOrder(timestamp, 999999, true)).toBe(true);
    expect(() => requestOrder('not a date', 1)).toThrow('timestamp');
  });

  it('rejects mismatched branch prefixes and malformed persisted request identity', () => {
    const request = {
      action: 'deploy', repository: 'fleetia/kbo-knit', pr: 10, branch: 'main', branchId: 'main',
      sha: 'a'.repeat(40), runId: 1, order: requestOrder('2026-09-09T08:00:00Z', 2),
    };
    expect(parseRequest(request)).toEqual(request);
    for (const changed of [{ branchId: 'other' }, { sha: 'main' }, { pr: 0 }, { runId: '1' }, { order: 'latest' }, { action: 'destroy' }]) {
      expect(() => parseRequest({ ...request, ...changed })).toThrow();
    }
  });
});
