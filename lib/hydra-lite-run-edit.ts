/**
 * Shared "execute an approved edit task" logic: claim, invoke Codex
 * (resuming with feedback on a failed verification), verify, and make
 * exactly one scoped commit on the attempt that verifies cleanly — or
 * block the task, tree left dirty for inspection, if every attempt fails.
 *
 * Extracted from lib/hydra-lite-chat.ts's original `/run` implementation so
 * both the chat console and the unattended worker (lib/hydra-lite-worker.ts)
 * call the exact same retry/commit/block logic instead of maintaining two
 * copies that could drift. The chat console still owns its own
 * `dispatchRunCommand` wiring (argument parsing, the "no current project"
 * check); this module owns everything from "load the task" onward.
 */

import { exec } from 'node:child_process';
import { ERROR, SUCCESS, DIM } from './hydra-ui.ts';
import { request } from './hydra-utils.ts';
import { runEdit } from './hydra-lite-codex-session.ts';
import {
  listChangedFiles,
  stageAndCommitFiles,
  isWorkingTreeCleanIgnoringHydraState,
} from './hydra-lite-git.ts';
import { resolveProjectVerificationPlan } from './hydra-lite-project-config.ts';
import type { RegisteredProject } from './hydra-registry.ts';
import type { HydraStateShape, TaskEntry } from './types.ts';

/** `/run <taskId>` (or the worker) with no explicit attempt count retries
 * this many times total (1 initial attempt + 1 retry) before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export function parseMaxAttempts(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

function runVerifyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  output: string;
}> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: error == null, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Load the task directly from the project's state (not the registry) —
 * execution needs the full record (effect, status, notes), not just an id. */
export async function loadTask(
  baseUrl: string,
  projectId: string,
  taskId: string,
): Promise<TaskEntry | undefined> {
  const { state: projectState } = await request<{ state: HydraStateShape }>(
    'GET',
    baseUrl,
    `/state?projectId=${projectId}`,
  );
  return projectState.tasks.find((t) => t.id === taskId);
}

export async function markBlocked(
  baseUrl: string,
  projectId: string,
  taskId: string,
  note: string,
  attempts: number,
  verification?: TaskEntry['verification'],
): Promise<void> {
  await request('POST', baseUrl, `/task/update?projectId=${projectId}`, {
    taskId,
    status: 'blocked',
    notes: note,
    verification,
    attempts,
    verify: false,
  });
}

/** Load + validate a task for execution. Prints its own error and returns
 * null when it isn't runnable; never throws. */
export async function loadRunnableTask(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
): Promise<TaskEntry | null> {
  const task = await loadTask(baseUrl, project.id, taskId);
  if (!task) {
    console.log(ERROR(`  No task ${taskId} in ${project.name}.`));
    return null;
  }
  if (task.effect !== 'edit') {
    console.log(ERROR(`  ${taskId} is not an edit task.`));
    return null;
  }
  if (task.status !== 'todo') {
    console.log(
      ERROR(`  ${taskId} is "${task.status}", not approved-and-ready. Approve it first.`),
    );
    return null;
  }
  if (!isWorkingTreeCleanIgnoringHydraState(project.path)) {
    console.log(
      ERROR(
        '  Working tree has uncommitted changes — refusing to risk attributing them to this task. Commit or stash first.',
      ),
    );
    return null;
  }
  return task;
}

/** Claim the task so no other claim can touch it while execution works,
 * including across retries. Always claims as 'codex' — the daemon's claim
 * path (lib/daemon/task-helpers.ts's ensureKnownAgent) only recognizes the
 * product's physical agents (human/gemini/codex/claude), confirmed live;
 * widening that allowlist for a synthetic worker identity would reach into
 * the excluded multi-agent agent model, which is out of scope here. `note`,
 * when given, is appended to the task's notes instead, so history still
 * shows whether a human (`/run`) or the unattended worker claimed it. */
export async function claimTask(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  note?: string,
): Promise<boolean> {
  try {
    await request('POST', baseUrl, `/task/claim?projectId=${project.id}`, {
      taskId,
      agent: 'codex',
      notes: note,
    });
    return true;
  } catch (err: unknown) {
    console.log(
      ERROR(`  Could not claim ${taskId}: ${err instanceof Error ? err.message : String(err)}`),
    );
    return false;
  }
}

export interface VerifyOutcome {
  verification: NonNullable<TaskEntry['verification']>;
  output: string;
}

/** Run the project's verify command (if any) and just report the outcome —
 * never touches the task itself. The retry loop decides whether a failure
 * means "block" or "retry with feedback". */
export async function runProjectVerification(project: RegisteredProject): Promise<VerifyOutcome> {
  const plan = resolveProjectVerificationPlan(project.path);
  if (!plan.enabled) {
    return { verification: { passed: true, checkedAt: new Date().toISOString() }, output: '' };
  }
  console.log(DIM(`  Verifying: ${plan.command}`));
  const result = await runVerifyCommand(plan.command, project.path, plan.timeoutMs);
  return {
    verification: {
      passed: result.ok,
      command: plan.command,
      checkedAt: new Date().toISOString(),
    },
    output: result.output,
  };
}

/** Stage only the changed files and make exactly one commit, then report
 * the result to the daemon. Blocks the task (keeping the verified
 * verification result) rather than discarding anything on commit failure. */
export async function commitEdit(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  task: TaskEntry,
  changedFiles: string[],
  verification: NonNullable<TaskEntry['verification']>,
  attempts: number,
): Promise<void> {
  const title = task.title === '' ? taskId : task.title;
  let sha: string;
  try {
    sha = stageAndCommitFiles(
      project.path,
      changedFiles,
      `Hydra Lite: ${title}\n\nTask-Id: ${taskId}`,
    ).sha;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markBlocked(
      baseUrl,
      project.id,
      taskId,
      `[Hydra Lite /run] Edit succeeded and verified, but committing failed: ${message}`,
      attempts,
      verification,
    );
    console.log(ERROR(`  Commit failed: ${message}`));
    console.log(
      DIM(
        `  ${taskId} set to blocked. Changes are verified but still uncommitted at ${project.path}.`,
      ),
    );
    return;
  }

  await request('POST', baseUrl, `/task/update?projectId=${project.id}`, {
    taskId,
    status: 'done',
    manifest: changedFiles,
    verification,
    commitSha: sha,
    attempts,
    verify: false,
  });
  const fileWord = changedFiles.length === 1 ? 'file' : 'files';
  console.log(
    SUCCESS(
      `  ${taskId} done. Committed ${sha.slice(0, 10)} (${String(changedFiles.length)} ${fileWord}).`,
    ),
  );
  for (const file of changedFiles) {
    console.log(DIM(`    ${file}`));
  }
}

/** The prompt for a retry: the original instructions plus what verification
 * said was wrong, so Codex fixes its own prior attempt instead of guessing
 * blind — sent to the SAME resumed thread, so it can see that attempt too. */
export function buildRetryPrompt(task: TaskEntry, failure: VerifyOutcome): string {
  const original = task.notes === '' ? task.title : task.notes;
  return [
    `Verification ("${failure.verification.command ?? ''}") failed after your last change:`,
    failure.output.slice(0, 1500),
    '',
    'Please fix the issue so verification passes. Original task:',
    original,
  ].join('\n');
}

export type AttemptOutcome =
  | { status: 'done' }
  | { status: 'blocked' }
  | { status: 'retry'; threadId: string; failure: VerifyOutcome };

/**
 * Run one Codex attempt (fresh, or resuming `threadId` with `lastFailure`
 * as feedback), then verify it. Reports and persists every outcome itself
 * — the caller's retry loop only has to act on the returned status.
 * `timeoutMs`, when given, bounds how long this one Codex invocation may
 * run (see hydra-lite-codex-session.ts's spawnAndCollect) — a timeout is
 * treated the same as any other Codex-invocation failure: block, don't
 * retry (there's no useful feedback from a process that never finished).
 */
export async function runOneEditAttempt(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  task: TaskEntry,
  attempt: number,
  maxAttempts: number,
  threadId: string | undefined,
  lastFailure: VerifyOutcome | null,
  timeoutMs?: number,
): Promise<AttemptOutcome> {
  console.log(DIM(`  Running ${taskId} (attempt ${String(attempt)}/${String(maxAttempts)})...`));
  const originalPrompt = task.notes === '' ? task.title : task.notes;
  const prompt = lastFailure == null ? originalPrompt : buildRetryPrompt(task, lastFailure);

  let nextThreadId: string;
  let summary: string;
  try {
    const result = await runEdit(project.path, prompt, threadId, timeoutMs);
    nextThreadId = result.threadId;
    summary = result.summary;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markBlocked(
      baseUrl,
      project.id,
      taskId,
      `[Hydra Lite /run] Codex invocation failed on attempt ${String(attempt)}: ${message}`,
      attempt,
    );
    console.log(ERROR(`  Codex invocation failed: ${message}`));
    console.log(DIM(`  ${taskId} set to blocked.`));
    return { status: 'blocked' };
  }
  console.log(`  ${summary}`);

  const changedFiles = listChangedFiles(project.path);
  if (changedFiles.length === 0) {
    await request('POST', baseUrl, `/task/update?projectId=${project.id}`, {
      taskId,
      status: 'done',
      manifest: [],
      verification: { passed: true, checkedAt: new Date().toISOString() },
      attempts: attempt,
      verify: false,
    });
    console.log(SUCCESS(`  Codex made no file changes. ${taskId} marked done.`));
    return { status: 'done' };
  }

  const outcome = await runProjectVerification(project);
  if (outcome.verification.passed) {
    console.log(SUCCESS('  Verification passed.'));
    await commitEdit(baseUrl, project, taskId, task, changedFiles, outcome.verification, attempt);
    return { status: 'done' };
  }

  console.log(
    ERROR(
      `  Verification failed (attempt ${String(attempt)}/${String(maxAttempts)}): ${outcome.verification.command ?? ''}`,
    ),
  );
  if (attempt < maxAttempts) {
    console.log(DIM('  Retrying with the failure as feedback...'));
    return { status: 'retry', threadId: nextThreadId, failure: outcome };
  }
  await markBlocked(
    baseUrl,
    project.id,
    taskId,
    `[Hydra Lite /run] Verification failed after ${String(attempt)} attempt(s) (${outcome.verification.command ?? ''}):\n${outcome.output.slice(0, 500)}`,
    attempt,
    outcome.verification,
  );
  console.log(
    DIM(
      `  ${taskId} set to blocked after ${String(attempt)} attempt(s). Working tree left as-is — inspect it at ${project.path}.`,
    ),
  );
  return { status: 'blocked' };
}

/**
 * Make up to `maxAttempts` Codex attempts via runOneEditAttempt, each
 * followed by verification. A retry resumes the SAME write-mode thread with
 * the verification failure as feedback — never a fresh session — and never
 * resumes across a privilege boundary, since every attempt here is already
 * write-mode. Stops at the first attempt that verifies cleanly. Assumes the
 * task has already been loaded (loadRunnableTask) and claimed (claimTask).
 */
export async function runEditWithRetries(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  task: TaskEntry,
  maxAttempts: number,
  timeoutMs?: number,
): Promise<'done' | 'blocked'> {
  let threadId: string | undefined;
  let lastFailure: VerifyOutcome | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: each retry must see the previous attempt's verification result before deciding whether to try again
    const outcome = await runOneEditAttempt(
      baseUrl,
      project,
      taskId,
      task,
      attempt,
      maxAttempts,
      threadId,
      lastFailure,
      timeoutMs,
    );
    if (outcome.status !== 'retry') return outcome.status;
    threadId = outcome.threadId;
    lastFailure = outcome.failure;
  }
  // Unreachable in practice (the loop above always returns on a non-retry
  // outcome, and runOneEditAttempt never returns 'retry' on the last
  // attempt) — satisfies the type checker's control-flow analysis.
  return 'blocked';
}
