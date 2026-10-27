/**
 * Hydra Lite autonomous worker — claims and runs approved edit tasks across
 * every registered project with nobody watching each execution.
 *
 * This is the highest-risk piece of Hydra Lite for macOS (see
 * docs/plan/hydra-lite-macos-plan.md's follow-on items): unlike the chat
 * console's `/run`, a human does not confirm each individual execution.
 * Everything below exists to bound that risk:
 *
 * - Run-once: processes whatever's currently claimable, then exits. No
 *   polling loop (deliberately deferred — see the design discussion this
 *   was built from); re-invoke it (by hand, cron, or launchd) to pick up
 *   newly approved work.
 * - Three independent caps: `--max-tasks` (default 10), `--max-runtime-
 *   minutes` (default 60, checked between tasks — never aborts one
 *   mid-flight) and a per-attempt Codex timeout (default 30 min, enforced
 *   inside lib/hydra-lite-run-edit.ts/hydra-lite-codex-session.ts, with a
 *   per-project override via .hydra/config.json).
 * - SIGINT/SIGTERM stop the run after the in-flight task finishes — never
 *   mid-commit.
 * - It never routes around the existing concurrency gate
 *   (lib/daemon/scheduler.ts, enforced server-side at claim time): a claim
 *   the gate rejects is just skipped, same as a human hitting it would be.
 * - It claims as 'codex' (the daemon's claim path only accepts the
 *   product's physical agents) but tags the claim's notes with
 *   `[hydra-lite-worker]`, so task history still shows which runs were
 *   unattended.
 * - Task selection is weighted round-robin across registered projects
 *   (lib/hydra-lite-worker-schedule.ts) by each project's advisory
 *   `priority` (default 0, set via `/project priority` or
 *   `project priority`), with each task's own `priority` (default 0, set
 *   via `/priority`) breaking ties within its project. This gives a more
 *   important project proportionally more of the worker's attention
 *   without ever fully locking out a less important one.
 *
 * Usage:
 *   npm run worker
 *   npm run worker -- --max-tasks=5 --max-runtime-minutes=30
 *   npm run worker -- --project=my-app,other-app
 */

import { request, parseList } from './hydra-utils.ts';
import {
  listProjects,
  resolveProjectByNameOrId,
  type RegisteredProject,
} from './hydra-registry.ts';
import { isWorkingTreeCleanIgnoringHydraState } from './hydra-lite-git.ts';
import { resolveProjectTaskTimeoutMs } from './hydra-lite-project-config.ts';
import {
  loadRunnableTask,
  claimTask,
  runEditWithRetries,
  DEFAULT_MAX_ATTEMPTS,
} from './hydra-lite-run-edit.ts';
import {
  pickNext,
  createCreditMap,
  type SchedulableProject,
  type SchedulableTask,
} from './hydra-lite-worker-schedule.ts';
import type { HydraStateShape } from './types.ts';

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';
export const DEFAULT_MAX_TASKS = 10;
export const DEFAULT_MAX_RUNTIME_MINUTES = 60;
/** Claims as 'codex' (the only agent name the daemon's claim path accepts
 * for a physical agent — see claimTask's docstring); this note is how task
 * history still shows the claim came from the unattended worker, not a
 * human-typed `/run`. */
const WORKER_CLAIM_NOTE = '[hydra-lite-worker] claimed by the unattended worker';

interface WorkerArgs {
  maxTasks: number;
  maxRuntimeMinutes: number;
  /** Project names/ids to restrict to; empty means "every registered
   * project". */
  projectFilter: string[];
  baseUrl: string;
}

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  let maxTasks = DEFAULT_MAX_TASKS;
  let maxRuntimeMinutes = DEFAULT_MAX_RUNTIME_MINUTES;
  let baseUrl = DEFAULT_URL;
  const projectFilter: string[] = [];
  for (const token of argv) {
    if (token.startsWith('--max-tasks=')) {
      const value = Number.parseInt(token.slice('--max-tasks='.length), 10);
      if (Number.isFinite(value) && value > 0) maxTasks = value;
    } else if (token.startsWith('--max-runtime-minutes=')) {
      const value = Number.parseInt(token.slice('--max-runtime-minutes='.length), 10);
      if (Number.isFinite(value) && value > 0) maxRuntimeMinutes = value;
    } else if (token.startsWith('--project=')) {
      projectFilter.push(...parseList(token.slice('--project='.length)));
    } else if (token.startsWith('url=')) {
      baseUrl = token.slice('url='.length);
    }
  }
  return { maxTasks, maxRuntimeMinutes, projectFilter, baseUrl };
}

/** Resolve the worker's target project list: every registered project, or
 * only those named by `--project` (name or id, comma-separated). Throws on
 * an unresolvable filter entry — an unattended run should fail loudly
 * rather than silently cover fewer projects than asked. */
function resolveTargetProjects(projectFilter: string[]): RegisteredProject[] {
  const all = listProjects();
  if (projectFilter.length === 0) return all;
  return projectFilter.map((nameOrId) => {
    const entry = resolveProjectByNameOrId(nameOrId);
    if (!entry) throw new Error(`No registered project named or id'd "${nameOrId}".`);
    return entry;
  });
}

/** Task ids are only unique *within* a project (two different projects can
 * both have a "T001") — every exclusion set in this file must be keyed by
 * this composite, never by the bare task id alone. */
function excludeKey(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`;
}

/** Fetch a project's currently-runnable (approved edit) tasks, minus any
 * already excluded this run (e.g. a claim that failed moments ago). */
async function fetchRunnableTasks(
  baseUrl: string,
  project: RegisteredProject,
  excludedKeys: ReadonlySet<string>,
): Promise<SchedulableTask[]> {
  const { state } = await request<{ state: HydraStateShape }>(
    'GET',
    baseUrl,
    `/state?projectId=${project.id}`,
  );
  return state.tasks
    .filter(
      (t) =>
        t.effect === 'edit' &&
        t.status === 'todo' &&
        // This milestone's unattended worker only runs Codex — a task
        // explicitly queued for claude/gemini (intendedAgent set to
        // something else) is left for a human's `/run` instead.
        (t.intendedAgent == null || t.intendedAgent === 'codex') &&
        !excludedKeys.has(excludeKey(project.id, t.id)),
    )
    .map((t) => ({
      id: t.id,
      priority: t.priority,
      approvedAt: t.approval?.approvedAt ?? t.updatedAt,
    }));
}

/** Build this iteration's eligible project list: fresh runnable tasks per
 * project, skipping (logging once) any project whose working tree isn't
 * clean right now — a human may be working in it. */
async function buildEligibleProjects(
  baseUrl: string,
  projects: readonly RegisteredProject[],
  excludedKeys: ReadonlySet<string>,
  warnedDirty: Set<string>,
): Promise<SchedulableProject[]> {
  const result: SchedulableProject[] = [];
  for (const project of projects) {
    if (!isWorkingTreeCleanIgnoringHydraState(project.path)) {
      if (!warnedDirty.has(project.id)) {
        console.log(
          `  [skip] ${project.name}: working tree has uncommitted changes — skipping for this run.`,
        );
        warnedDirty.add(project.id);
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential by design: each project's /state read is independent and cheap, and this runs once per pick, not per task
    const tasks = await fetchRunnableTasks(baseUrl, project, excludedKeys);
    result.push({ projectId: project.id, priority: project.priority, tasks });
  }
  return result;
}

interface RunSummary {
  done: number;
  blocked: number;
  claimSkipped: number;
}

/**
 * Process claimable work until `maxTasks`/`maxRuntimeMinutes` is hit, no
 * eligible project remains, or a stop signal arrives. Returns a summary for
 * the end-of-run report; every individual task's actual outcome lives in
 * its own task record (status, verification, attempts, commitSha, notes)
 * and git history, same as a human-run `/run` — this function adds no
 * separate log.
 */
export async function runWorker(args: WorkerArgs, shouldStop: () => boolean): Promise<RunSummary> {
  const projects = resolveTargetProjects(args.projectFilter);
  const summary: RunSummary = { done: 0, blocked: 0, claimSkipped: 0 };
  if (projects.length === 0) {
    console.log('  No registered projects to work on.');
    return summary;
  }

  const deadline = Date.now() + args.maxRuntimeMinutes * 60_000;
  const credits = createCreditMap();
  const excludedKeys = new Set<string>();
  const warnedDirty = new Set<string>();
  const byId = new Map(projects.map((p) => [p.id, p]));

  let tasksRun = 0;
  while (tasksRun < args.maxTasks) {
    if (shouldStop()) {
      console.log('  Stop requested — not starting another task.');
      break;
    }
    if (Date.now() >= deadline) {
      console.log(`  Max runtime (${String(args.maxRuntimeMinutes)}m) reached — stopping.`);
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: this run processes one task at a time, and each pick must see the just-updated runnable-task state
    const eligible = await buildEligibleProjects(args.baseUrl, projects, excludedKeys, warnedDirty);
    const pick = pickNext(eligible, credits);
    if (!pick) {
      console.log('  No more claimable edit tasks — done.');
      break;
    }
    const project = byId.get(pick.projectId);
    if (!project) continue; // unreachable: pick only returns a projectId we supplied
    const key = excludeKey(pick.projectId, pick.taskId);

    // eslint-disable-next-line no-await-in-loop -- see above
    const task = await loadRunnableTask(args.baseUrl, project, pick.taskId);
    if (!task) {
      excludedKeys.add(key);
      summary.claimSkipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- see above
    const claimed = await claimTask(args.baseUrl, project, pick.taskId, 'codex', WORKER_CLAIM_NOTE);
    if (!claimed) {
      // Most likely the concurrency gate (lib/daemon/scheduler.ts) rejected
      // it, or a human claimed it meanwhile — either way, skip and try the
      // next candidate rather than retrying the same one forever.
      excludedKeys.add(key);
      summary.claimSkipped += 1;
      continue;
    }

    console.log(`  [${project.name}] running ${pick.taskId}...`);
    const timeoutMs = resolveProjectTaskTimeoutMs(project.path);
    // eslint-disable-next-line no-await-in-loop -- see above
    const outcome = await runEditWithRetries(
      args.baseUrl,
      project,
      pick.taskId,
      task,
      'codex',
      DEFAULT_MAX_ATTEMPTS,
      timeoutMs,
    );
    if (outcome === 'done') summary.done += 1;
    else summary.blocked += 1;
    tasksRun += 1;
    excludedKeys.add(key);
  }

  return summary;
}

function printSummary(summary: RunSummary): void {
  console.log('');
  console.log(
    `  Run summary: ${String(summary.done)} done, ${String(summary.blocked)} blocked, ${String(summary.claimSkipped)} skipped.`,
  );
}

function main(): void {
  const args = parseWorkerArgs(process.argv.slice(2));
  console.log(
    `  Hydra Lite worker — max ${String(args.maxTasks)} tasks, max ${String(args.maxRuntimeMinutes)}m runtime${args.projectFilter.length > 0 ? `, projects: ${args.projectFilter.join(', ')}` : ''}`,
  );

  let stopRequested = false;
  const requestStop = (signal: string): void => {
    if (stopRequested) return; // second signal: let the process die normally
    stopRequested = true;
    console.log(`\n  Received ${signal} — finishing the current task, then stopping.`);
  };
  process.on('SIGINT', () => {
    requestStop('SIGINT');
  });
  process.on('SIGTERM', () => {
    requestStop('SIGTERM');
  });

  runWorker(args, () => stopRequested)
    .then((summary) => {
      printSummary(summary);
    })
    .catch((err: unknown) => {
      console.error(`  Worker failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

main();
