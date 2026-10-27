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
 *
 * Progress streaming: `codex exec --json` already prints one JSONL event
 * per completed step as the run happens, not just at the end — this
 * module now reads stdout incrementally (not just buffered at `close`) so
 * `onProgress`, when the caller passes one, gets a short line per
 * meaningful step (an agent message, a command run, a file touched) while
 * the run is still in flight. That's the chat console's "in-between"
 * level of detail: one line per completed step, never raw per-token
 * deltas — see formatCodexProgressEvent.
 */

import { spawn } from 'node:child_process';
import type { TaskUsage } from './types.ts';

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

interface TurnCompletedEvent {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

function isTurnCompleted(event: unknown): event is TurnCompletedEvent {
  return (
    event != null &&
    typeof event === 'object' &&
    (event as Record<string, unknown>)['type'] === 'turn.completed'
  );
}

/** Extract token usage from the last turn.completed event, if any. Codex
 * reports no dollar cost — only token counts — so `costUsd` is always
 * left unset here; `durationMs` isn't part of this, since the caller
 * (runAsk/runEdit) measures real wall-clock time around the spawn rather
 * than trusting the CLI to self-report it (confirmed unreliable — see
 * spawnAndCollect's timeout docs). */
export function parseUsage(jsonlOutput: string): Omit<TaskUsage, 'durationMs'> | null {
  const events = parseJsonlEvents(jsonlOutput).filter(isTurnCompleted);
  const usage = events.at(-1)?.usage;
  if (usage == null) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens,
  };
}

function truncateForProgressLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Turn one parsed JSONL event into a short, human-readable progress line,
 * or null to skip it — the "in-between" level of detail between silence
 * and raw streaming: one line per completed step, not per token. Only
 * `item.completed` events carry anything worth showing; `thread.started`/
 * `turn.started`/`turn.completed` are structural bookkeeping the chat
 * console's own stage lines (lib/hydra-lite-run-edit.ts) already cover.
 *
 * Returns plain, undecorated text — no indent, bullet, or color. The
 * caller (hydra-lite-run-edit.ts's agentLine) is the single place that
 * decides how an agent's own words are presented, so the same event
 * looks the same whether it came from Codex or Claude's session module.
 */
export function formatCodexProgressEvent(event: unknown): string | null {
  if (event == null || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'item.completed') return null;
  const item = record['item'];
  if (item == null || typeof item !== 'object') return null;
  const itemRecord = item as Record<string, unknown>;
  const itemType = itemRecord['type'];
  if (itemType === 'agent_message') {
    const text = itemRecord['text'];
    return typeof text === 'string' ? truncateForProgressLine(text) : null;
  }
  const detail =
    (itemRecord['command'] as string | undefined) ??
    (itemRecord['path'] as string | undefined) ??
    (itemRecord['text'] as string | undefined);
  return `${String(itemType)}${detail == null ? '' : `: ${truncateForProgressLine(detail)}`}`;
}

/**
 * Spawn `cmd`/`args` and collect its output. When `timeoutMs` is given, a
 * still-running child is killed (SIGTERM, then SIGKILL if it hasn't exited
 * within 5s) and the promise rejects — the harness enforces this bound
 * itself rather than trusting Codex to self-report how long it'll take
 * (confirmed unreliable: coding agents including Codex over-predict their
 * own wall-clock runtime). When `onLine` is given, it's called with each
 * complete stdout line as it arrives (not just once at the end) — chunk
 * boundaries from a real process never line up with JSON line boundaries,
 * so this buffers a partial trailing line across `data` events and flushes
 * whatever's left when the process closes.
 */
function spawnAndCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  onLine?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuffer = '';
    const timer =
      timeoutMs == null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (onLine == null) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (timer != null) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer != null) clearTimeout(timer);
      if (onLine != null && lineBuffer.trim() !== '') onLine(lineBuffer);
      if (timedOut) {
        reject(new Error(`codex timed out after ${String(timeoutMs)}ms and was killed`));
        return;
      }
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

/** Parse one raw stdout line as a JSONL event and forward it to
 * `onProgress` as a formatted line, skipping non-JSON noise (e.g. "Reading
 * additional input from stdin...") and any event with nothing worth
 * showing. */
function bridgeProgress(onProgress: (line: string) => void): (raw: string) => void {
  return (raw: string) => {
    if (raw.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const line = formatCodexProgressEvent(event);
    if (line != null) onProgress(line);
  };
}

export interface AskResult {
  threadId: string;
  answer: string;
  usage?: TaskUsage;
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
  onProgress?: (line: string) => void,
): Promise<AskResult> {
  const [cmd, args] =
    existingThreadId == null
      ? buildAskArgs(prompt, { cwd: projectRoot })
      : buildResumeArgs(existingThreadId, prompt);
  const startedAt = Date.now();
  const output = await spawnAndCollect(
    cmd,
    args,
    projectRoot,
    undefined,
    onProgress == null ? undefined : bridgeProgress(onProgress),
  );
  const durationMs = Date.now() - startedAt;
  const threadId = existingThreadId ?? parseThreadId(output);
  if (threadId == null) {
    throw new Error('Codex did not report a thread id for this session.');
  }
  const answer = parseAgentMessage(output);
  if (answer == null) {
    throw new Error('Codex did not return an answer.');
  }
  const rawUsage = parseUsage(output);
  return { threadId, answer, usage: rawUsage == null ? undefined : { ...rawUsage, durationMs } };
}

export interface EditResult {
  threadId: string;
  summary: string;
  usage?: TaskUsage;
}

/**
 * Run an approved edit in `projectRoot`, write-enabled and sandboxed to
 * that directory — or continue `existingThreadId` with feedback from a
 * prior failed verification (lib/hydra-lite-run-edit.ts's retry loop).
 * Resuming never re-specifies `-s`/`-C`, so a retry can never land at a
 * different privilege level than the attempt that created the thread. The
 * caller is responsible for the approval check, the clean-working-tree
 * precondition, verification, and the scoped commit — this function only
 * invokes Codex. `timeoutMs`, when given, kills the Codex process if it
 * hasn't finished in time (see spawnAndCollect) rather than letting it hang
 * indefinitely, which is what happened with no timeout at all. `onProgress`,
 * when given, is called with a short line for each completed step while
 * Codex is still running (see formatCodexProgressEvent) — the chat
 * console uses this so the run doesn't go silent for minutes at a time.
 */
export async function runEdit(
  projectRoot: string,
  prompt: string,
  existingThreadId?: string,
  timeoutMs?: number,
  onProgress?: (line: string) => void,
): Promise<EditResult> {
  const [cmd, args] =
    existingThreadId == null
      ? buildEditArgs(prompt, { cwd: projectRoot })
      : buildResumeArgs(existingThreadId, prompt);
  const startedAt = Date.now();
  const output = await spawnAndCollect(
    cmd,
    args,
    projectRoot,
    timeoutMs,
    onProgress == null ? undefined : bridgeProgress(onProgress),
  );
  const durationMs = Date.now() - startedAt;
  const threadId = existingThreadId ?? parseThreadId(output);
  if (threadId == null) {
    throw new Error('Codex did not report a thread id for this session.');
  }
  const rawUsage = parseUsage(output);
  return {
    threadId,
    summary: parseAgentMessage(output) ?? '(Codex returned no summary message.)',
    usage: rawUsage == null ? undefined : { ...rawUsage, durationMs },
  };
}
