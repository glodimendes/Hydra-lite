/**
 * Daemon state management: read/write HydraStateShape, event log, and coord
 * files. Extracted from orchestrator-daemon.ts for focused reuse.
 *
 * `createProjectState(handle)` is a factory that binds all of this to one
 * project's `.hydra/` paths (and its own, isolated event-sequence counter) —
 * this is what lets the daemon serve multiple Hydra Lite registry projects
 * from one process (see orchestrator-daemon.ts's `ProjectRuntime` map). The
 * module-level exports below (`readState`, `writeState`, etc.) are kept
 * working exactly as before — a single legacy instance bound to
 * `resolveProject()`'s module-load-time result — so every existing
 * single-project caller and test is unaffected; this is additive, not a
 * breaking rename.
 */

import fs from 'node:fs';
import { resolveProject } from '../hydra-config.ts';
import type {
  HydraStateShape,
  TaskEntry,
  HandoffEntry,
  BlockerEntry,
  DecisionEntry,
} from '../types.ts';

const config = resolveProject();

// ── Types ──────────────────────────────────────────────────────────────────

export type EventRecord = {
  seq: number;
  at: string;
  type: string;
  category?: string;
  payload?: unknown;
};

export interface ProjectStateHandle {
  coordDir: string;
  statePath: string;
  logPath: string;
  eventsPath: string;
  projectName: string;
}

export interface ProjectStateApi {
  ensureCoordFiles: () => void;
  readState: () => HydraStateShape;
  writeState: (state: Record<string, unknown>) => HydraStateShape;
  appendSyncLog: (entry: string) => void;
  getEventSeq: () => number;
  resetEventSeq: () => void;
  initEventSeq: () => void;
  appendEvent: (type: string, payload?: unknown, id?: string) => void;
  replayEvents: (fromSeq?: number) => EventRecord[];
}

// ── Timestamp helpers ──────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

export function toSessionId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SYNC_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// ── State factories ────────────────────────────────────────────────────────

export function createAgentRecord(): {
  installed: null;
  path: string;
  version: string;
  lastCheckedAt: null;
} {
  return {
    installed: null,
    path: '',
    version: '',
    lastCheckedAt: null,
  };
}

export function createDefaultState(projectName: string = config.projectName): HydraStateShape {
  return {
    schemaVersion: 1,
    project: projectName,
    updatedAt: nowIso(),
    activeSession: null,
    agents: {
      gemini: createAgentRecord(),
      codex: createAgentRecord(),
      claude: createAgentRecord(),
    },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
    deadLetter: [],
  };
}

export function normalizeState(
  raw: unknown,
  projectName: string = config.projectName,
): HydraStateShape {
  const defaults = createDefaultState(projectName);
  const safe = (raw != null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  return {
    ...defaults,
    ...safe,
    agents: {
      ...(defaults.agents as Record<string, unknown>),
      ...((safe['agents'] ?? {}) as Record<string, unknown>),
    },
    tasks: Array.isArray(safe['tasks']) ? (safe['tasks'] as TaskEntry[]) : [],
    decisions: Array.isArray(safe['decisions']) ? (safe['decisions'] as DecisionEntry[]) : [],
    blockers: Array.isArray(safe['blockers']) ? (safe['blockers'] as BlockerEntry[]) : [],
    handoffs: Array.isArray(safe['handoffs']) ? (safe['handoffs'] as HandoffEntry[]) : [],
    deadLetter: Array.isArray(safe['deadLetter']) ? safe['deadLetter'] : [],
    childSessions: Array.isArray(safe['childSessions']) ? safe['childSessions'] : [],
  };
}

export function categorizeEvent(type: string, payload: unknown): string {
  if (type === 'mutation') {
    const label =
      ((payload as Record<string, unknown>)['label'] as string | null | undefined) ?? '';
    if (label.startsWith('task:')) return 'task';
    if (label.startsWith('handoff:')) return 'handoff';
    if (label.startsWith('decision:')) return 'decision';
    if (label.startsWith('blocker:')) return 'blocker';
    if (label.startsWith('session:')) return 'session';
  }
  if (type === 'daemon_start' || type === 'daemon_stop' || type === 'auto_archive') return 'system';
  if (type === 'verification_start' || type === 'verification_complete') return 'task';
  if (typeof type === 'string' && type.startsWith('concierge:')) return 'concierge';
  return 'system';
}

/**
 * Bind all state I/O to one project's paths, with its own isolated
 * event-sequence counter. See module docstring.
 */
// eslint-disable-next-line max-lines-per-function -- a cohesive factory binding small closures to one project's paths; splitting further would hurt readability more than it helps
export function createProjectState(handle: ProjectStateHandle): ProjectStateApi {
  const { coordDir, statePath, logPath, eventsPath, projectName } = handle;
  let eventSeq = 0;

  function initEventSeq(): void {
    if (!fs.existsSync(eventsPath)) return;
    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { seq?: number };
        if (typeof parsed.seq === 'number' && parsed.seq > eventSeq) {
          eventSeq = parsed.seq;
        }
        break;
      } catch {
        /* skip malformed */
      }
    }
  }

  function ensureCoordFiles(): void {
    if (!fs.existsSync(coordDir)) {
      fs.mkdirSync(coordDir, { recursive: true });
    }

    if (!fs.existsSync(statePath)) {
      const state = createDefaultState(projectName);
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }

    if (!fs.existsSync(logPath)) {
      const lines = [
        '# AI Sync Log',
        '',
        `Created: ${nowIso()}`,
        '',
        'Use `npm run hydra:summary` to see current state.',
        '',
      ];
      fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    }

    if (!fs.existsSync(eventsPath)) {
      fs.writeFileSync(eventsPath, '', 'utf8');
    }

    initEventSeq();
  }

  function readState(): HydraStateShape {
    ensureCoordFiles();
    const raw = fs.readFileSync(statePath, 'utf8');
    return normalizeState(JSON.parse(raw), projectName);
  }

  /**
   * Atomically persist state to disk (write-tmp then rename).
   * @param state - The state object to persist
   * @returns The normalized, timestamped state that was written
   */
  function writeState(state: Record<string, unknown>): HydraStateShape {
    const next = normalizeState(state, projectName);
    next.updatedAt = nowIso();
    if (next.activeSession?.status === 'active') {
      next.activeSession.updatedAt = next.updatedAt;
    }
    const tempPath = `${statePath}.tmp`;
    const data = `${JSON.stringify(next, null, 2)}\n`;
    fs.writeFileSync(tempPath, data, 'utf8');

    let retries = 0;
    for (;;) {
      try {
        fs.renameSync(tempPath, statePath);
        break;
      } catch (err) {
        retries++;
        if (retries > 5) {
          // If rename fails consistently, try copy and unlink (less atomic but better than partial write)
          try {
            fs.copyFileSync(tempPath, statePath);
            fs.unlinkSync(tempPath);
            break;
          } catch (copyErr) {
            console.error(
              `Failed to write state: ${(err as Error).message} -> ${(copyErr as Error).message}`,
            );
            throw copyErr;
          }
        }
        // Sync sleep (busy wait) 50ms * retries
        const start = Date.now();
        while (Date.now() - start < 50 * retries);
      }
    }
    return next;
  }

  function appendSyncLog(entry: string): void {
    ensureCoordFiles();
    fs.appendFileSync(logPath, `- ${nowIso()} | ${entry}\n`, 'utf8');
  }

  function getEventSeq(): number {
    return eventSeq;
  }

  function resetEventSeq(): void {
    eventSeq = 0;
  }

  function appendEvent(type: string, payload?: unknown, id?: string): void {
    eventSeq += 1;
    const category = categorizeEvent(type, payload);
    const line = JSON.stringify({
      id: id ?? `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
      seq: eventSeq,
      at: nowIso(),
      type,
      category,
      payload,
    });
    fs.appendFileSync(eventsPath, `${line}\n`, 'utf8');
  }

  function replayEvents(fromSeq = 0): EventRecord[] {
    if (!fs.existsSync(eventsPath)) return [];
    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const events: EventRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { seq?: number } & Partial<EventRecord>;
        if (typeof parsed.seq === 'number' && parsed.seq >= fromSeq) {
          events.push(parsed as EventRecord);
        }
      } catch {
        /* skip malformed */
      }
    }
    return events;
  }

  return {
    ensureCoordFiles,
    readState,
    writeState,
    appendSyncLog,
    getEventSeq,
    resetEventSeq,
    initEventSeq,
    appendEvent,
    replayEvents,
  };
}

// ── Legacy module-level singleton ───────────────────────────────────────────
// Bound to resolveProject()'s module-load-time result, exactly as before
// this factory existed — every pre-existing caller/test is unaffected.

const legacy = createProjectState({
  coordDir: config.coordDir,
  statePath: config.statePath,
  logPath: config.logPath,
  eventsPath: config.eventsPath,
  projectName: config.projectName,
});

export const ensureCoordFiles = legacy.ensureCoordFiles;
export const readState = legacy.readState;
export const writeState = legacy.writeState;
export const appendSyncLog = legacy.appendSyncLog;
export const getEventSeq = legacy.getEventSeq;
export const resetEventSeq = legacy.resetEventSeq;
export const initEventSeq = legacy.initEventSeq;
export const appendEvent = legacy.appendEvent;
export const replayEvents = legacy.replayEvents;
