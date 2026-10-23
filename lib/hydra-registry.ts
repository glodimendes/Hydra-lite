/**
 * Hydra Lite macOS project registry.
 *
 * Per docs/plan/hydra-lite-macos-plan.md: "The macOS-global registry stores
 * only project IDs, names, and absolute paths." Lives next to
 * recent-projects.json, in the same packaged-runtime-root directory
 * (lib/hydra-project.ts's getPackagedRuntimeRoot()) — not a new storage
 * convention.
 *
 * Lookup is by id only (not name) — `project use`/`project remove` take an
 * id; `project list` prints id + name + path so the id is always easy to
 * find. `project remove` keeps a project's `.hydra/` state on disk by
 * default (only the registry entry is dropped); pass `purge: true` to also
 * delete `.hydra/` and actually free space.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './hydra-shared/atomic-write.ts';
import { isValidProject, detectProjectName } from './hydra-project.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `process.pkg` is injected by the `pkg` bundler for packaged executables.
const HYDRA_IS_PACKAGED = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
const HYDRA_ROOT = path.resolve(__dirname, '..');

function getPackagedRuntimeRoot(): string {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
        'Hydra',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Hydra');
    default:
      return path.join(
        process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'),
        'Hydra',
      );
  }
}

const HYDRA_RUNTIME_ROOT = HYDRA_IS_PACKAGED ? getPackagedRuntimeRoot() : HYDRA_ROOT;
const DEFAULT_REGISTRY_PATH = path.join(HYDRA_RUNTIME_ROOT, 'registry.json');

/** Test-only override for the registry file path. */
let _testRegistryPath: string | null = null;

/**
 * Test-only: redirect registry reads/writes to a temp file path.
 * Pass null to restore the real path.
 */
export function _setTestRegistryPath(p: string | null): void {
  _testRegistryPath = p;
}

function activeRegistryPath(): string {
  // HYDRA_REGISTRY_PATH lets a spawned daemon subprocess (which can't see
  // this process's in-memory _testRegistryPath override) point at a
  // disposable test registry, mirroring hydra-project.ts's HYDRA_PROJECT
  // env var convention.
  return _testRegistryPath ?? process.env['HYDRA_REGISTRY_PATH'] ?? DEFAULT_REGISTRY_PATH;
}

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
}

interface RegistryFile {
  version: 1;
  current: string | null;
  projects: RegisteredProject[];
}

function createEmptyRegistry(): RegistryFile {
  return { version: 1, current: null, projects: [] };
}

function readRegistry(): RegistryFile {
  const filePath = activeRegistryPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RegistryFile> | null;
    if (parsed == null || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
      return createEmptyRegistry();
    }
    return {
      version: 1,
      current: typeof parsed.current === 'string' ? parsed.current : null,
      projects: parsed.projects,
    };
  } catch {
    return createEmptyRegistry();
  }
}

function writeRegistry(registry: RegistryFile): void {
  atomicWriteJson(activeRegistryPath(), registry);
}

/** Resolve a path to its canonical, symlink-free absolute form. */
function canonicalize(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist yet (or isn't readable) — fall back to the
    // resolved-but-not-realpath'd form so validation below still rejects it.
    return resolved;
  }
}

export class ProjectRegistryError extends Error {}

/**
 * Register a project by absolute path. Validates via isValidProject(),
 * rejects paths/names already registered (symlink-resolved, so two
 * different symlinks to the same directory can't double-register), and
 * generates an id with crypto.randomUUID() — the same mechanism already
 * used for claimToken generation in lib/daemon/write-routes.ts.
 */
export function addProject(targetPath: string, name?: string): RegisteredProject {
  const resolved = canonicalize(targetPath);
  if (!isValidProject(resolved)) {
    throw new ProjectRegistryError(
      `Not a valid project directory: ${resolved}\n` +
        'Expected one of: package.json, .git, HYDRA.md, CLAUDE.md, Cargo.toml, pyproject.toml, go.mod',
    );
  }

  const registry = readRegistry();
  if (registry.projects.some((p) => canonicalize(p.path) === resolved)) {
    throw new ProjectRegistryError(`Project path already registered: ${resolved}`);
  }

  const projectName = name ?? detectProjectName(resolved);
  if (registry.projects.some((p) => p.name === projectName)) {
    throw new ProjectRegistryError(`Project name already registered: ${projectName}`);
  }

  const entry: RegisteredProject = { id: crypto.randomUUID(), name: projectName, path: resolved };
  registry.projects.push(entry);
  registry.current ??= entry.id;
  writeRegistry(registry);
  return entry;
}

export function listProjects(): RegisteredProject[] {
  return readRegistry().projects;
}

export function getCurrentProjectId(): string | null {
  return readRegistry().current;
}

export function findProject(id: string): RegisteredProject | undefined {
  return readRegistry().projects.find((p) => p.id === id);
}

/**
 * UX-facing convenience lookup by name (case-insensitive exact match) —
 * the backend/registry stays id-only/canonical (findProject, useProject,
 * removeProject); this only exists so a human can type a project's name
 * instead of pasting its UUID, e.g. in the chat console's `/project use`.
 */
export function findProjectByName(name: string): RegisteredProject | undefined {
  const needle = name.toLowerCase();
  return readRegistry().projects.find((p) => p.name.toLowerCase() === needle);
}

/** Resolve a human-typed name or id to a registered project, name first. */
export function resolveProjectByNameOrId(nameOrId: string): RegisteredProject | undefined {
  return findProjectByName(nameOrId) ?? findProject(nameOrId);
}

/** Set the CLI's "current" project convenience pointer. The daemon never
 * depends on this — every task targets an explicit projectId. */
export function useProject(id: string): RegisteredProject {
  const registry = readRegistry();
  const entry = registry.projects.find((p) => p.id === id);
  if (!entry) throw new ProjectRegistryError(`No registered project with id: ${id}`);
  registry.current = id;
  writeRegistry(registry);
  return entry;
}

export interface RemoveProjectOptions {
  /** Also delete the project's .hydra/ state directory. Defaults to false:
   * removal only drops the registry entry, so re-adding the same path
   * later recovers its history. */
  purge?: boolean;
  /** Supplied by the caller (orchestrator-daemon-aware code) to check for
   * live work before allowing removal. Returns true if the project has any
   * in_progress/awaiting_approval task. */
  hasLiveTasks?: (projectPath: string) => boolean;
}

export function removeProject(id: string, options: RemoveProjectOptions = {}): void {
  const registry = readRegistry();
  const entry = registry.projects.find((p) => p.id === id);
  if (!entry) throw new ProjectRegistryError(`No registered project with id: ${id}`);

  if (options.hasLiveTasks?.(entry.path) === true) {
    throw new ProjectRegistryError(
      `Refusing to remove project ${id} (${entry.name}): it has an in_progress or ` +
        'awaiting_approval task. Finish or cancel it first.',
    );
  }

  registry.projects = registry.projects.filter((p) => p.id !== id);
  if (registry.current === id) {
    registry.current = registry.projects[0]?.id ?? null;
  }
  writeRegistry(registry);

  if (options.purge === true) {
    const hydraDir = path.join(entry.path, '.hydra');
    try {
      fs.rmSync(hydraDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
