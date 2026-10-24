/**
 * Hydra Lite project registry CLI — terminal-only, no daemon or REPL
 * required.
 *
 * Subcommands:
 *   add <path> [name=...]   — Register a Git project by absolute path
 *   list                    — List registered projects (id, name, path)
 *   use <id>                — Set the CLI's "current project" convenience pointer
 *   remove <id> [--purge]   — Unregister a project; --purge also deletes .hydra/
 *   priority <id> <n>       — Set a project's worker scheduling priority (default 0)
 *
 * Usage:
 *   node lib/hydra-project-cli.ts add /path/to/repo
 *   node lib/hydra-project-cli.ts list
 *   node lib/hydra-project-cli.ts use <id>
 *   node lib/hydra-project-cli.ts remove <id>
 *   node lib/hydra-project-cli.ts remove <id> --purge
 *   node lib/hydra-project-cli.ts priority <id> <n>
 */

import pc from 'picocolors';
import { parseArgsWithCommand, getOption } from './hydra-utils.ts';
import {
  addProject,
  listProjects,
  useProject,
  removeProject,
  setProjectPriority,
  getCurrentProjectId,
  ProjectRegistryError,
} from './hydra-registry.ts';

function printUsage(): void {
  console.error(
    'Usage: hydra-project-cli.ts [add <path>|list|use <id>|remove <id> [--purge]|priority <id> <n>]',
  );
}

function addCommand(positionals: string[], options: Record<string, string | boolean>): void {
  const targetPath = positionals[0];
  if (positionals.length === 0 || targetPath === '') {
    console.error(pc.red('Usage: project add <path> [name=...]'));
    process.exitCode = 1;
    return;
  }
  const name = getOption(options, 'name', '');
  const entry = addProject(targetPath, name === '' ? undefined : name);
  console.log(pc.green(`Registered project ${entry.id} (${entry.name}) at ${entry.path}`));
}

function listCommand(): void {
  const projects = listProjects();
  const current = getCurrentProjectId();
  if (projects.length === 0) {
    console.log(pc.dim('No registered projects.'));
    return;
  }
  for (const p of projects) {
    const marker = p.id === current ? pc.green('*') : ' ';
    console.log(`${marker} ${p.id}  ${pc.bold(p.name)}  ${pc.dim(p.path)}`);
  }
}

function useCommand(positionals: string[]): void {
  const id = positionals[0];
  if (positionals.length === 0 || id === '') {
    console.error(pc.red('Usage: project use <id>'));
    process.exitCode = 1;
    return;
  }
  const entry = useProject(id);
  console.log(pc.green(`Current project set to ${entry.id} (${entry.name}).`));
}

function removeCommand(positionals: string[], options: Record<string, string | boolean>): void {
  const id = positionals[0];
  if (positionals.length === 0 || id === '') {
    console.error(pc.red('Usage: project remove <id> [--purge]'));
    process.exitCode = 1;
    return;
  }
  const purge = options['purge'] === true;
  removeProject(id, { purge });
  console.log(pc.green(`Removed project ${id}${purge ? ' (and deleted its .hydra/ state)' : ''}.`));
}

function priorityCommand(positionals: string[]): void {
  const id = positionals.at(0);
  const rawValue = positionals.at(1);
  const value = rawValue == null ? Number.NaN : Number.parseInt(rawValue, 10);
  if (id == null || id === '' || !Number.isFinite(value)) {
    console.error(pc.red('Usage: project priority <id> <n>'));
    process.exitCode = 1;
    return;
  }
  const entry = setProjectPriority(id, value);
  console.log(pc.green(`${entry.name} priority is now ${String(entry.priority)}.`));
}

function main(): void {
  const { command, options, positionals } = parseArgsWithCommand(process.argv);

  try {
    switch (command) {
      case 'add':
        addCommand(positionals, options);
        break;
      case 'list':
        listCommand();
        break;
      case 'use':
        useCommand(positionals);
        break;
      case 'remove':
        removeCommand(positionals, options);
        break;
      case 'priority':
        priorityCommand(positionals);
        break;
      case 'help':
        printUsage();
        break;
      default:
        console.error(pc.red(`Unknown command: ${command}`));
        printUsage();
        process.exitCode = 1;
    }
  } catch (err: unknown) {
    const message = err instanceof ProjectRegistryError ? err.message : String(err);
    console.error(pc.red(message));
    process.exitCode = 1;
  }
}

main();
