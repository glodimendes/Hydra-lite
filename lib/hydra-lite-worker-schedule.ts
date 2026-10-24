/**
 * Hydra Lite worker scheduling: weighted round-robin project selection.
 *
 * Pure decision logic, no I/O, no module-level state — mirrors
 * lib/daemon/scheduler.ts's style. The caller (lib/hydra-lite-worker.ts)
 * owns a `CreditMap` across one run's picks and re-derives each project's
 * runnable-task list fresh before every call, since claiming/committing a
 * task changes what's runnable next.
 *
 * Why weighted round-robin and not a strict priority sort: a strict sort by
 * (projectPriority, taskPriority) would let one high-priority project's
 * backlog fully starve every other registered project for the whole run.
 * Weighted round-robin instead gives each project a share of attention
 * proportional to its weight — a priority-4 project (weight 5) gets picked
 * roughly 5x as often as a priority-0 project (weight 1) in a run with both
 * eligible, but the weight-1 project still gets picked. No project can be
 * locked out purely by weight; a project only drops out of the rotation
 * once it has no runnable tasks left.
 */

export interface SchedulableTask {
  id: string;
  /** Default 0 when unset. Only breaks ties within this task's own
   * project — never compared against another project's tasks directly. */
  priority?: number;
  /** ISO timestamp used as the final tiebreak (oldest first) when two
   * tasks in the same project have equal priority. */
  approvedAt: string;
}

export interface SchedulableProject {
  projectId: string;
  /** Default 0 when unset. See weightFromPriority for how this becomes a
   * rotation weight. */
  priority?: number;
  /** This project's currently runnable tasks. An empty array means the
   * project is not eligible for this pick. */
  tasks: readonly SchedulableTask[];
}

export interface ScheduledPick {
  projectId: string;
  taskId: string;
}

/** Per-run accumulator for pickNext's weighted round-robin state, keyed by
 * projectId. Owned by the caller; pass the same instance across picks
 * within one worker run. */
export type CreditMap = Map<string, number>;

export function createCreditMap(): CreditMap {
  return new Map();
}

/**
 * Convert a project's advisory priority into a rotation weight. Priority 0
 * (or unset) is the baseline weight of 1; each +1 priority adds one more
 * share. Floors at 1 so a negative priority still gets picked eventually —
 * it's deprioritized, never starved.
 */
export function weightFromPriority(priority?: number): number {
  return Math.max(1, Math.trunc(priority ?? 0) + 1);
}

/** Pick this project's own next task: highest `priority` first, oldest
 * `approvedAt` breaks a tie. Throws if `tasks` is empty — callers only
 * invoke this on a project already filtered to have runnable tasks. */
function pickNextTask(tasks: readonly SchedulableTask[]): SchedulableTask {
  let best = tasks[0];
  for (const task of tasks.slice(1)) {
    const bestPriority = best.priority ?? 0;
    const taskPriority = task.priority ?? 0;
    if (taskPriority > bestPriority) {
      best = task;
    } else if (taskPriority === bestPriority && task.approvedAt < best.approvedAt) {
      best = task;
    }
  }
  return best;
}

/**
 * Pick the next project+task to run, given the currently-eligible projects
 * (fresh each call — see module docstring) and the run's accumulated
 * credit. Mutates `credits` in place: every eligible project's weight is
 * added to its credit, then the winner's credit resets to 0 (classic
 * weighted round-robin). Ties go to whichever eligible project appears
 * earlier in `projects` — deterministic, not random, so a run is
 * reproducible given the same input order (which the worker derives from
 * the registry's own stable listing order).
 *
 * Returns null when no project has a runnable task.
 */
export function pickNext(
  projects: readonly SchedulableProject[],
  credits: CreditMap,
): ScheduledPick | null {
  const eligible = projects.filter((p) => p.tasks.length > 0);
  if (eligible.length === 0) return null;

  for (const project of eligible) {
    const weight = weightFromPriority(project.priority);
    credits.set(project.projectId, (credits.get(project.projectId) ?? 0) + weight);
  }

  let winner = eligible[0];
  let winnerCredit = credits.get(winner.projectId) ?? 0;
  for (const project of eligible.slice(1)) {
    const credit = credits.get(project.projectId) ?? 0;
    if (credit > winnerCredit) {
      winner = project;
      winnerCredit = credit;
    }
  }
  credits.set(winner.projectId, 0);

  const task = pickNextTask(winner.tasks);
  return { projectId: winner.projectId, taskId: task.id };
}
