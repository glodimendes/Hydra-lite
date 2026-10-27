/**
 * Hydra Lite chat console.
 *
 * A small REPL: converse, switch between registered projects by name,
 * propose/approve/run edits, and pick which CLI (codex/claude/gemini)
 * actually does the work via one global `/agent` setting. Deliberately
 * NOT built on top of lib/hydra-operator.ts's free-text dispatch
 * (handleAutoSmartLine / handleCouncilLine / handleHandoffLine) — that
 * loop picks a "best agent" by routing heuristics or runs multi-round
 * council, neither of which fits this product's one-agent-at-a-time,
 * human-picked model. This console reuses lib/hydra-ui.ts's visual
 * helpers for a similar feel, but its own small dispatch loop.
 *
 * Commands (all `/`-prefixed, matching Codex/Claude CLI convention):
 *   /agent [codex|claude|gemini] — show, or switch, the active CLI
 *   /project list                — list registered projects
 *   /project use <name|id>       — switch; resumes or starts that project's session
 *   /project verify [cmd|auto|off] — show, set, or clear this project's verify override
 *   /project priority <name|id> <n> — set a project's worker scheduling priority
 *   /edit <instructions>       — queue an approval-gated edit task, tagged
 *                               with the agent active right now (switching
 *                               /agent later never changes it — see
 *                               types.ts's `intendedAgent`)
 *   /approve <taskId>          — unblock an awaiting_approval task to todo
 *   /priority <taskId> <n>     — set a task's scheduling priority (default 0)
 *   /run <taskId> [maxAttempts] — execute an approved (todo) edit task: claim,
 *                               invoke the task's own intended agent in write
 *                               mode, verify, and (on success) make exactly
 *                               one scoped commit; on a failed verification,
 *                               retry (resuming the same thread with the
 *                               failure as feedback) up to maxAttempts
 *                               (default 2) before blocking
 *   /quit                      — exit
 * Bare text (no leading /) is an implicit question: a read-only call to
 * the active `/agent`, resumed across turns within one project+agent pair
 * so it remembers the conversation — never resumed across a privilege
 * boundary (an edit's /run always starts its own fresh, write-enabled
 * session; a /run retry resumes that session, never a read-only
 * ask-thread) and never across an agent switch (each agent's CLI session
 * ids aren't interchangeable with another's).
 */

import readline from 'node:readline';
import pc from 'picocolors';
import { ACCENT, DIM, ERROR, SUCCESS, hydraLogoCompact, divider } from './hydra-ui.ts';
import { request } from './hydra-utils.ts';
import {
  listProjects,
  resolveProjectByNameOrId,
  setProjectPriority,
  type RegisteredProject,
} from './hydra-registry.ts';
import { runAsk as runCodexAsk } from './hydra-lite-codex-session.ts';
import { runAsk as runClaudeAsk } from './hydra-lite-claude-session.ts';
import {
  loadProjectConfig,
  saveProjectVerificationOverride,
  resolveProjectVerificationPlan,
} from './hydra-lite-project-config.ts';
import {
  loadRunnableTask,
  claimTask,
  runEditWithRetries,
  resolveTaskAgent,
  parseMaxAttempts,
  type HydraLiteAgent,
} from './hydra-lite-run-edit.ts';
import type { HydraStateShape } from './types.ts';

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';
const KNOWN_AGENTS: readonly HydraLiteAgent[] = ['codex', 'claude', 'gemini'];

interface ConsoleState {
  baseUrl: string;
  currentProject: RegisteredProject | null;
  currentAgent: HydraLiteAgent;
  /** Keyed by `${projectId}:${agent}` — a session id from one CLI is never
   * valid to resume with another, so switching /agent must never reuse an
   * old thread. */
  threadIds: Map<string, string>;
}

function threadKey(state: ConsoleState, projectId: string): string {
  return `${projectId}:${state.currentAgent}`;
}

/** Ask the active agent a read-only question. Each CLI's session module
 * mirrors the same `runAsk(projectRoot, prompt, existingThreadId?)` shape
 * (lib/hydra-lite-codex-session.ts / hydra-lite-claude-session.ts). */
function askActiveAgent(
  agent: HydraLiteAgent,
  projectRoot: string,
  prompt: string,
  existingThreadId: string | undefined,
): ReturnType<typeof runCodexAsk> {
  if (agent === 'codex') return runCodexAsk(projectRoot, prompt, existingThreadId);
  if (agent === 'claude') return runClaudeAsk(projectRoot, prompt, existingThreadId);
  throw new Error(`Gemini CLI support is not implemented yet (agent "${agent}").`);
}

function stripAnsiForReadlineWidth(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: marks ANSI escapes invisible to readline's width calc, matching lib/hydra-operator.ts's rlSafe
  return s.replace(/(\x1b\[[0-9;]*m)/g, '\x01$1\x02');
}

function printWelcome(): void {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Hydra Lite chat'));
  console.log('');
  console.log(`  ${ACCENT('/agent [codex|claude|gemini]')}  Show, or switch, the active CLI`);
  console.log(`  ${ACCENT('/project list')}            List registered projects`);
  console.log(`  ${ACCENT('/project use <name|id>')}   Switch projects`);
  console.log(
    `  ${ACCENT('/project verify [cmd|auto|off]')}  Show/set/clear this project's verify override`,
  );
  console.log(
    `  ${ACCENT('/project priority <name|id> <n>')}  Set a project's worker scheduling priority`,
  );
  console.log(`  ${ACCENT('/edit <instructions>')}     Propose an edit (needs /approve)`);
  console.log(
    `  ${ACCENT('/approve <taskId>')}        Unblock an edit task (needs /run to execute)`,
  );
  console.log(`  ${ACCENT('/priority <taskId> <n>')}   Set a task's scheduling priority`);
  console.log(
    `  ${ACCENT('/run <taskId> [maxAttempts]')}  Execute an approved edit, retrying on verify failure`,
  );
  console.log(`  ${ACCENT('/quit')}                    Exit`);
  console.log(
    DIM('  Anything else is a question for the active /agent about the current project.'),
  );
  console.log('');
}

function buildPrompt(state: ConsoleState): string {
  const label = state.currentProject ? state.currentProject.name : DIM('no project');
  return stripAnsiForReadlineWidth(
    `${ACCENT('hydra-lite')}${DIM('[')}${state.currentAgent}${DIM('](')}${label}${DIM(')>')} `,
  );
}

/** Show, or switch, the chat console's one global active-agent setting.
 * Switching never touches an already-queued task's own intendedAgent (see
 * types.ts) — it only decides what a NEW /edit gets tagged with, and
 * which CLI bare-text Q&A talks to from now on. */
function dispatchAgentCommand(state: ConsoleState, rest: string): void {
  const arg = rest.trim().toLowerCase();
  if (arg === '') {
    console.log(`  Active agent: ${pc.bold(state.currentAgent)}`);
    return;
  }
  if (!KNOWN_AGENTS.includes(arg as HydraLiteAgent)) {
    console.log(ERROR(`  Unknown agent "${arg}". Use one of: ${KNOWN_AGENTS.join(', ')}.`));
    return;
  }
  state.currentAgent = arg as HydraLiteAgent;
  console.log(SUCCESS(`  Active agent is now ${state.currentAgent}.`));
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

/** Set a registered project's scheduling priority (default 0, higher =
 * proportionally more of the worker's weighted-round-robin attention). */
function dispatchProjectPriorityCommand(args: string[]): void {
  const nameOrId = args.at(0);
  const rawValue = args.at(1);
  const entry = nameOrId == null ? undefined : resolveProjectByNameOrId(nameOrId);
  if (!entry || rawValue == null || rawValue.trim() === '') {
    console.log(ERROR('  Usage: /project priority <name|id> <n>'));
    return;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    console.log(ERROR(`  Priority must be an integer, got "${rawValue}".`));
    return;
  }
  const updated = setProjectPriority(entry.id, value);
  console.log(SUCCESS(`  ${updated.name} priority is now ${String(updated.priority)}.`));
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
  if (sub === 'priority') {
    dispatchProjectPriorityCommand(args);
    return;
  }
  console.log(ERROR(`  Unknown /project subcommand "${sub}". Use list|use|verify|priority.`));
}

/** Set a task's scheduling priority (default 0, higher = picked first
 * among its own project's runnable tasks, and tie-breaks the project's
 * share of the worker's weighted round-robin — see hydra-lite-worker.ts). */
async function dispatchPriorityCommand(state: ConsoleState, rawArgs: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const tokens = rawArgs.trim().split(/\s+/);
  const taskId = tokens.at(0);
  const rawValue = tokens.at(1);
  const value = rawValue == null ? Number.NaN : Number.parseInt(rawValue, 10);
  if (taskId == null || taskId === '' || !Number.isFinite(value)) {
    console.log(ERROR('  Usage: /priority <taskId> <n>'));
    return;
  }
  const { task } = await request<{ task: Record<string, unknown> }>(
    'POST',
    state.baseUrl,
    `/task/update?projectId=${state.currentProject.id}`,
    { taskId, priority: value },
  );
  console.log(SUCCESS(`  ${String(task['id'])} priority is now ${String(task['priority'])}.`));
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
    { title, notes: instructions, effect: 'edit', intendedAgent: state.currentAgent },
  );
  console.log(
    SUCCESS(
      `  Queued edit task ${String(task['id'])} for ${state.currentAgent} (status: ${String(task['status'])}).`,
    ),
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

/**
 * Execute an already-approved (`todo`) edit task: claim it once (subject
 * to the existing concurrency gate), then delegate the attempt/retry/
 * verify/commit loop to lib/hydra-lite-run-edit.ts's runEditWithRetries —
 * the same shared logic the unattended worker uses, so behavior can't
 * drift between a human running `/run` and the worker running the same
 * task type unattended.
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
  const agent = resolveTaskAgent(task);
  if (!(await claimTask(baseUrl, project, taskId, agent))) return;

  await runEditWithRetries(baseUrl, project, taskId, task, agent, maxAttempts);
}

async function dispatchAsk(state: ConsoleState, question: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const key = threadKey(state, state.currentProject.id);
  const existingThreadId = state.threadIds.get(key);
  const { threadId, answer } = await askActiveAgent(
    state.currentAgent,
    state.currentProject.path,
    question,
    existingThreadId,
  );
  state.threadIds.set(key, threadId);
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
  if (trimmed === '/agent' || trimmed.startsWith('/agent ')) {
    dispatchAgentCommand(state, trimmed.slice('/agent'.length));
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
  if (trimmed.startsWith('/priority ')) {
    await dispatchPriorityCommand(state, trimmed.slice('/priority '.length));
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
    currentAgent: 'codex',
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
