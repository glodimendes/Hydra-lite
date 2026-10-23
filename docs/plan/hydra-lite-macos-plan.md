# Hydra Lite for macOS — Working Plan

## Goal

Build a lean, reliable, terminal-only macOS edition from Hydra's current codebase.
It runs Codex first, manages multiple local Git projects through one daemon, and
makes repository-changing work explicitly approved, verified, and locally
committed.

## Product boundaries for v0.1.0

- Codex is the only runtime agent.
- One local daemon manages multiple registered Git projects.
- At most two tasks run globally, and at most one runs in each project.
- Every project keeps task state, logs, approvals, and output in ignored
  `.hydra/` storage.
- The macOS-global registry stores only project IDs, names, and absolute paths.
- Tasks are read-only by default. An edit task must be explicitly approved
  before Codex is started.
- An approved edit task must verify its result, stage only task-owned files,
  and make exactly one local commit. Hydra Lite never pushes, merges, opens
  pull requests, or includes unrelated changes.
- Codex routing is deterministic and local: `low`, `balanced`, and `high`,
  with a per-task `auto|low|balanced|high` override. Edit tasks cannot use a
  tier below `balanced`.

## Explicit exclusions

The initial release excludes the web UI, council, concierge, evolve/nightly
workflows, Git worktrees, Windows support, Claude, and Gemini.

## Implementation direction

1. Replace single-project resolution with a macOS registry and project-scoped
   daemon contexts.
2. Move newly created runtime state from `docs/coordination/` to each
   project's `.hydra/`, preserving a one-time legacy import path.
3. Introduce lean task records with immutable project IDs, effect (`read` or
   `edit`), approval data, resolved tier, verification result, changed-file
   manifest, attempt history, and optional local commit SHA.
4. Use a Codex-only shared worker pool that enforces global and per-project
   concurrency limits.
5. Replace the split help/dispatch definitions with one tested command
   registry for projects, tasks, approvals, workers, status/usage, and quit.
6. Isolate the Codex executor from the task and state APIs so future runtimes
   can be added without changing the safety model.
7. Add task-scoped verification and local-commit safety only after the
   scheduling and approval core is proven.

## First testable milestone: Lean safety spine

Deliver registered-project read-only scheduling and the edit approval gate.

### Included

- macOS project registry and `project add/list/use/remove` commands;
- per-project, atomically persisted `.hydra/` state;
- one local daemon serving two registered disposable Git repositories;
- Codex-only read-only task execution;
- two-task global and one-task-per-project limits;
- edit tasks stopping at `awaiting_approval`, before Codex starts; and
- a compact command registry whose tested commands generate the displayed
  help.

### Acceptance test

Register two temporary Git repositories and queue three read-only tasks. One
task in each project runs concurrently while the third remains queued. Restart
the daemon and confirm task histories stay isolated. Queue an edit task and
confirm it remains `awaiting_approval` with no Codex process launched.

## Baseline

This plan begins from upstream Hydra commit `20afb5e` on branch
`hydra-lite-macos`. The branch is tracked in the owner's fork; upstream is
used only as a reference for the original project.
