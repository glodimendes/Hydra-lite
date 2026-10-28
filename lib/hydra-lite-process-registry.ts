/**
 * Tracks every CLI child process this program has spawned (a Codex or
 * Claude `exec`/`-p` invocation — hydra-lite-codex-session.ts /
 * hydra-lite-claude-session.ts), so a single shutdown path can guarantee
 * none of them outlives this process.
 *
 * Node does not tie a spawned child's lifetime to its parent's. Confirmed
 * hands-on: killing the chat console (`kill -INT` on its pid, simulating
 * what happens if something stops Hydra Lite by process rather than by
 * closing the whole terminal) left its `codex exec` child running —
 * reparented to pid 1, completely outside Hydra Lite's approval/verify/
 * commit pipeline, for as long as it felt like continuing. This module
 * closes that gap. Both lib/hydra-lite-chat.ts and lib/hydra-lite-
 * worker.ts install its kill functions via process signal/exit handlers
 * at startup — any new entry point that can spawn a CLI child must do
 * the same.
 */

import type { ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();

/** Register a freshly spawned child. It's removed automatically once it
 * exits on its own — the common case, since almost every invocation
 * finishes long before the process itself does; this registry only
 * matters for the ones that don't. */
export function registerChild(child: ChildProcess): void {
  children.add(child);
  child.once('exit', () => {
    children.delete(child);
  });
}

function signalAll(signal: NodeJS.Signals): void {
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Kill every still-registered child before this process exits: SIGTERM
 * first, then give them `graceMs` to exit on their own, then SIGKILL
 * whatever's left — the same two-step shutdown hydra-lite-codex-
 * session.ts's spawnAndCollect already uses for its own per-invocation
 * timeout, just applied process-wide. Only usable from a context that
 * can await (a SIGINT/SIGTERM handler, or readline's 'close' handler) —
 * a process 'exit' handler can't do async work, so it uses
 * killAllChildrenSync instead.
 */
export async function killAllChildren(graceMs = 3000): Promise<void> {
  if (children.size === 0) return;
  signalAll('SIGTERM');
  await new Promise((resolve) => {
    setTimeout(resolve, graceMs);
  });
  signalAll('SIGKILL');
}

/** Synchronous last-resort cleanup for a process 'exit' handler —
 * reached by anything that bypasses the graceful path above (an
 * uncaught exception, or simply as a backstop after it already ran and
 * emptied the registry, in which case this is a harmless no-op). No
 * time to wait for an exit, so this goes straight to SIGKILL. */
export function killAllChildrenSync(): void {
  signalAll('SIGKILL');
}

/** Exposed for tests only. */
export function registeredChildCountForTests(): number {
  return children.size;
}
