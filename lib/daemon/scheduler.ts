/**
 * Hydra Lite concurrency scheduler.
 *
 * Pure decision logic for the "Lean safety spine" milestone's concurrency
 * limits: at most `globalCap` tasks running across all registered projects,
 * and a single-writer/multiple-reader lock per project (at most one
 * concurrent edit; reads bounded by `perProjectReadCap`, default 1 — which
 * is observably identical to "at most one task per project" per the plan
 * doc's v0.1.0 boundary, but raising `perProjectReadCap` later needs no
 * redesign, since reads never mutate the working tree (`-s read-only`) and
 * can never conflict with each other).
 *
 * This module does no I/O and holds no state — in-flight counts are derived
 * fresh from each project's persisted task list at decision time (see
 * `countInFlight`), so there is nothing to rebuild or desynchronize across a
 * daemon restart. Correctness against concurrent claim attempts within one
 * daemon process is the caller's responsibility: the whole
 * read-counts -> decide -> commit sequence must be serialized through a
 * single async chain (see orchestrator-daemon.ts's `claimQueue`), because
 * two decisions racing ahead of each other's commits is the only way this
 * pure check could be defeated.
 */

export type TaskEffect = 'read' | 'edit';

export interface ConcurrencyLimits {
  /** Max tasks `in_progress` across every registered project at once. */
  globalCap: number;
  /** Max concurrent read-effect tasks `in_progress` within one project. */
  perProjectReadCap: number;
}

export const DEFAULT_LIMITS: ConcurrencyLimits = {
  globalCap: 2,
  perProjectReadCap: 1,
};

export interface ProjectInFlight {
  /** Count of in-progress read-effect tasks. */
  reading: number;
  /** Whether an edit-effect task is currently in progress. */
  writing: boolean;
}

/** A task shape minimally sufficient to compute in-flight counts. */
export interface InFlightTaskLike {
  status: string;
  effect?: TaskEffect;
}

/** Count in-flight read/write load from one project's task list. */
export function countInFlight(tasks: readonly InFlightTaskLike[]): ProjectInFlight {
  let reading = 0;
  let writing = false;
  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;
    if (task.effect === 'edit') {
      writing = true;
    } else {
      reading += 1;
    }
  }
  return { reading, writing };
}

function sumGlobalInFlight(perProject: Readonly<Record<string, ProjectInFlight>>): number {
  let total = 0;
  for (const load of Object.values(perProject)) {
    total += load.reading + (load.writing ? 1 : 0);
  }
  return total;
}

/**
 * Decide whether a task with the given effect may start in `projectId`,
 * given the current in-flight snapshot across every registered project.
 * Pure — callers hold the actual concurrency-safety responsibility (see
 * module docstring).
 */
export function canClaim(
  perProject: Readonly<Record<string, ProjectInFlight>>,
  projectId: string,
  effect: TaskEffect,
  limits: ConcurrencyLimits = DEFAULT_LIMITS,
): boolean {
  const projectLoad = perProject[projectId] ?? { reading: 0, writing: false };

  if (effect === 'edit') {
    if (projectLoad.writing || projectLoad.reading > 0) return false;
  } else {
    if (projectLoad.writing) return false;
    if (projectLoad.reading >= limits.perProjectReadCap) return false;
  }

  if (sumGlobalInFlight(perProject) >= limits.globalCap) return false;
  return true;
}
