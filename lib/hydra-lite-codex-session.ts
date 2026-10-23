/**
 * Hydra Lite chat console — Codex session plumbing.
 *
 * Isolates the raw `codex exec` spawn/parse logic from the console's
 * dispatch loop (lib/hydra-lite-chat.ts), mirroring how
 * lib/hydra-agents.ts's `invoke.nonInteractive` is a pure argv-builder that
 * real execution wraps separately — `buildAskArgs`/`buildResumeArgs` are
 * pure and testable without a live Codex process.
 *
 * Codex CLI persists its own sessions (rollout files) and supports
 * non-interactive continuation via `codex exec resume <id> <prompt>`
 * (verified against the installed codex-cli directly: a fresh `codex exec
 * ... --json` call's first JSONL line is `{"type":"thread.started",
 * "thread_id":"<uuid>"}`, and resuming that id genuinely recalls prior
 * turns). `codex exec resume` accepts neither `-C` nor `-s/--sandbox` —
 * cwd and sandbox mode are fixed at session creation and can't be changed
 * on resume, which is why a read-only ask-thread must never be resumed for
 * edit execution: each privilege level gets its own session.
 *
 * `buildEditArgs` is the write-mode counterpart, used only by an already-
 * approved edit task's execution (lib/hydra-lite-chat.ts's `/run`). It uses
 * `-s workspace-write`, verified hands-on against the installed codex-cli
 * to write real files non-interactively with no hang and no extra
 * approval flag needed. It deliberately does NOT reuse lib/hydra-agents.ts's
 * shared `invoke.headless`, whose default branch pushes `--full-auto` — a
 * flag that does not exist in this codex-cli version and errors immediately
 * ("unexpected argument '--full-auto' found", confirmed hands-on). Never
 * pass `--dangerously-bypass-approvals-and-sandbox` or `--worktree` (Git
 * worktrees are excluded from Hydra Lite) from this module.
 */

import { spawn } from 'node:child_process';

export interface AskOpts {
  cwd: string;
}

/** Start a new, read-only Codex thread. Always `-s read-only` — the whole
 * safety guarantee for chat Q&A rests on this. */
export function buildAskArgs(prompt: string, opts: AskOpts): [string, string[]] {
  return ['codex', ['exec', prompt, '-s', 'read-only', '-C', opts.cwd, '--json']];
}

/** Continue an existing thread. No `-C`/`-s` — codex exec resume rejects
 * both; cwd must instead be passed as the spawned process's own cwd. */
export function buildResumeArgs(threadId: string, prompt: string): [string, string[]] {
  return ['codex', ['exec', 'resume', threadId, prompt, '--json']];
}

/** Start a new, write-enabled Codex thread, sandboxed to `opts.cwd` only.
 * Always `-s workspace-write` — never the dangerous bypass, never
 * `--worktree`. Each edit is one bounded, non-resumed invocation. */
export function buildEditArgs(prompt: string, opts: AskOpts): [string, string[]] {
  return ['codex', ['exec', prompt, '-s', 'workspace-write', '-C', opts.cwd, '--json']];
}

interface ThreadStartedEvent {
  type: 'thread.started';
  thread_id: string;
}

interface ItemCompletedEvent {
  type: 'item.completed';
  item: { type: string; text?: string };
}

function parseJsonlEvents(output: string): unknown[] {
  const events: unknown[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* non-JSON noise (e.g. "Reading additional input from stdin...") — skip */
    }
  }
  return events;
}

function isThreadStarted(event: unknown): event is ThreadStartedEvent {
  return (
    event != null &&
    typeof event === 'object' &&
    (event as Record<string, unknown>)['type'] === 'thread.started' &&
    typeof (event as Record<string, unknown>)['thread_id'] === 'string'
  );
}

function isAgentMessageItem(event: unknown): event is ItemCompletedEvent {
  if (event == null || typeof event !== 'object') return false;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'item.completed') return false;
  const item = record['item'];
  return (
    item != null &&
    typeof item === 'object' &&
    (item as Record<string, unknown>)['type'] === 'agent_message'
  );
}

/** Extract the thread id from a `codex exec ... --json` run's output. */
export function parseThreadId(jsonlOutput: string): string | null {
  const event = parseJsonlEvents(jsonlOutput).find(isThreadStarted);
  return event ? event.thread_id : null;
}

/** Extract the agent's final reply text from a run's output. The last
 * agent_message item.completed event wins, matching what the user sees
 * printed by the interactive CLI. */
export function parseAgentMessage(jsonlOutput: string): string | null {
  const events = parseJsonlEvents(jsonlOutput).filter(isAgentMessageItem);
  const last = events.at(-1);
  return last?.item.text ?? null;
}

function spawnAndCollect(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() === '' ? `codex exited with code ${String(code)}` : stderr.trim(),
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export interface AskResult {
  threadId: string;
  answer: string;
}

/**
 * Ask Codex a read-only question in `projectRoot`, continuing
 * `existingThreadId` if one is already open for this project, or starting
 * a fresh one otherwise.
 */
export async function runAsk(
  projectRoot: string,
  prompt: string,
  existingThreadId?: string,
): Promise<AskResult> {
  const [cmd, args] =
    existingThreadId == null
      ? buildAskArgs(prompt, { cwd: projectRoot })
      : buildResumeArgs(existingThreadId, prompt);
  const output = await spawnAndCollect(cmd, args, projectRoot);
  const threadId = existingThreadId ?? parseThreadId(output);
  if (threadId == null) {
    throw new Error('Codex did not report a thread id for this session.');
  }
  const answer = parseAgentMessage(output);
  if (answer == null) {
    throw new Error('Codex did not return an answer.');
  }
  return { threadId, answer };
}

export interface EditResult {
  summary: string;
}

/**
 * Run an approved edit in `projectRoot`, write-enabled and sandboxed to
 * that directory. The caller (lib/hydra-lite-chat.ts's `/run`) is
 * responsible for the approval check, the clean-working-tree precondition,
 * verification, and the scoped commit — this function only invokes Codex.
 */
export async function runEdit(projectRoot: string, prompt: string): Promise<EditResult> {
  const [cmd, args] = buildEditArgs(prompt, { cwd: projectRoot });
  const output = await spawnAndCollect(cmd, args, projectRoot);
  return { summary: parseAgentMessage(output) ?? '(Codex returned no summary message.)' };
}
