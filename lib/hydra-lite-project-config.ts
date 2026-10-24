/**
 * Hydra Lite per-project config override — `.hydra/config.json`.
 *
 * The macOS-global registry (lib/hydra-registry.ts) deliberately stores
 * only {id, name, path} — nothing else. A setting that doesn't belong in
 * that global file, but is specific to one registered project, lives here
 * instead, inside the project's own `.hydra/` directory (the same storage
 * convention as its task state).
 *
 * Only `verification` is supported for now: a project can override the
 * verify command (and/or timeout) that lib/hydra-verification.ts's
 * resolveVerificationPlan() would otherwise auto-detect from its own
 * package.json. This layers that override on top of the global
 * hydra.config.json's own `verification` section and delegates to
 * resolveVerificationPlan() for the actual disabled-command / shell-safety
 * / auto-detection logic — not a reimplementation of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './hydra-shared/atomic-write.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { loadHydraConfig } from './hydra-config.ts';
import type { VerificationPlan } from './types.ts';

export interface ProjectVerificationOverride {
  command?: string;
  timeoutMs?: number;
}

export interface HydraLiteProjectConfig {
  verification?: ProjectVerificationOverride;
  /** Overrides DEFAULT_TASK_TIMEOUT_MINUTES (lib/hydra-lite-run-edit.ts) for
   * this project's own Codex edit attempts — a bigger/slower project can
   * raise its own budget without changing the global default. */
  taskTimeoutMinutes?: number;
}

/** Hard default for how long one Codex edit attempt may run before the
 * worker/`/run` kills it and treats it as a failed attempt. Grounded in
 * production CI/CD conventions (GitHub Actions' per-job default is 360
 * minutes, GitLab CI's is commonly ~60) scaled down for a single attempt,
 * and in observed agentic-coding practice (one real project settled on a
 * single ~30-minute global default after per-task tiers proved to be
 * maintenance overhead not worth the precision). */
export const DEFAULT_TASK_TIMEOUT_MINUTES = 30;

function configPath(projectRoot: string): string {
  return path.join(projectRoot, '.hydra', 'config.json');
}

/** Read `.hydra/config.json`. Missing or malformed is just "no overrides" —
 * never throws, since this file is optional. */
export function loadProjectConfig(projectRoot: string): HydraLiteProjectConfig {
  try {
    const raw = fs.readFileSync(configPath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object') return {};
    return parsed as HydraLiteProjectConfig;
  } catch {
    return {};
  }
}

/** Set (merge) or clear (pass null) the project's verification override. */
export function saveProjectVerificationOverride(
  projectRoot: string,
  override: ProjectVerificationOverride | null,
): void {
  const current = loadProjectConfig(projectRoot);
  const next: HydraLiteProjectConfig = { ...current };
  if (override == null) {
    delete next.verification;
  } else {
    next.verification = { ...current.verification, ...override };
  }
  atomicWriteJson(configPath(projectRoot), next);
}

/** Set (override) or clear (pass null) the project's per-attempt Codex
 * edit timeout, in minutes. */
export function saveProjectTaskTimeoutOverride(projectRoot: string, minutes: number | null): void {
  const current = loadProjectConfig(projectRoot);
  const next: HydraLiteProjectConfig = { ...current };
  if (minutes == null) {
    delete next.taskTimeoutMinutes;
  } else {
    next.taskTimeoutMinutes = minutes;
  }
  atomicWriteJson(configPath(projectRoot), next);
}

/** Effective per-attempt Codex edit timeout for `projectRoot`, in
 * milliseconds: the project's own override if set, else
 * DEFAULT_TASK_TIMEOUT_MINUTES. */
export function resolveProjectTaskTimeoutMs(projectRoot: string): number {
  const minutes = loadProjectConfig(projectRoot).taskTimeoutMinutes ?? DEFAULT_TASK_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/**
 * Resolve the effective verification plan for `projectRoot`: the
 * project's own `.hydra/config.json` override (if any) wins field-by-field
 * over the global hydra.config.json's `verification` section, which in
 * turn falls back to auto-detection — exactly resolveVerificationPlan()'s
 * existing precedence, just given a merged config object instead of the
 * bare global one.
 */
export function resolveProjectVerificationPlan(projectRoot: string): VerificationPlan {
  const globalConfig = loadHydraConfig() as Record<string, unknown>;
  const override = loadProjectConfig(projectRoot).verification;
  if (override == null) {
    return resolveVerificationPlan(projectRoot, globalConfig);
  }
  const globalVerification =
    globalConfig['verification'] != null && typeof globalConfig['verification'] === 'object'
      ? (globalConfig['verification'] as Record<string, unknown>)
      : {};
  const mergedConfig = {
    ...globalConfig,
    verification: { ...globalVerification, ...override },
  };
  return resolveVerificationPlan(projectRoot, mergedConfig);
}
