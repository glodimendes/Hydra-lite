/**
 * Shared "execute an approved edit task" logic: claim, invoke the task's
 * agent (resuming with feedback on a failed verification), verify, and make
 * exactly one scoped commit on the attempt that verifies cleanly — or
 * block the task, tree left dirty for inspection, if every attempt fails.
 *
 * Extracted from lib/hydra-lite-chat.ts's original `/run` implementation so
 * both the chat console and the unattended worker (lib/hydra-lite-worker.ts)
 * call the exact same retry/commit/block logic instead of maintaining two
 * copies that could drift. The chat console still owns its own
 * `dispatchRunCommand` wiring (argument parsing, the "no current project"
 * check); this module owns everything from "load the task" onward.
 *
 * Multi-CLI: which agent actually runs an attempt is the task's own
 * `intendedAgent` (resolveTaskAgent), set once at `/edit` time — never
 * whichever `/agent` the chat console currently has active. `runEditFor`
 * is the only place that picks a concrete session module by agent name.
 */

import { exec } from 'node:child_process';
import { DIM, getAgentIcon } from './hydra-ui.ts';
import { request } from './hydra-utils.ts';
import { runEdit as runCodexEdit } from './hydra-lite-codex-session.ts';
import { runEdit as runClaudeEdit } from './hydra-lite-claude-session.ts';
import {
  listChangedFiles,
  stageAndCommitFiles,
  isWorkingTreeCleanIgnoringHydraState,
} from './hydra-lite-git.ts';
import { resolveProjectVerificationPlan } from './hydra-lite-project-config.ts';
import type { RegisteredProject } from './hydra-registry.ts';
import type { HydraStateShape, TaskEntry, TaskUsage } from './types.ts';

/** The runtime agents `/run` (and the worker) can dispatch an edit attempt
 * to. Kept in sync with types.ts's `TaskEntry['intendedAgent']` and the
 * daemon's `KNOWN_INTENDED_AGENTS` (lib/daemon/write-routes.ts). */
export type HydraLiteAgent = 'codex' | 'claude' | 'gemini';

/** A single line of output. Every status/progress line in this module
 * goes through a `log` of this shape instead of a bare `console.log`, so
 * the chat console can redraw-safely interleave them with its own
 * readline prompt (see hydra-lite-chat.ts's printLine) while a run is in
 * flight; the worker (no readline involved) just defaults it to
 * `console.log`. */
export type LogFn = (line: string) => void;

/** A task queued before multi-CLI support (or a read task, which never
 * carries `intendedAgent`) always executes under Codex — the only agent
 * that existed when it was created. */
export function resolveTaskAgent(task: TaskEntry): HydraLiteAgent {
  return task.intendedAgent ?? 'codex';
}

/** The icon hydra-ui.ts gives 'system' — reused here to mark a line as
 * Hydra Lite's own narration ("I'm about to run this", "verification
 * passed", "committed"), never the agent's own words. Picked once,
 * module level, purely so hydraLine/agentLine read as a matched pair. */
const HYDRA_ICON = getAgentIcon('system');

/**
 * Prefix a line as Hydra Lite's own narration — claim/verify/commit/block
 * announcements, anything this module says about a run rather than what
 * the agent itself said or did. Always dark grey (hydra-ui.ts's DIM),
 * deliberately flat regardless of outcome — hydra's own voice is one
 * consistent, de-emphasized channel, never competing for attention with
 * the agent's own words (agentLine, below) or the chat console prompt's
 * per-agent color. Takes plain text; callers no longer pre-color it with
 * ERROR/SUCCESS/DIM themselves.
 */
export function hydraLine(text: string): string {
  return DIM(`  ${HYDRA_ICON} ${text}`);
}

/**
 * Prefix a line as the agent's own words — one live progress step (a
 * tool call, a message) or its final reply. Deliberately left in the
 * terminal's own default foreground rather than wrapped in a color:
 * plain ANSI black (which this used before) renders as invisible or
 * near-invisible on the dark-background theme most terminals default
 * to, where "black" text sits on a near-black background — picocolors
 * has no portable way to pick a shade that's readably dark on a light
 * theme and readably light on a dark one, so "no color" (inheriting
 * whatever the user's own theme already made legible) is the only
 * choice that works on both. Per-agent differentiation lives in the
 * chat console's prompt instead (hydra-lite-chat.ts's
 * PROMPT_AGENT_COLORS), not here — contrast with hydraLine above.
 */
export function agentLine(agent: HydraLiteAgent, text: string): string {
  return `    ${getAgentIcon(agent)} ${text}`;
}

/** Dispatch one edit attempt to the agent's own session module. Each
 * module mirrors hydra-lite-codex-session.ts's `runEdit(projectRoot,
 * prompt, existingThreadId?, timeoutMs?, onProgress?)` shape, so adding a
 * fourth agent here is a one-line addition, not a redesign. Gemini CLI
 * isn't installed on the development machine yet, so it's typed and
 * routed but not wired to a real session module — selecting it fails
 * loudly instead of silently falling back to a different CLI. */
function runEditFor(
  agent: HydraLiteAgent,
  projectRoot: string,
  prompt: string,
  existingThreadId: string | undefined,
  timeoutMs: number | undefined,
  onProgress: LogFn,
): ReturnType<typeof runCodexEdit> {
  if (agent === 'codex') {
    return runCodexEdit(projectRoot, prompt, existingThreadId, timeoutMs, onProgress);
  }
  if (agent === 'claude') {
    return runClaudeEdit(projectRoot, prompt, existingThreadId, timeoutMs, onProgress);
  }
  throw new Error(`Gemini CLI support is not implemented yet (agent "${agent}").`);
}

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
  usage?: TaskUsage,
): Promise<void> {
  await request('POST', baseUrl, `/task/update?projectId=${projectId}`, {
    taskId,
    status: 'blocked',
    notes: note,
    verification,
    attempts,
    usage,
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
    console.log(hydraLine(`No task ${taskId} in ${project.name}.`));
    return null;
  }
  if (task.effect !== 'edit') {
    console.log(hydraLine(`${taskId} is not an edit task.`));
    return null;
  }
  if (task.status !== 'todo') {
    console.log(
      hydraLine(`${taskId} is "${task.status}", not approved-and-ready. Approve it first.`),
    );
    return null;
  }
  if (!isWorkingTreeCleanIgnoringHydraState(project.path)) {
    console.log(
      hydraLine(
        'Working tree has uncommitted changes — refusing to risk attributing them to this task. Commit or stash first.',
      ),
    );
    return null;
  }
  return task;
}

/** Claim the task so no other claim can touch it while execution works,
 * including across retries. Claims as the task's own agent (its
 * `intendedAgent`, resolved by the caller — see resolveTaskAgent) — the
 * daemon's claim path (lib/daemon/task-helpers.ts's ensureKnownAgent) only
 * recognizes the product's physical agents (human/gemini/codex/claude),
 * confirmed live. `note`, when given, is appended to the task's notes
 * instead, so history still shows whether a human (`/run`) or the
 * unattended worker claimed it. */
export async function claimTask(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  agent: HydraLiteAgent,
  note?: string,
): Promise<boolean> {
  try {
    await request('POST', baseUrl, `/task/claim?projectId=${project.id}`, {
      taskId,
      agent,
      notes: note,
    });
    return true;
  } catch (err: unknown) {
    console.log(
      hydraLine(`Could not claim ${taskId}: ${err instanceof Error ? err.message : String(err)}`),
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
export async function runProjectVerification(
  project: RegisteredProject,
  log: LogFn,
): Promise<VerifyOutcome> {
  const plan = resolveProjectVerificationPlan(project.path);
  if (!plan.enabled) {
    return { verification: { passed: true, checkedAt: new Date().toISOString() }, output: '' };
  }
  log(hydraLine(`Verifying: ${plan.command}`));
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
  log: LogFn,
  usage?: TaskUsage,
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
      usage,
    );
    log(hydraLine(`Commit failed: ${message}`));
    log(
      hydraLine(
        `${taskId} set to blocked. Changes are verified but still uncommitted at ${project.path}.`,
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
    usage,
    verify: false,
  });
  const fileWord = changedFiles.length === 1 ? 'file' : 'files';
  log(
    hydraLine(
      `${taskId} done. Committed ${sha.slice(0, 10)} (${String(changedFiles.length)} ${fileWord}).`,
    ),
  );
  for (const file of changedFiles) {
    log(hydraLine(`  ${file}`));
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

/** The agent touched nothing — mark the task done with a trivial
 * "verification", no manifest, no commit. Split out of runOneEditAttempt
 * purely to keep that function under the project's max-lines-per-function
 * limit; it has exactly one call site. */
async function markNoChangesDone(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  agent: HydraLiteAgent,
  attempt: number,
  usage: TaskUsage | undefined,
  log: LogFn,
): Promise<void> {
  await request('POST', baseUrl, `/task/update?projectId=${project.id}`, {
    taskId,
    status: 'done',
    manifest: [],
    verification: { passed: true, checkedAt: new Date().toISOString() },
    attempts: attempt,
    usage,
    verify: false,
  });
  log(hydraLine(`${agent} made no file changes. ${taskId} marked done.`));
}

/** Verification failed — either hand back a 'retry' outcome (more
 * attempts left) or block the task. Split out of runOneEditAttempt purely
 * to keep that function under the project's max-lines-per-function limit;
 * it has exactly one call site. */
async function handleVerificationFailure(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  attempt: number,
  maxAttempts: number,
  nextThreadId: string,
  outcome: VerifyOutcome,
  usage: TaskUsage | undefined,
  log: LogFn,
): Promise<AttemptOutcome> {
  log(
    hydraLine(
      `Verification failed (attempt ${String(attempt)}/${String(maxAttempts)}): ${outcome.verification.command ?? ''}`,
    ),
  );
  if (attempt < maxAttempts) {
    log(hydraLine('Retrying with the failure as feedback...'));
    return { status: 'retry', threadId: nextThreadId, failure: outcome };
  }
  await markBlocked(
    baseUrl,
    project.id,
    taskId,
    `[Hydra Lite /run] Verification failed after ${String(attempt)} attempt(s) (${outcome.verification.command ?? ''}):\n${outcome.output.slice(0, 500)}`,
    attempt,
    outcome.verification,
    usage,
  );
  log(
    hydraLine(
      `${taskId} set to blocked after ${String(attempt)} attempt(s). Working tree left as-is — inspect it at ${project.path}.`,
    ),
  );
  return { status: 'blocked' };
}

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
  agent: HydraLiteAgent,
  attempt: number,
  maxAttempts: number,
  threadId: string | undefined,
  lastFailure: VerifyOutcome | null,
  timeoutMs: number | undefined,
  log: LogFn,
): Promise<AttemptOutcome> {
  log(
    hydraLine(
      `Running ${taskId} via ${agent} (attempt ${String(attempt)}/${String(maxAttempts)})...`,
    ),
  );
  const originalPrompt = task.notes === '' ? task.title : task.notes;
  const prompt = lastFailure == null ? originalPrompt : buildRetryPrompt(task, lastFailure);

  let nextThreadId: string;
  let summary: string;
  let usage: TaskUsage | undefined;
  try {
    const result = await runEditFor(agent, project.path, prompt, threadId, timeoutMs, (line) => {
      log(agentLine(agent, line));
    });
    nextThreadId = result.threadId;
    summary = result.summary;
    usage = result.usage;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markBlocked(
      baseUrl,
      project.id,
      taskId,
      `[Hydra Lite /run] ${agent} invocation failed on attempt ${String(attempt)}: ${message}`,
      attempt,
    );
    log(hydraLine(`${agent} invocation failed: ${message}`));
    log(hydraLine(`${taskId} set to blocked.`));
    return { status: 'blocked' };
  }
  log(agentLine(agent, summary));

  const changedFiles = listChangedFiles(project.path);
  if (changedFiles.length === 0) {
    await markNoChangesDone(baseUrl, project, taskId, agent, attempt, usage, log);
    return { status: 'done' };
  }

  const outcome = await runProjectVerification(project, log);
  if (outcome.verification.passed) {
    log(hydraLine('Verification passed.'));
    await commitEdit(
      baseUrl,
      project,
      taskId,
      task,
      changedFiles,
      outcome.verification,
      attempt,
      log,
      usage,
    );
    return { status: 'done' };
  }

  return handleVerificationFailure(
    baseUrl,
    project,
    taskId,
    attempt,
    maxAttempts,
    nextThreadId,
    outcome,
    usage,
    log,
  );
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
  agent: HydraLiteAgent,
  maxAttempts: number,
  timeoutMs?: number,
  log: LogFn = console.log,
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
      agent,
      attempt,
      maxAttempts,
      threadId,
      lastFailure,
      timeoutMs,
      log,
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
