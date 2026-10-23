/**
 * Hydra Lite scoped git helpers for edit-task execution.
 *
 * lib/hydra-shared/git-ops.ts's `stageAndCommit` always does `git add -A`,
 * staging the whole working tree — fine for the nightly/evolve pipelines it
 * was built for, but not for Hydra Lite: the plan requires an approved edit
 * task to "stage only task-owned files," never someone's unrelated,
 * already-dirty work. This module adds that scoped variant, reusing
 * git-ops.ts's `git()` runner (env-stripped, consistent timeout) rather
 * than reinventing process spawning.
 */

import { git } from './hydra-shared/git-ops.ts';

const HYDRA_STATE_DIR = '.hydra';

/**
 * `.hydra/` is Hydra Lite's own per-project state directory — it lives
 * inside the registered project, so it shows up as "dirty"/"changed" to
 * git unless that project's own .gitignore happens to exclude it (most
 * won't, especially freshly registered ones). It must never count toward
 * the clean-working-tree precondition, and must never be staged into a
 * task's commit — otherwise Hydra Lite's own bookkeeping JSON would get
 * swept into the user's history. This filters it out regardless of
 * whether the target project's own .gitignore already handles it.
 */
function isHydraStatePath(relativePath: string): boolean {
  return relativePath === HYDRA_STATE_DIR || relativePath.startsWith(`${HYDRA_STATE_DIR}/`);
}

/**
 * List files git considers changed (modified, added, deleted, renamed),
 * via `git status --porcelain`, excluding `.hydra/` (see above). For a
 * rename line ("R  old -> new"), only the new path is reported — that's
 * what needs to be staged.
 */
export function listChangedFiles(cwd: string): string[] {
  const result = git(['status', '--porcelain'], cwd);
  const files: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // Porcelain format: 2 status chars + 1 space + path (renames: "old -> new").
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const file = arrow === -1 ? rest : rest.slice(arrow + 4);
    if (!isHydraStatePath(file)) files.push(file);
  }
  return files;
}

/**
 * Whether the working tree is clean once `.hydra/` is disregarded — the
 * precondition `/run` checks before claiming a task, so Hydra Lite's own
 * state writes are never mistaken for the user's unrelated uncommitted
 * work.
 */
export function isWorkingTreeCleanIgnoringHydraState(cwd: string): boolean {
  return listChangedFiles(cwd).length === 0;
}

export interface ScopedCommitResult {
  sha: string;
}

/**
 * Stage exactly `files` (never `-A`) and make exactly one commit. Throws if
 * staging or committing fails, or if `files` is empty (nothing to commit —
 * callers should check `listChangedFiles` first and skip committing
 * entirely when Codex made no changes, rather than calling this).
 */
export function stageAndCommitFiles(
  cwd: string,
  files: string[],
  message: string,
): ScopedCommitResult {
  if (files.length === 0) {
    throw new Error('stageAndCommitFiles: no files to stage.');
  }
  const add = git(['add', '--', ...files], cwd);
  if (add.status !== 0) {
    throw new Error(
      `git add failed: ${add.stderr.trim() === '' ? `exit ${String(add.status)}` : add.stderr.trim()}`,
    );
  }
  const commit = git(['commit', '-m', message], cwd);
  if (commit.status !== 0) {
    throw new Error(
      `git commit failed: ${commit.stderr.trim() === '' ? `exit ${String(commit.status)}` : commit.stderr.trim()}`,
    );
  }
  const sha = git(['rev-parse', 'HEAD'], cwd);
  return { sha: sha.stdout.trim() };
}
