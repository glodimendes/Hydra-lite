/**
 * Hydra Lite unified command registry.
 *
 * Per docs/plan/hydra-lite-macos-plan.md: "Replace the split help/dispatch
 * definitions with one tested command registry." This module is the single
 * source of truth for Hydra Lite's REPL-facing commands (`:project`,
 * `:approve`) — one array of `{name, usage, desc, test, handler}` entries
 * from which dispatch AND displayed help both derive, so they can never
 * drift from each other (see test/hydra-command-registry.test.ts, which
 * asserts every entry's usage/desc is actually present in the generated
 * help text).
 *
 * Deliberately scoped to only the commands this milestone adds — the
 * pre-existing excluded-feature commands (`:evolve`, `:nightly`, `:forge`,
 * `:pr`, council/concierge, etc.) in lib/hydra-operator.ts and
 * lib/hydra-operator-ui.ts are untouched: additive, not a rewrite.
 *
 * Defines its own minimal `CommandRunCtx` shape (not lib/hydra-operator.ts's
 * LoopCtx/LoopState, which are module-private there) to avoid a circular
 * import — hydra-operator.ts wires this registry into its COMMAND_TABLE,
 * so this module cannot import back from it. A real LoopCtx structurally
 * satisfies CommandRunCtx (same `baseUrl`/`rl.prompt()` shape).
 */

import pc from 'picocolors';
import { request } from './hydra-utils.ts';
import {
  addProject,
  listProjects,
  useProject,
  removeProject,
  getCurrentProjectId,
  ProjectRegistryError,
} from './hydra-registry.ts';

export interface CommandRunCtx {
  baseUrl: string;
  rl: { prompt: (preserveCursor?: boolean) => void };
}

export interface HydraLiteCommandEntry {
  name: string;
  usage: string;
  desc: string;
  test: (line: string) => boolean;
  handler: (ctx: CommandRunCtx, line: string) => Promise<void> | void;
}

function splitArgs(line: string): string[] {
  return line.trim().split(/\s+/).slice(1);
}

function projectListSubcommand(): void {
  const projects = listProjects();
  const current = getCurrentProjectId();
  if (projects.length === 0) {
    console.log(pc.dim('  No registered projects.'));
    return;
  }
  for (const p of projects) {
    const marker = p.id === current ? pc.green('*') : ' ';
    console.log(`  ${marker} ${p.id}  ${pc.bold(p.name)}  ${pc.dim(p.path)}`);
  }
}

function projectAddSubcommand(rest: string[]): void {
  const targetPath = rest[0];
  if (rest.length === 0 || targetPath === '') {
    console.log(pc.red('  Usage: :project add <path>'));
    return;
  }
  const entry = addProject(targetPath);
  console.log(pc.green(`  Registered ${entry.id} (${entry.name}) at ${entry.path}`));
}

function projectUseSubcommand(rest: string[]): void {
  const id = rest[0];
  if (rest.length === 0 || id === '') {
    console.log(pc.red('  Usage: :project use <id>'));
    return;
  }
  const entry = useProject(id);
  console.log(pc.green(`  Current project set to ${entry.id} (${entry.name}).`));
}

function projectRemoveSubcommand(rest: string[]): void {
  const id = rest[0];
  if (rest.length === 0 || id === '') {
    console.log(pc.red('  Usage: :project remove <id> [--purge]'));
    return;
  }
  removeProject(id, { purge: rest.includes('--purge') });
  console.log(pc.green(`  Removed ${id}.`));
}

function handleProjectCommand(ctx: CommandRunCtx, line: string): void {
  const args = splitArgs(line);
  const sub = args.length > 0 ? args[0] : 'list';
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'list':
        projectListSubcommand();
        break;
      case 'add':
        projectAddSubcommand(rest);
        break;
      case 'use':
        projectUseSubcommand(rest);
        break;
      case 'remove':
        projectRemoveSubcommand(rest);
        break;
      default:
        console.log(pc.red(`  Unknown :project subcommand "${sub}". Use list/add/use/remove.`));
    }
  } catch (err: unknown) {
    const message = err instanceof ProjectRegistryError ? err.message : String(err);
    console.log(pc.red(`  ${message}`));
  }
  ctx.rl.prompt();
}

async function handleApproveCommand(ctx: CommandRunCtx, line: string): Promise<void> {
  const args = splitArgs(line);
  if (args.length === 0 || args[0] === '') {
    console.log(pc.red('  Usage: :approve <taskId> [projectId=<id>]'));
    ctx.rl.prompt();
    return;
  }
  const [taskId, ...rest] = args;
  const projectIdArg = rest.find((token) => token.startsWith('projectId='));
  const projectId = projectIdArg?.slice('projectId='.length);
  const route =
    projectId != null && projectId !== ''
      ? `/task/approve?projectId=${projectId}`
      : '/task/approve';
  try {
    const result = await request<{ task: Record<string, unknown> }>('POST', ctx.baseUrl, route, {
      taskId,
    });
    console.log(pc.green(`  Approved ${taskId} — status now "${String(result.task['status'])}".`));
  } catch (err: unknown) {
    console.log(pc.red(`  ${err instanceof Error ? err.message : String(err)}`));
  }
  ctx.rl.prompt();
}

export const HYDRA_LITE_COMMANDS: HydraLiteCommandEntry[] = [
  {
    name: ':project',
    usage: ':project list|add <path>|use <id>|remove <id> [--purge]',
    desc: 'Manage the Hydra Lite macOS project registry.',
    test: (line) => line === ':project' || line.startsWith(':project '),
    handler: handleProjectCommand,
  },
  {
    name: ':approve',
    usage: ':approve <taskId> [projectId=<id>]',
    desc: 'Approve an edit task stuck at awaiting_approval, moving it to todo.',
    test: (line) => line.startsWith(':approve '),
    handler: handleApproveCommand,
  },
];
