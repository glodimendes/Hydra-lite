/**
 * Tests for lib/hydra-lite-usage.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, formatUsageSummary } from '../lib/hydra-lite-usage.ts';
import type { TaskEntry } from '../lib/types.ts';

function task(overrides: Partial<TaskEntry>): TaskEntry {
  return {
    id: 'T001',
    title: 'test task',
    owner: 'codex',
    status: 'done',
    type: 'testing',
    files: [],
    notes: '',
    blockedBy: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeUsage', () => {
  it('returns all-zero totals for an empty task list', () => {
    const summary = summarizeUsage([]);
    assert.equal(summary.overall.tasks, 0);
    assert.deepEqual(summary.byAgent, {});
  });

  it('skips tasks with no usage field', () => {
    const summary = summarizeUsage([task({ id: 'T001' }), task({ id: 'T002' })]);
    assert.equal(summary.overall.tasks, 0);
  });

  it('sums a single task into the overall total', () => {
    const summary = summarizeUsage([
      task({
        intendedAgent: 'codex',
        usage: { inputTokens: 100, outputTokens: 20, durationMs: 5000 },
      }),
    ]);
    assert.equal(summary.overall.tasks, 1);
    assert.equal(summary.overall.inputTokens, 100);
    assert.equal(summary.overall.outputTokens, 20);
    assert.equal(summary.overall.durationMs, 5000);
  });

  it('breaks totals down per agent, defaulting unset intendedAgent to codex', () => {
    const summary = summarizeUsage([
      task({
        id: 'T001',
        intendedAgent: 'claude',
        usage: { inputTokens: 10, outputTokens: 1, durationMs: 100, costUsd: 0.01 },
      }),
      task({
        id: 'T002',
        usage: { inputTokens: 20, outputTokens: 2, durationMs: 200 },
      }),
      task({
        id: 'T003',
        intendedAgent: 'claude',
        usage: { inputTokens: 5, outputTokens: 1, durationMs: 50, costUsd: 0.02 },
      }),
    ]);
    assert.equal(summary.overall.tasks, 3);
    assert.equal(summary.overall.costUsd, 0.03);
    assert.equal(summary.byAgent['claude']?.tasks, 2);
    assert.equal(summary.byAgent['claude']?.inputTokens, 15);
    assert.equal(summary.byAgent['codex']?.tasks, 1);
    assert.equal(summary.byAgent['codex']?.inputTokens, 20);
  });

  it('sums cachedInputTokens only when present', () => {
    const summary = summarizeUsage([
      task({ usage: { inputTokens: 1, outputTokens: 1, durationMs: 1, cachedInputTokens: 50 } }),
    ]);
    assert.equal(summary.overall.cachedInputTokens, 50);
  });
});

describe('formatUsageSummary', () => {
  it('reports nothing recorded yet for an empty summary', () => {
    const line = formatUsageSummary(summarizeUsage([]));
    assert.match(line, /No usage recorded yet/);
  });

  it('formats an overall line and one line per agent', () => {
    const summary = summarizeUsage([
      task({
        intendedAgent: 'codex',
        usage: { inputTokens: 10, outputTokens: 5, durationMs: 1000 },
      }),
      task({
        id: 'T002',
        intendedAgent: 'claude',
        usage: { inputTokens: 20, outputTokens: 2, durationMs: 2000, costUsd: 0.05 },
      }),
    ]);
    const text = formatUsageSummary(summary);
    assert.match(text, /overall: 2 tasks/);
    assert.match(text, /codex: 1 task,/);
    assert.match(text, /claude: 1 task,/);
    assert.match(text, /\$0\.0500/);
  });

  it('omits the cached/cost parts when zero', () => {
    const summary = summarizeUsage([
      task({ usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 } }),
    ]);
    const text = formatUsageSummary(summary);
    assert.ok(!text.includes('cached'));
    assert.ok(!text.includes('$'));
  });
});
