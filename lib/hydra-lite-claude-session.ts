/**
 * Hydra Lite chat console — Claude Code session plumbing.
 *
 * Mirrors lib/hydra-lite-codex-session.ts's shape (`runAsk`/`runEdit`,
 * pure argv-builders, resume-by-id) so lib/hydra-lite-run-edit.ts can
 * dispatch to either module through the same interface. The two CLIs
 * differ in how they're invoked, so this is a parallel implementation,
 * not a shared base class:
 *
 * - Codex's `exec --json` prints one JSONL event per line; Claude Code's
 *   `-p --output-format json` prints exactly one JSON object for the whole
 *   run (confirmed hands-on: even an error — e.g. an expired OAuth
 *   session — comes back as a well-formed object with `is_error: true`
 *   and the message in `result`, exit code nonzero). So this module parses
 *   that single object rather than reusing Codex's JSONL parser, and never
 *   rejects on exit code alone — `is_error` is the actual signal.
 * - Claude Code resumes a session with `-r <sessionId>` (or `--resume`);
 *   unlike Codex's `exec resume`, cwd is passed as the resumed thread's
 *   project root is already fixed by the session's own working directory.
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
 * NEEDS LIVE VERIFICATION before this module is trusted: written against
 * `claude --help` only, blocked on the installed `claude` CLI's own OAuth
 * session being expired (unrelated to Hydra Lite — fix with a normal
 * `claude` login). In particular: whether `-r` accepts a fresh
 * `--permission-mode` on resume, and whether `plan` mode answers a plain
 * question instead of only ever proposing a plan.
 */

import { spawn } from 'node:child_process';

/** Start a new, read-only Claude session. Always `--permission-mode plan`
 * — the whole safety guarantee for chat Q&A rests on this, same role as
 * Codex's `-s read-only`. Unlike Codex's `buildAskArgs`, there's no `-C`
 * here: Claude Code takes its project root from the spawned process's own
 * cwd, which the caller (runAsk) sets via spawnAndCollect. */
export function buildAskArgs(prompt: string): [string, string[]] {
  return ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan']];
}

/** Continue an existing read-only session. */
export function buildAskResumeArgs(sessionId: string, prompt: string): [string, string[]] {
  return [
    'claude',
    ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '-r', sessionId],
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
      'json',
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
      'json',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '-r',
      sessionId,
    ],
  ];
}

interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

export function parseResultJson(stdout: string): ClaudeResultJson | null {
  try {
    return JSON.parse(stdout.trim()) as ClaudeResultJson;
  } catch {
    return null;
  }
}

/**
 * Spawn `cmd`/`args` and collect its output, resolving regardless of exit
 * code — Claude Code's `--output-format json` reports failure (e.g. an
 * expired OAuth session) as `is_error: true` inside a well-formed JSON
 * object on stdout, not by omitting output, so the caller decides success
 * from that object instead of from the process exit code. When `timeoutMs`
 * is given, a still-running child is killed (SIGTERM, then SIGKILL after
 * 5s) and the promise rejects, same bound as hydra-lite-codex-session.ts.
 */
function spawnAndCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
}

/**
 * Ask Claude a read-only question in `projectRoot`, continuing
 * `existingThreadId` if one is already open for this project, or starting
 * a fresh one otherwise. `threadId` here is Claude Code's own session id.
 */
export async function runAsk(
  projectRoot: string,
  prompt: string,
  existingThreadId?: string,
): Promise<AskResult> {
  const [cmd, args] =
    existingThreadId == null ? buildAskArgs(prompt) : buildAskResumeArgs(existingThreadId, prompt);
  const output = await spawnAndCollect(cmd, args, projectRoot);
  const parsed = parseResultJson(output);
  if (parsed == null) {
    throw new Error(`claude returned non-JSON output: ${output.slice(0, 500)}`);
  }
  if (parsed.is_error === true || parsed.result == null) {
    throw new Error(parsed.result ?? 'claude reported an error with no message.');
  }
  const threadId = existingThreadId ?? parsed.session_id;
  if (threadId == null) {
    throw new Error('Claude did not report a session id for this session.');
  }
  return { threadId, answer: parsed.result };
}

export interface EditResult {
  threadId: string;
  summary: string;
}

/**
 * Run an approved edit in `projectRoot`, write-enabled and sandboxed to
 * that directory — or continue `existingThreadId` with feedback from a
 * prior failed verification (lib/hydra-lite-run-edit.ts's retry loop). The
 * caller is responsible for the approval check, the clean-working-tree
 * precondition, verification, and the scoped commit — this function only
 * invokes Claude. `timeoutMs`, when given, kills the process if it hasn't
 * finished in time (see spawnAndCollect) rather than letting it hang.
 */
export async function runEdit(
  projectRoot: string,
  prompt: string,
  existingThreadId?: string,
  timeoutMs?: number,
): Promise<EditResult> {
  const [cmd, args] =
    existingThreadId == null
      ? buildEditArgs(prompt)
      : buildEditResumeArgs(existingThreadId, prompt);
  const output = await spawnAndCollect(cmd, args, projectRoot, timeoutMs);
  const parsed = parseResultJson(output);
  if (parsed == null) {
    throw new Error(`claude returned non-JSON output: ${output.slice(0, 500)}`);
  }
  if (parsed.is_error === true || parsed.result == null) {
    throw new Error(parsed.result ?? 'claude reported an error with no message.');
  }
  const threadId = existingThreadId ?? parsed.session_id;
  if (threadId == null) {
    throw new Error('Claude did not report a session id for this session.');
  }
  return { threadId, summary: parsed.result };
}
