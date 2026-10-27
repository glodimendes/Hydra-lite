/**
 * Hydra Lite chat console — Claude Code session plumbing.
 *
 * Mirrors lib/hydra-lite-codex-session.ts's shape (`runAsk`/`runEdit`,
 * pure argv-builders, resume-by-id, incremental progress streaming) so
 * lib/hydra-lite-run-edit.ts can dispatch to either module through the
 * same interface. The two CLIs differ in how they're invoked, so this is
 * a parallel implementation, not a shared base class:
 *
 * - `--output-format stream-json` (with `--verbose`, which Claude Code
 *   requires alongside it in print mode) prints one JSON object per line
 *   as the run happens — an `assistant` message per completed step, then
 *   a final `result` object with `is_error`/`result`/`session_id`/`usage`/
 *   `total_cost_usd` — mirroring Codex's JSONL shape closely enough that
 *   this module parses it the same way (parseJsonlEvents, take the last
 *   `result` event), rather than parsing one whole-stdout JSON object the
 *   way an earlier version of this module did against plain
 *   `--output-format json`.
 * - Never rejects on exit code alone: Claude Code reports failure (e.g.
 *   an expired OAuth session — confirmed hands-on against plain
 *   `--output-format json`, before this module switched to stream-json)
 *   as `is_error: true` inside a well-formed result object, not by
 *   omitting output.
 * - Claude Code resumes a session with `-r <sessionId>` (or `--resume`);
 *   unlike Codex's `exec resume`, cwd isn't re-specified — it's the
 *   spawned process's own cwd, same as a fresh run.
 * - Read-only Q&A uses `--permission-mode plan`: Claude can read/search
 *   the project but any tool call that would change it is held back,
 *   mirroring Codex's `-s read-only` sandbox (process-level there,
 *   permission-mode here — Claude Code has no OS sandbox flag of its
 *   own). Edit execution uses `--permission-mode acceptEdits` (file edits
 *   proceed without a prompt) plus `--permission-prompts none` (anything
 *   else that would still need a prompt is denied outright rather than
 *   hanging forever with no TTY to answer it) — sandboxed to `cwd` the
 *   same way Codex's `-s workspace-write` is, since neither flag widens
 *   tool access beyond the working directory.
 *
 * NEEDS LIVE VERIFICATION before this module is trusted: the stream-json
 * shape above is written from documented CLI behavior, not a captured
 * real run — blocked on the installed `claude` CLI's own OAuth session
 * being expired/unrefreshable (unrelated to Hydra Lite; fix with a normal
 * `claude` login). In particular: whether `-r` accepts a fresh
 * `--permission-mode` on resume, whether `plan` mode answers a plain
 * question instead of only ever proposing a plan, and whether a
 * stream-json run's error path still ends in one `result` event the same
 * way a successful one does. parseResult's fallback (re-parsing the whole
 * trimmed stdout as a single JSON object when no JSONL `result` event is
 * found) exists specifically to hedge against that last unknown.
 */

import { spawn } from 'node:child_process';
import { registerChild } from './hydra-lite-process-registry.ts';
import type { TaskUsage } from './types.ts';

/** Start a new, read-only Claude session. Always `--permission-mode plan`
 * — the whole safety guarantee for chat Q&A rests on this, same role as
 * Codex's `-s read-only`. Unlike Codex's `buildAskArgs`, there's no `-C`
 * here: Claude Code takes its project root from the spawned process's own
 * cwd, which the caller (runAsk) sets via spawnAndCollect. */
export function buildAskArgs(prompt: string): [string, string[]] {
  return [
    'claude',
    ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'],
  ];
}

/** Continue an existing read-only session. */
export function buildAskResumeArgs(sessionId: string, prompt: string): [string, string[]] {
  return [
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
      '-r',
      sessionId,
    ],
  ];
}

/** Start a new, write-enabled Claude session, sandboxed to the spawned
 * process's own cwd (never widened with `--add-dir`). Always `acceptEdits`
 * + `--permission-prompts none` — never `--dangerously-skip-permissions`
 * or `-w/--worktree` (Git worktrees are excluded from Hydra Lite). */
export function buildEditArgs(prompt: string): [string, string[]] {
  return [
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
    ],
  ];
}

/** Continue an existing write-enabled session. */
export function buildEditResumeArgs(sessionId: string, prompt: string): [string, string[]] {
  return [
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '-r',
      sessionId,
    ],
  ];
}

interface ResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function isResultEvent(event: unknown): event is ResultEvent {
  return (
    event != null &&
    typeof event === 'object' &&
    (event as Record<string, unknown>)['type'] === 'result'
  );
}

function parseJsonlEvents(output: string): unknown[] {
  const events: unknown[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* non-JSON noise — skip */
    }
  }
  return events;
}

/** Extract the run's final result object: the last JSONL `result` event,
 * or — hedging against stream-json's error path not matching the
 * documented shape, unverified — the whole trimmed stdout parsed as one
 * JSON object, if that itself looks like a result. */
function parseResult(output: string): ResultEvent | null {
  const events = parseJsonlEvents(output).filter(isResultEvent);
  const last = events.at(-1);
  if (last != null) return last;
  try {
    const whole: unknown = JSON.parse(output.trim());
    return isResultEvent(whole) ? whole : null;
  } catch {
    return null;
  }
}

/** Extract token usage (and dollar cost, which Claude reports and Codex
 * doesn't) from the run's result object. `durationMs` isn't part of
 * this — the caller measures real wall-clock time around the spawn. */
export function parseUsage(output: string): Omit<TaskUsage, 'durationMs'> | null {
  const result = parseResult(output);
  if (result?.usage == null) return null;
  return {
    inputTokens: result.usage.input_tokens ?? 0,
    outputTokens: result.usage.output_tokens ?? 0,
    cachedInputTokens: result.usage.cache_read_input_tokens,
    costUsd: result.total_cost_usd,
  };
}

function truncateForProgressLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Format one content block from an `assistant` event — a text chunk or a
 * tool call — as plain, undecorated text, or null to skip it. No indent,
 * bullet, or color: the caller (hydra-lite-run-edit.ts's agentLine) is
 * the single place that decides how an agent's own words are presented,
 * so the same kind of step looks the same whether it came from Claude or
 * Codex's session module.
 */
function formatContentBlock(block: unknown): string | null {
  if (block == null || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim() !== '') {
    return truncateForProgressLine(b['text']);
  }
  if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
    return `tool_use: ${b['name']}`;
  }
  return null;
}

/**
 * Turn one parsed JSONL event into zero or more short, human-readable
 * progress lines — the same "in-between" level of detail as
 * hydra-lite-codex-session.ts's formatCodexProgressEvent: one line per
 * completed step (an assistant message, a tool call), never raw
 * per-token deltas. Only `assistant` events carry anything worth
 * showing; `system`/`user`(tool-result)/`result` are bookkeeping the
 * chat console's own stage lines already cover. Returns an array (not a
 * single joined string) so a message with several blocks becomes several
 * separately-decorated lines rather than one block of text with only the
 * first line tagged.
 */
export function formatClaudeProgressEvent(event: unknown): string[] {
  if (event == null || typeof event !== 'object') return [];
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'assistant') return [];
  const message = record['message'];
  if (message == null || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return [];
  return content.map(formatContentBlock).filter((line): line is string => line != null);
}

/** Parse one raw stdout line as a JSONL event and forward each of its
 * formatted progress lines to `onProgress` individually, skipping
 * non-JSON noise and any event with nothing worth showing. */
function bridgeProgress(onProgress: (line: string) => void): (raw: string) => void {
  return (raw: string) => {
    if (raw.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    for (const line of formatClaudeProgressEvent(event)) onProgress(line);
  };
}

/**
 * Spawn `cmd`/`args` and collect its output, resolving regardless of exit
 * code — Claude Code reports failure (e.g. an expired OAuth session)
 * inside a well-formed result object on stdout, not by omitting output,
 * so the caller decides success from that object instead of from the
 * process exit code. Registers the child with hydra-lite-process-
 * registry.ts so it's killed too if this program's own process exits
 * while the child is still running — Node doesn't do that on its own.
 * When `onLine` is given, it's called with each complete stdout line as
 * it arrives, same streaming behavior as hydra-lite-codex-session.ts's
 * spawnAndCollect. When `timeoutMs` is given, a still-running child is
 * killed (SIGTERM, then SIGKILL after 5s) and the promise rejects.
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
    registerChild(child);
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
    child.on('close', () => {
      if (timer != null) clearTimeout(timer);
      if (onLine != null && lineBuffer.trim() !== '') onLine(lineBuffer);
      if (timedOut) {
        reject(new Error(`claude timed out after ${String(timeoutMs)}ms and was killed`));
        return;
      }
      if (stdout.trim() === '') {
        reject(new Error(stderr.trim() === '' ? 'claude produced no output' : stderr.trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface AskResult {
  threadId: string;
  answer: string;
  usage?: TaskUsage;
}

/**
 * Ask Claude a read-only question in `projectRoot`, continuing
 * `existingThreadId` if one is already open for this project, or starting
 * a fresh one otherwise. `threadId` here is Claude Code's own session id.
 * `onProgress`, when given, is called with a short line for each
 * completed step while Claude is still running.
 */
export async function runAsk(
  projectRoot: string,
  prompt: string,
  existingThreadId?: string,
  onProgress?: (line: string) => void,
): Promise<AskResult> {
  const [cmd, args] =
    existingThreadId == null ? buildAskArgs(prompt) : buildAskResumeArgs(existingThreadId, prompt);
  const startedAt = Date.now();
  const output = await spawnAndCollect(
    cmd,
    args,
    projectRoot,
    undefined,
    onProgress == null ? undefined : bridgeProgress(onProgress),
  );
  const durationMs = Date.now() - startedAt;
  const result = parseResult(output);
  if (result == null) {
    throw new Error(`claude returned no result object: ${output.slice(0, 500)}`);
  }
  if (result.is_error === true || result.result == null) {
    throw new Error(result.result ?? 'claude reported an error with no message.');
  }
  const threadId = existingThreadId ?? result.session_id;
  if (threadId == null) {
    throw new Error('Claude did not report a session id for this session.');
  }
  const rawUsage = parseUsage(output);
  return {
    threadId,
    answer: result.result,
    usage: rawUsage == null ? undefined : { ...rawUsage, durationMs },
  };
}

export interface EditResult {
  threadId: string;
  summary: string;
  usage?: TaskUsage;
}

/**
 * Run an approved edit in `projectRoot`, write-enabled and sandboxed to
 * that directory — or continue `existingThreadId` with feedback from a
 * prior failed verification (lib/hydra-lite-run-edit.ts's retry loop). The
 * caller is responsible for the approval check, the clean-working-tree
 * precondition, verification, and the scoped commit — this function only
 * invokes Claude. `timeoutMs`, when given, kills the process if it hasn't
 * finished in time (see spawnAndCollect) rather than letting it hang.
 * `onProgress`, when given, is called with a short line for each
 * completed step while Claude is still running.
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
      ? buildEditArgs(prompt)
      : buildEditResumeArgs(existingThreadId, prompt);
  const startedAt = Date.now();
  const output = await spawnAndCollect(
    cmd,
    args,
    projectRoot,
    timeoutMs,
    onProgress == null ? undefined : bridgeProgress(onProgress),
  );
  const durationMs = Date.now() - startedAt;
  const result = parseResult(output);
  if (result == null) {
    throw new Error(`claude returned no result object: ${output.slice(0, 500)}`);
  }
  if (result.is_error === true || result.result == null) {
    throw new Error(result.result ?? 'claude reported an error with no message.');
  }
  const threadId = existingThreadId ?? result.session_id;
  if (threadId == null) {
    throw new Error('Claude did not report a session id for this session.');
  }
  const rawUsage = parseUsage(output);
  return {
    threadId,
    summary: result.result,
    usage: rawUsage == null ? undefined : { ...rawUsage, durationMs },
  };
}
