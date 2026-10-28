/**
 * Hydra Lite usage reporting: sums the `usage` field Hydra Lite stamps
 * onto completed/blocked edit tasks (lib/hydra-lite-run-edit.ts) into an
 * overall and per-agent total, and formats it for the chat console's
 * `/usage` command and background ticker (lib/hydra-lite-chat.ts). Pure
 * and I/O-free — the caller fetches the task list (GET /state) and passes
 * it in, so the same functions work for one project's tasks today and for
 * several projects' tasks pooled together, if that's ever wanted.
 */

import type { TaskEntry } from './types.ts';

export interface UsageTotals {
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface UsageSummary {
  overall: UsageTotals;
  byAgent: Record<string, UsageTotals>;
}

function emptyTotals(): UsageTotals {
  return {
    tasks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

function addInto(totals: UsageTotals, usage: NonNullable<TaskEntry['usage']>): void {
  totals.tasks += 1;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
  totals.costUsd += usage.costUsd ?? 0;
  totals.durationMs += usage.durationMs;
}

/**
 * Sum every task's `usage` field into an overall total and a per-agent
 * breakdown, keyed by each task's resolved agent (its own `intendedAgent`,
 * defaulting to 'codex' for legacy tasks — matches
 * hydra-lite-run-edit.ts's resolveTaskAgent). Tasks with no `usage` —
 * never run, or run before this field existed, or still in flight — are
 * silently skipped rather than counted as zero usage.
 */
export function summarizeUsage(tasks: readonly TaskEntry[]): UsageSummary {
  const overall = emptyTotals();
  const byAgent: Record<string, UsageTotals> = {};
  for (const task of tasks) {
    if (task.usage == null) continue;
    addInto(overall, task.usage);
    const agent = task.intendedAgent ?? 'codex';
    byAgent[agent] ??= emptyTotals();
    addInto(byAgent[agent], task.usage);
  }
  return { overall, byAgent };
}

function formatTotals(totals: UsageTotals): string {
  const parts = [
    `${String(totals.tasks)} task${totals.tasks === 1 ? '' : 's'}`,
    `${String(totals.inputTokens)} in`,
    `${String(totals.outputTokens)} out`,
  ];
  if (totals.cachedInputTokens > 0) parts.push(`${String(totals.cachedInputTokens)} cached`);
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  parts.push(`${(totals.durationMs / 1000).toFixed(1)}s`);
  return parts.join(', ');
}

/** One line overall plus one line per agent, for the /usage command and
 * the background ticker. Returns a "nothing recorded yet" line when no
 * task in the given list has ever finished an attempt. */
export function formatUsageSummary(summary: UsageSummary): string {
  if (summary.overall.tasks === 0) return '  No usage recorded yet for this project.';
  const lines = [`  Usage — overall: ${formatTotals(summary.overall)}`];
  for (const [agent, totals] of Object.entries(summary.byAgent)) {
    lines.push(`    ${agent}: ${formatTotals(totals)}`);
  }
  return lines.join('\n');
}
