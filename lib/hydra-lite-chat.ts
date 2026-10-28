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
 *   /status                    — list the current project's tasks: goal,
 *                               status, intended agent, last update
 *   /usage                     — cumulative token/cost usage for the
 *                               current project, overall and per agent
 *   /quit                      — exit
 * Bare text (no leading /) is an implicit question: a read-only call to
 * the active `/agent`, resumed across turns within one project+agent pair
 * so it remembers the conversation — never resumed across a privilege
 * boundary (an edit's /run always starts its own fresh, write-enabled
 * session; a /run retry resumes that session, never a read-only
 * ask-thread) and never across an agent switch (each agent's CLI session
 * ids aren't interchangeable with another's). Right after an answer, the
 * console suggests turning that same question into an edit task —
 * answering "y"/"yes" queues it, approves it, and runs it in one go
 * (still three real steps under the hood, via the same
 * dispatchEditCommand/dispatchApproveCommand/dispatchRunCommand a manual
 * /edit+/approve+/run would call — this just collapses the human side of
 * it to one confirmation); anything else typed instead just dispatches
 * normally, dropping the suggestion rather than blocking on it.
 *
 * The prompt is always there to type into, including while /run or a
 * bare-text question is still working — it just turns a different color
 * (WARNING) for that window, back to normal (ACCENT) once it's done, so
 * "something's running" is visible without ever blocking input. Anything
 * printed during that window (the agent's own progress lines, the usage
 * ticker) goes through printLine rather than a bare console.log, so it
 * can't clobber whatever you're mid-typing into the prompt — see
 * redrawPrompt/printLine/setBusy below.
 */

import readline from 'node:readline';
import pc from 'picocolors';
import {
  ACCENT,
  DIM,
  ERROR,
  SUCCESS,
  WARNING,
  hydraLogoCompact,
  divider,
  relativeTime,
} from './hydra-ui.ts';
import { request } from './hydra-utils.ts';
import { exit } from './hydra-process.ts';
import { killAllChildren, killAllChildrenSync } from './hydra-lite-process-registry.ts';
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
  agentProgressLine,
  agentOutputLine,
  hydraLine,
  type HydraLiteAgent,
  type LogFn,
} from './hydra-lite-run-edit.ts';
import { summarizeUsage, formatUsageSummary } from './hydra-lite-usage.ts';
import type { HydraStateShape } from './types.ts';

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';
const KNOWN_AGENTS: readonly HydraLiteAgent[] = ['codex', 'claude', 'gemini'];
/** How often the background usage ticker fires while the console sits
 * idle — overridable with `url=... --usage-interval-minutes=N`. */
const DEFAULT_USAGE_INTERVAL_MINUTES = 15;

interface ConsoleState {
  baseUrl: string;
  currentProject: RegisteredProject | null;
  currentAgent: HydraLiteAgent;
  /** Keyed by `${projectId}:${agent}` — a session id from one CLI is never
   * valid to resume with another, so switching /agent must never reuse an
   * old thread. */
  threadIds: Map<string, string>;
  /** True while /run or a bare-text ask has a CLI invocation in flight —
   * drives the prompt's color (see buildPrompt) and nothing else; the
   * REPL still queues and runs whatever's typed next exactly as before. */
  busy: boolean;
  rl: readline.Interface;
  /** True once `rl` has closed (via /quit or EOF). A /run's underlying
   * CLI child process (lib/hydra-lite-codex-session.ts /
   * hydra-lite-claude-session.ts) isn't killed when the console exits —
   * a pre-existing gap, not something this flag tries to fix — so a
   * stray progress line can still arrive after /quit. redrawPrompt/
   * printLine check this instead of touching a closed readline
   * interface, which throws (confirmed hands-on: `ERR_USE_AFTER_CLOSE`
   * crashed the whole process). */
  closed: boolean;
  /** Set right after a bare-text ask prints its answer; cleared by the
   * very next line typed, whatever it is. If that line is "y"/"yes"
   * (case-insensitive), the ask's own question becomes an edit task
   * that's immediately approved and run — one confirmation standing in
   * for what would otherwise be a manual /edit, /approve, /run. Any
   * other line (including a totally unrelated command) just drops the
   * suggestion and dispatches normally, so it's never a modal blocker. */
  pendingTaskSuggestion: { instructions: string } | null;
}

function threadKey(state: ConsoleState, projectId: string): string {
  return `${projectId}:${state.currentAgent}`;
}

/** Ask the active agent a read-only question. Each CLI's session module
 * mirrors the same `runAsk(projectRoot, prompt, existingThreadId?,
 * onProgress?)` shape (lib/hydra-lite-codex-session.ts /
 * hydra-lite-claude-session.ts). */
function askActiveAgent(
  agent: HydraLiteAgent,
  projectRoot: string,
  prompt: string,
  existingThreadId: string | undefined,
  onProgress: LogFn,
): ReturnType<typeof runCodexAsk> {
  if (agent === 'codex') return runCodexAsk(projectRoot, prompt, existingThreadId, onProgress);
  if (agent === 'claude') return runClaudeAsk(projectRoot, prompt, existingThreadId, onProgress);
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
  console.log(`  ${ACCENT('/status')}                  List this project's tasks and their agent`);
  console.log(
    `  ${ACCENT('/usage')}                   Cumulative token/cost usage for this project`,
  );
  console.log(`  ${ACCENT('/quit')}                    Exit`);
  console.log(
    DIM('  Anything else is a question for the active /agent about the current project.'),
  );
  console.log(
    DIM('  Answer "y" right after to queue, approve, and run it as an edit task instead.'),
  );
  console.log('');
}

/** The prompt's "hydra-lite" word: green while idle, yellow while a
 * CLI invocation is in flight (WARNING, already pc.yellow) — both are
 * standard ANSI hues, chosen to read clearly whether the terminal theme
 * is light or dark (unlike, say, plain ANSI black — see PROMPT_AGENT_COLORS
 * below for why that matters here). */
const PROMPT_IDLE_COLOR = pc.green;

/** Differentiates which CLI the prompt's `[agent]` segment names — one
 * color per model, reused for /status's agent column too (see
 * dispatchStatusCommand) so the same color always means the same agent
 * everywhere in the console. Deliberately plain ANSI colors (not a
 * custom true-color blend): green/blue/red are part of every terminal
 * theme's base 16 and are designed to stay legible against both a dark
 * and a light background, which a hand-picked RGB value isn't
 * guaranteed to be. */
const PROMPT_AGENT_COLORS: Readonly<Record<HydraLiteAgent, (s: string) => string>> = {
  codex: pc.green,
  gemini: pc.blue,
  claude: pc.red,
};

function buildPrompt(state: ConsoleState): string {
  const label = state.currentProject ? state.currentProject.name : DIM('no project');
  const hydraColor = state.busy ? WARNING : PROMPT_IDLE_COLOR;
  const agentColor = PROMPT_AGENT_COLORS[state.currentAgent];
  return stripAnsiForReadlineWidth(
    `${hydraColor('hydra-lite')}${DIM('[')}${agentColor(state.currentAgent)}${DIM('](')}${label}${DIM(')>')} `,
  );
}

/** Redraw the prompt with the current busy/idle color, preserving
 * whatever the user has already typed (`preserveCursor`) — the prompt is
 * always there to type into, so this never clears their in-progress
 * line, just repaints it. Call it whenever `state.busy` changes or right
 * after printLine prints something above it. No-ops once `state.closed`
 * — readline is gone by then, and touching it throws. */
function redrawPrompt(state: ConsoleState): void {
  if (state.closed) return;
  state.rl.setPrompt(buildPrompt(state));
  state.rl.prompt(true);
}

/** Print a line without clobbering whatever the user is mid-typing into
 * the active prompt: clear the current input row, write the line above
 * it, then redraw the prompt (and the user's buffered text) beneath it.
 * Use this instead of a bare console.log for anything printed while a
 * command may still be running — an agent's progress line, the usage
 * ticker — since a plain console.log there would overwrite the prompt
 * row instead of scrolling above it. Once `state.closed` (the console
 * already quit, but a /run's CLI child is still finishing up in the
 * background — see ConsoleState's docstring), there's no prompt left to
 * protect, so this just falls back to a plain console.log. */
function printLine(state: ConsoleState, text: string): void {
  if (state.closed) {
    console.log(text);
    return;
  }
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(text);
  redrawPrompt(state);
}

function setBusy(state: ConsoleState, busy: boolean): void {
  state.busy = busy;
  redrawPrompt(state);
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

/** Queue an edit task. Returns its id on success (so runSuggestedTask
 * below can chase it straight into /approve + /run), or null if nothing
 * was queued (no current project, empty instructions). */
async function dispatchEditCommand(
  state: ConsoleState,
  instructions: string,
): Promise<string | null> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return null;
  }
  if (instructions.trim() === '') {
    console.log(ERROR('  Usage: /edit <instructions>'));
    return null;
  }
  const title = instructions.length > 60 ? `${instructions.slice(0, 57)}...` : instructions;
  const { task } = await request<{ task: Record<string, unknown> }>(
    'POST',
    state.baseUrl,
    `/task/add?projectId=${state.currentProject.id}`,
    { title, notes: instructions, effect: 'edit', intendedAgent: state.currentAgent },
  );
  const taskId = String(task['id']);
  console.log(
    SUCCESS(
      `  Queued edit task ${taskId} for ${state.currentAgent} (status: ${String(task['status'])}).`,
    ),
  );
  console.log(DIM(`  Run /approve ${taskId} to unblock it — this does not execute it.`));
  return taskId;
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

  setBusy(state, true);
  try {
    await runEditWithRetries(
      baseUrl,
      project,
      taskId,
      task,
      agent,
      maxAttempts,
      undefined,
      (line) => {
        printLine(state, line);
      },
    );
  } finally {
    setBusy(state, false);
  }
}

async function dispatchAsk(state: ConsoleState, question: string): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const key = threadKey(state, state.currentProject.id);
  const existingThreadId = state.threadIds.get(key);
  setBusy(state, true);
  try {
    const { threadId, answer } = await askActiveAgent(
      state.currentAgent,
      state.currentProject.path,
      question,
      existingThreadId,
      (line) => {
        printLine(state, agentProgressLine(state.currentAgent, line));
      },
    );
    state.threadIds.set(key, threadId);
    printLine(state, agentOutputLine(state.currentAgent, answer));
  } finally {
    setBusy(state, false);
  }
  state.pendingTaskSuggestion = { instructions: question };
  printLine(state, hydraLine('Want me to create, approve, and run this as an edit task? [y/N]'));
}

/**
 * Carry out a suggestion the user just confirmed with "y"/"yes": queue
 * the original question as an edit task, approve it, then run it —
 * reusing the exact same dispatch functions a manual /edit, /approve,
 * /run would, so nothing about the approval/verify/commit pipeline
 * changes; only the number of prompts the human has to answer does.
 * Stops early (no approve/run) if the queue step itself failed.
 */
async function runSuggestedTask(
  state: ConsoleState,
  suggestion: { instructions: string },
): Promise<void> {
  const taskId = await dispatchEditCommand(state, suggestion.instructions);
  if (taskId == null) return;
  await dispatchApproveCommand(state, taskId);
  await dispatchRunCommand(state, taskId);
}

/** List the current project's tasks: id, status, intended agent, goal
 * (title), and how long since it last changed — the "what are agents
 * doing/controlled/launched for" view. Read-only, fast (one GET /state),
 * so unlike /run and bare-text ask it never toggles busy. */
async function dispatchStatusCommand(state: ConsoleState): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const { state: projectState } = await request<{ state: HydraStateShape }>(
    'GET',
    state.baseUrl,
    `/state?projectId=${state.currentProject.id}`,
  );
  const tasks = projectState.tasks;
  if (tasks.length === 0) {
    console.log(DIM('  No tasks yet in this project.'));
    return;
  }
  for (const task of tasks) {
    const agent = task.effect === 'edit' ? resolveTaskAgent(task) : null;
    const agentLabel = agent == null ? DIM('-') : PROMPT_AGENT_COLORS[agent](agent);
    const goal = task.title === '' ? task.notes : task.title;
    console.log(
      `  ${pc.bold(task.id)} ${DIM(`[${task.status}]`)} ${agentLabel} ${goal} ${DIM(`(${relativeTime(task.updatedAt)})`)}`,
    );
  }
}

/** Cumulative token/cost usage for the current project, overall and per
 * agent — sums the `usage` field Hydra Lite stamps onto finished edit
 * tasks (lib/hydra-lite-run-edit.ts), straight off GET /state. */
async function dispatchUsageCommand(state: ConsoleState): Promise<void> {
  if (!state.currentProject) {
    console.log(ERROR('  No current project — run /project use <name|id> first.'));
    return;
  }
  const { state: projectState } = await request<{ state: HydraStateShape }>(
    'GET',
    state.baseUrl,
    `/state?projectId=${state.currentProject.id}`,
  );
  console.log(formatUsageSummary(summarizeUsage(projectState.tasks)));
}

/** Commands that take no arguments — checked by exact match before the
 * prefix-based commands below, mainly to keep dispatchLine's branch count
 * under the project's complexity limit as new no-arg commands are added. */
const ZERO_ARG_COMMANDS: Readonly<Record<string, (state: ConsoleState) => void | Promise<void>>> = {
  '/status': dispatchStatusCommand,
  '/usage': dispatchUsageCommand,
  '/help': printWelcome,
};

/** If a task suggestion is pending, consume it: run the suggested
 * create+approve+run chain on "y"/"yes", otherwise just drop it.
 * Returns true when that fully handled the line (an accepted
 * suggestion) and dispatchLine should stop there; false means
 * dispatchLine should keep going and dispatch the line normally — a
 * decline, or no suggestion was pending in the first place. Split out
 * of dispatchLine purely to keep that function under the project's
 * complexity limit. */
async function maybeHandleTaskSuggestion(state: ConsoleState, trimmed: string): Promise<boolean> {
  const suggestion = state.pendingTaskSuggestion;
  if (suggestion == null) return false;
  state.pendingTaskSuggestion = null;
  if (trimmed.toLowerCase() !== 'y' && trimmed.toLowerCase() !== 'yes') return false;
  await runSuggestedTask(state, suggestion);
  return true;
}

async function dispatchLine(state: ConsoleState, line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (await maybeHandleTaskSuggestion(state, trimmed)) return true;
  if (trimmed === '') return true;
  if (trimmed === '/quit' || trimmed === '/exit') return false;
  if (Object.hasOwn(ZERO_ARG_COMMANDS, trimmed)) {
    await ZERO_ARG_COMMANDS[trimmed](state);
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

function parseUsageIntervalMinutes(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith('--usage-interval-minutes='));
  if (arg == null) return DEFAULT_USAGE_INTERVAL_MINUTES;
  const value = Number.parseInt(arg.slice('--usage-interval-minutes='.length), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USAGE_INTERVAL_MINUTES;
}

/** Print an unprompted usage summary for the current project, same
 * formatting as /usage — the background ticker's one job. No-ops with no
 * current project, since there's nothing to summarize yet. */
async function tickUsage(state: ConsoleState): Promise<void> {
  if (!state.currentProject) return;
  try {
    const { state: projectState } = await request<{ state: HydraStateShape }>(
      'GET',
      state.baseUrl,
      `/state?projectId=${state.currentProject.id}`,
    );
    printLine(state, formatUsageSummary(summarizeUsage(projectState.tasks)));
  } catch {
    /* the daemon may be mid-restart — skip silently, next tick will catch up */
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const urlArg = argv.find((arg) => arg.startsWith('url='));

  printWelcome();
  console.log(divider());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
  });
  const state: ConsoleState = {
    baseUrl: urlArg == null ? DEFAULT_URL : urlArg.slice('url='.length),
    currentProject: null,
    currentAgent: 'codex',
    threadIds: new Map(),
    busy: false,
    rl,
    closed: false,
    pendingTaskSuggestion: null,
  };
  redrawPrompt(state);

  const usageIntervalMs = parseUsageIntervalMinutes(argv) * 60_000;
  const ticker = setInterval(() => {
    tickUsage(state).catch(() => {
      /* tickUsage already swallows its own errors; this is belt-and-suspenders */
    });
  }, usageIntervalMs);

  // Serialize line dispatch: readline's 'line' event fires for every
  // buffered line immediately, without waiting for a prior async handler
  // to finish (e.g. the user types two lines quickly, or stdin reaches EOF
  // while a dispatch is still in flight). Chaining through `processing`
  // guarantees only one dispatchLine runs at a time, which switchProject's
  // state mutation relies on; `state.closed` (readline's own `.closed`
  // isn't in this project's @types/node) guards against prompting an
  // interface that EOF/`/quit` already closed meanwhile — and, since
  // redrawPrompt/printLine check the same flag, against a /run's
  // still-finishing CLI child trying to do the same from outside this
  // handler entirely.
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
      if (!state.closed) {
        redrawPrompt(state);
      }
    });
  });

  rl.on('close', () => {
    state.closed = true;
    clearInterval(ticker);
    console.log(DIM('\n  Goodbye.'));
    process.exitCode = 0;
    // Don't await: a still-running /run's agent child is what's keeping
    // this process alive past "Goodbye." in the first place (its open
    // stdout pipe), so killing it is what lets the event loop actually
    // drain — see hydra-lite-process-registry.ts's module doc for why
    // this matters (confirmed hands-on: without it, that child outlives
    // the console entirely, with no further Hydra Lite oversight).
    killAllChildren().catch(() => {
      /* best-effort; process 'exit' below is the synchronous backstop */
    });
  });

  installShutdownSignalHandlers();
}

/**
 * Guarantee no spawned CLI child outlives this console, on every path
 * that can end it — not just /quit (handled by the 'close' listener
 * above). A first SIGINT/SIGTERM kills children gracefully (SIGTERM,
 * then SIGKILL after a grace period) and exits; a second one while
 * that's still in flight skips the grace period. `process.on('exit', …)`
 * is the last-resort synchronous backstop for anything else (an
 * uncaught exception, for instance) — it can't await, so it goes
 * straight to SIGKILL.
 */
function installShutdownSignalHandlers(): void {
  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    if (shuttingDown) {
      killAllChildrenSync();
      exit(1);
    }
    shuttingDown = true;
    console.log(DIM(`\n  Received ${signal} — stopping any in-flight CLI invocation and exiting.`));
    killAllChildren()
      .catch(() => {
        /* best-effort; process 'exit' below is the synchronous backstop */
      })
      .finally(() => {
        exit(exitCode);
      });
  };
  process.on('SIGINT', () => {
    handleSignal('SIGINT', 130);
  });
  process.on('SIGTERM', () => {
    handleSignal('SIGTERM', 143);
  });
  process.on('exit', killAllChildrenSync);
}

main();
