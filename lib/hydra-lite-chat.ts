/**
 * Hydra Lite chat console.
 *
 * A small, Codex-only REPL: converse, switch between registered projects
 * by name, and propose/approve/run edits. Deliberately NOT built on top of
 * lib/hydra-operator.ts's free-text dispatch (handleAutoSmartLine /
 * handleCouncilLine / handleHandoffLine) — that loop picks a "best agent"
 * across claude/gemini/codex or runs multi-round council, neither of which
 * belongs in a Codex-only product. This console reuses lib/hydra-ui.ts's
 * visual helpers for a similar feel, but its own small dispatch loop.
 *
 * Commands (all `/`-prefixed, matching Codex/Claude CLI convention):
 *   /project list                — list registered projects
 *   /project use <name|id>       — switch; resumes or starts that project's session
 *   /project verify [cmd|auto|off] — show, set, or clear this project's verify override
 *   /edit <instructions>       — queue an approval-gated edit task
 *   /approve <taskId>          — unblock an awaiting_approval task to todo
 *   /run <taskId> [maxAttempts] — execute an approved (todo) edit task: claim,
 *                               invoke Codex in write mode, verify, and (on
 *                               success) make exactly one scoped commit; on
 *                               a failed verification, retry (resuming the
 *                               same thread with the failure as feedback)
 *                               up to maxAttempts (default 2) before blocking
 *   /quit                      — exit
 * Bare text (no leading /) is an implicit question: a read-only Codex call
 * (lib/hydra-lite-codex-session.ts), resumed across turns within one
 * project so Codex remembers the conversation — never resumed across a
 * privilege boundary (an edit's /run always starts its own fresh,
 * write-enabled session; a /run retry resumes that session, never a
 * read-only ask-thread).
 */

import readline from 'node:readline';
import pc from 'picocolors';
import { exec } from 'node:child_process';
import { ACCENT, DIM, ERROR, SUCCESS, hydraLogoCompact, divider } from './hydra-ui.ts';
import { request } from './hydra-utils.ts';
import {
  listProjects,
  resolveProjectByNameOrId,
  type RegisteredProject,
} from './hydra-registry.ts';
import { runAsk, runEdit } from './hydra-lite-codex-session.ts';
import {
  listChangedFiles,
  stageAndCommitFiles,
  isWorkingTreeCleanIgnoringHydraState,
} from './hydra-lite-git.ts';
import {
  loadProjectConfig,
  saveProjectVerificationOverride,
  resolveProjectVerificationPlan,
} from './hydra-lite-project-config.ts';
import type { HydraStateShape, TaskEntry } from './types.ts';

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';

interface ConsoleState {
  baseUrl: string;
  currentProject: RegisteredProject | null;
  threadIds: Map<string, string>;
}

function stripAnsiForReadlineWidth(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: marks ANSI escapes invisible to readline's width calc, matching lib/hydra-operator.ts's rlSafe
  return s.replace(/(\x1b\[[0-9;]*m)/g, '\x01$1\x02');
}

function printWelcome(): void {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Hydra Lite chat — Codex only'));
  console.log('');
  console.log(`  ${ACCENT('/project list')}            List registered projects`);
  console.log(`  ${ACCENT('/project use <name|id>')}   Switch projects`);
  console.log(
    `  ${ACCENT('/project verify [cmd|auto|off]')}  Show/set/clear this project's verify override`,
  );
  console.log(`  ${ACCENT('/edit <instructions>')}     Propose an edit (needs /approve)`);
  console.log(
    `  ${ACCENT('/approve <taskId>')}        Unblock an edit task (needs /run to execute)`,
  );
  console.log(
    `  ${ACCENT('/run <taskId> [maxAttempts]')}  Execute an approved edit, retrying on verify failure`,
  );
  console.log(`  ${ACCENT('/quit')}                    Exit`);
  console.log(DIM('  Anything else is a question for Codex about the current project.'));
  console.log('');
}

function buildPrompt(state: ConsoleState): string {
  const label = state.currentProject ? state.currentProject.name : DIM('no project');
  return stripAnsiForReadlineWidth(`${ACCENT('hydra-lite')}${DIM('(')}${label}${DIM(')>')} `);
}

function printProjectList(state: ConsoleState): void {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log(DIM('  No registered projects. Register one with: npm run project -- add <path>'));
    return;
  }
  for (const p of projects) {
    const marker = state.currentProject?.id === p.id ? SUCCESS('*') : ' ';
    console.log(`  ${marker} ${pc.bold(p.name)}  ${DIM(p.id)}  ${DIM(p.path)}`);
  }
}

async function switchProject(state: ConsoleState, nameOrId: string): Promise<void> {
  if (nameOrId === '') {
    console.log(ERROR('  Usage: /project use <name|id>'));
    return;
  }
  const entry = resolveProjectByNameOrId(nameOrId);
  if (!entry) {
    console.log(ERROR(`  No registered project named or id'd "${nameOrId}".`));
    return;
  }
  const baseUrl = state.baseUrl;
  const { state: projectState } = await request<{ state: HydraStateShape }>(
    'GET',
    baseUrl,
    `/state?projectId=${entry.id}`,
  );
  if (projectState.activeSession) {
    console.log(
      SUCCESS(`  Resuming session for ${entry.name}: "${projectState.activeSession.focus}"`),
    );
  } else {
    await request('POST', baseUrl, `/session/start?projectId=${entry.id}`, {
      focus: `Hydra Lite chat — ${entry.name}`,
      owner: 'human',
    });
    console.log(SUCCESS(`  Started a new session for ${entry.name}.`));
  }
  // eslint-disable-next-line require-atomic-updates -- safe: the REPL dispatches one line at a time (lib/hydra-lite-chat.ts's rl.on('line') awaits dispatchLine before the next prompt), so no concurrent switchProject call can race this write
  state.currentProject = entry;
}

/** Print this project's effective verify plan, noting whether it comes
 * from a project override, the global config, or auto-detection. */
function printVerifyStatus(project: RegisteredProject): void {
  const hasOverride = loadProjectConfig(project.path).verification != null;
  const plan = resolveProjectVerificationPlan(project.path);
  const status = plan.enabled ? SUCCESS(plan.command) : DIM('disabled');
  const origin = hasOverride ? 'project override' : plan.source;
  console.log(`  ${pc.bold(project.name)} verify: ${status} ${DIM(`(${origin})`)}`);
}

/** Show, set, or clear the current project's `.hydra/config.json` verify
 * override. "auto" clears it back to the global config / auto-detection;
 * any other value (including "off") becomes the override's command. */
function dispatchProjectVerifyCommand(project: RegisteredProject, rest: string): void {
  const arg = rest.trim();
  if (arg === '') {
    printVerifyStatus(project);
    return;
  }
  if (arg === 'auto') {
    saveProjectVerificationOverride(project.path, null);
    console.log(SUCCESS(`  Cleared verify override for ${project.name}.`));
  } else {
    saveProjectVerificationOverride(project.path, { command: arg });
    console.log(SUCCESS(`  Set verify override for ${project.name}: ${arg}`));
  }
  printVerifyStatus(project);
}

async function dispatchProjectCommand(state: ConsoleState, rest: string): Promise<void> {
  const [sub, ...args] = rest.trim().split(/\s+/);
  if (sub === 'list' || sub === '') {
    printProjectList(state);
    return;
  }
  if (sub === 'use') {
    await switchProject(state, args.join(' '));
    return;
  }
  if (sub === 'verify') {
    if (!state.currentProject) {
      console.log(ERROR('  No current project — run /project use <name|id> first.'));
      return;
    }
    dispatchProjectVerifyCommand(state.currentProject, args.join(' '));
    return;
  }
  console.log(ERROR(`  Unknown /project subcommand "${sub}". Use list|use|verify.`));
}

async function dispatchEditCommand(state: ConsoleState, instructions: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  if (instructions.trim() === '') {
    console.log(ERROR('  Usage: /edit <instructions>'));
    return;
  }
  const title = instructions.length > 60 ? `${instructions.slice(0, 57)}...` : instructions;
  const { task } = await request<{ task: Record<string, unknown> }>(
    'POST',
    state.baseUrl,
    `/task/add?projectId=${state.currentProject.id}`,
    { title, notes: instructions, effect: 'edit' },
  );
  console.log(
    SUCCESS(`  Queued edit task ${String(task['id'])} (status: ${String(task['status'])}).`),
  );
  console.log(
    DIM(`  Run /approve ${String(task['id'])} to unblock it — this does not execute it.`),
  );
}

async function dispatchApproveCommand(state: ConsoleState, taskId: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  if (taskId.trim() === '') {
    console.log(ERROR('  Usage: /approve <taskId>'));
    return;
  }
  const { task } = await request<{ task: Record<string, unknown> }>(
    'POST',
    state.baseUrl,
    `/task/approve?projectId=${state.currentProject.id}`,
    { taskId, approvedBy: 'human' },
  );
  console.log(SUCCESS(`  ${String(task['id'])} is now "${String(task['status'])}".`));
  console.log(DIM(`  Run /run ${String(task['id'])} to actually execute it.`));
}

/** `/run <taskId>` with no explicit attempt count retries this many times
 * total (1 initial attempt + 1 retry) before giving up and blocking. */
const DEFAULT_MAX_ATTEMPTS = 2;

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
 * `/run` needs the full record (effect, status, notes), not just an id. */
async function loadTask(
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

async function markBlocked(
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

/** Load + validate the task /run was asked to execute. Prints its own
 * error and returns null when it isn't runnable; never throws. */
async function loadRunnableTask(
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

/** Claim the task so no other claim can touch it while /run works,
 * including across retries. */
async function claimTask(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
): Promise<boolean> {
  try {
    await request('POST', baseUrl, `/task/claim?projectId=${project.id}`, {
      taskId,
      agent: 'codex',
    });
    return true;
  } catch (err: unknown) {
    console.log(
      ERROR(`  Could not claim ${taskId}: ${err instanceof Error ? err.message : String(err)}`),
    );
    return false;
  }
}

interface VerifyOutcome {
  verification: NonNullable<TaskEntry['verification']>;
  output: string;
}

/** Run the project's verify command (if any) and just report the outcome —
 * never touches the task itself. The retry loop in dispatchRunCommand
 * decides whether a failure means "block" or "retry with feedback". */
async function runProjectVerification(project: RegisteredProject): Promise<VerifyOutcome> {
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
async function commitEdit(
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
function buildRetryPrompt(task: TaskEntry, failure: VerifyOutcome): string {
  const original = task.notes === '' ? task.title : task.notes;
  return [
    `Verification ("${failure.verification.command ?? ''}") failed after your last change:`,
    failure.output.slice(0, 1500),
    '',
    'Please fix the issue so verification passes. Original task:',
    original,
  ].join('\n');
}

function parseMaxAttempts(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

type AttemptOutcome =
  | { status: 'done' }
  | { status: 'blocked' }
  | { status: 'retry'; threadId: string; failure: VerifyOutcome };

/**
 * Run one Codex attempt (fresh, or resuming `threadId` with `lastFailure`
 * as feedback), then verify it. Reports and persists every outcome itself
 * — `dispatchRunCommand`'s loop only has to act on the returned status.
 */
async function runOneEditAttempt(
  baseUrl: string,
  project: RegisteredProject,
  taskId: string,
  task: TaskEntry,
  attempt: number,
  maxAttempts: number,
  threadId: string | undefined,
  lastFailure: VerifyOutcome | null,
): Promise<AttemptOutcome> {
  console.log(DIM(`  Running ${taskId} (attempt ${String(attempt)}/${String(maxAttempts)})...`));
  const originalPrompt = task.notes === '' ? task.title : task.notes;
  const prompt = lastFailure == null ? originalPrompt : buildRetryPrompt(task, lastFailure);

  let nextThreadId: string;
  let summary: string;
  try {
    const result = await runEdit(project.path, prompt, threadId);
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
 * Execute an already-approved (`todo`) edit task: claim it once (subject
 * to the existing concurrency gate), then make up to `maxAttempts` Codex
 * attempts via runOneEditAttempt, each followed by verification. A retry
 * resumes the SAME write-mode thread with the verification failure as
 * feedback — never a fresh session, so Codex sees exactly what it tried
 * before — and never resumes across a privilege boundary, since every
 * attempt in this loop is already write-mode. Stops at the first attempt
 * that verifies cleanly; a Codex-invocation failure (as opposed to a
 * verification failure) blocks immediately, since there is no useful
 * feedback to retry with. Never discards a dirty tree — a task that
 * exhausts every attempt is left blocked with the tree as Codex left it.
 */
async function dispatchRunCommand(state: ConsoleState, rawArgs: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const [taskId, maxAttemptsArg] = rawArgs.trim().split(/\s+/);
  if (taskId === '') {
    console.log(ERROR('  Usage: /run <taskId> [maxAttempts]'));
    return;
  }
  const maxAttempts = parseMaxAttempts(maxAttemptsArg);
  const project = state.currentProject;
  const { baseUrl } = state;

  const task = await loadRunnableTask(baseUrl, project, taskId);
  if (!task) return;
  if (!(await claimTask(baseUrl, project, taskId))) return;

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
    );
    if (outcome.status !== 'retry') return;
    threadId = outcome.threadId;
    lastFailure = outcome.failure;
  }
}

async function dispatchAsk(state: ConsoleState, question: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const existingThreadId = state.threadIds.get(state.currentProject.id);
  const { threadId, answer } = await runAsk(state.currentProject.path, question, existingThreadId);
  state.threadIds.set(state.currentProject.id, threadId);
  console.log(`  ${answer}`);
}

async function dispatchLine(state: ConsoleState, line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed === '/quit' || trimmed === '/exit') return false;
  if (trimmed === '/help') {
    printWelcome();
    return true;
  }
  if (trimmed === '/project' || trimmed.startsWith('/project ')) {
    await dispatchProjectCommand(state, trimmed.slice('/project'.length));
    return true;
  }
  if (trimmed.startsWith('/edit ')) {
    await dispatchEditCommand(state, trimmed.slice('/edit '.length));
    return true;
  }
  if (trimmed.startsWith('/approve ')) {
    await dispatchApproveCommand(state, trimmed.slice('/approve '.length).trim());
    return true;
  }
  if (trimmed.startsWith('/run ')) {
    await dispatchRunCommand(state, trimmed.slice('/run '.length).trim());
    return true;
  }
  if (trimmed.startsWith('/')) {
    console.log(ERROR(`  Unknown command "${trimmed.split(' ')[0]}". Type /help.`));
    return true;
  }
  await dispatchAsk(state, trimmed);
  return true;
}

function main(): void {
  const urlArg = process.argv.slice(2).find((arg) => arg.startsWith('url='));
  const state: ConsoleState = {
    baseUrl: urlArg == null ? DEFAULT_URL : urlArg.slice('url='.length),
    currentProject: null,
    threadIds: new Map(),
  };

  printWelcome();
  console.log(divider());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: buildPrompt(state),
  });
  rl.prompt();

  // Serialize line dispatch: readline's 'line' event fires for every
  // buffered line immediately, without waiting for a prior async handler
  // to finish (e.g. the user types two lines quickly, or stdin reaches EOF
  // while a dispatch is still in flight). Chaining through `processing`
  // guarantees only one dispatchLine runs at a time, which switchProject's
  // state mutation relies on; the `closed` flag (readline's own `.closed`
  // isn't in this project's @types/node) guards against prompting an
  // interface that EOF/`/quit` already closed meanwhile.
  let closed = false;
  let processing = Promise.resolve();
  rl.on('line', (line: string) => {
    processing = processing.then(async () => {
      let keepGoing = true;
      try {
        keepGoing = await dispatchLine(state, line);
      } catch (err: unknown) {
        console.log(ERROR(`  ${err instanceof Error ? err.message : String(err)}`));
      }
      if (!keepGoing) {
        rl.close();
        return;
      }
      if (!closed) {
        rl.setPrompt(buildPrompt(state));
        rl.prompt();
      }
    });
  });

  rl.on('close', () => {
    closed = true;
    console.log(DIM('\n  Goodbye.'));
    process.exitCode = 0;
  });
}

main();
