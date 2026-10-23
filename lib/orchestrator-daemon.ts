#!/usr/bin/env node
/**
 * Orchestrator daemon for Gemini + Codex + Claude coordination.
 * Runs a local HTTP server that reads/writes the shared sync state.
 *
 * Graceful shutdown: On Unix, SIGINT/SIGTERM trigger a clean exit. On Windows,
 * process signals are not delivered the same way; use the HTTP /stop (or
 * orchestrator-client stop) endpoint for a Windows-safe graceful shutdown.
 */

import './hydra-env.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import {
  getAgent,
  AGENT_NAMES,
  classifyTask,
  getModelSummary,
  listAgents,
} from './hydra-agents.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import {
  createConversationExecutor,
  createApprovalContinuator,
  type ExecutorDeps,
} from './daemon/conversation-executor.ts';
import { registerBuiltInSubAgents } from './hydra-sub-agents.ts';
import { syncHydraMd } from './hydra-sync-md.ts';
import {
  nextId,
  parseList,
  getCurrentBranch as _getCurrentBranch,
  ensureKnownStatus,
  ensureKnownAgent,
  detectCycle,
  autoUnblock,
  buildPrompt as _buildPrompt,
  getSummary,
  suggestNext,
} from './daemon/task-helpers.ts';
import { hydraSplash, label as uiLabel, divider, SUCCESS, DIM } from './hydra-ui.ts';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import type { ProjectConfig } from './hydra-config.ts';
import {
  readEvents,
  readArchive,
  archiveState,
  truncateEventsFile,
  createSnapshot,
  cleanOldSnapshots,
  checkIdempotency,
} from './daemon/archive.ts';
import { createTaskWorktree, mergeTaskWorktree, cleanupTaskWorktree } from './daemon/worktree.ts';
import { getMetricsSummary, persistMetrics, loadPersistedMetrics } from './hydra-metrics.ts';
import { checkUsage } from './hydra-usage.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { handleReadRoute } from './daemon/read-routes.ts';
import { handleWriteRoute } from './daemon/write-routes.ts';
import { handleMutationRoute } from './daemon/mutation-routes.ts';
import { handleConversationRoute } from './daemon/conversation-routes.ts';
import { ConversationStore } from './daemon/conversation-store.ts';
import { StreamManager } from './daemon/stream-manager.ts';
import { EventBridge } from './daemon/event-bridge.ts';
import { sendJson, sendError, isAuthorized, readJsonBody } from './daemon/http-utils.ts';
import { printHelp, commandStatus, commandStop } from './daemon/cli-commands.ts';
import {
  nowIso,
  toSessionId,
  getEventSeq,
  resetEventSeq,
  initEventSeq,
  ensureCoordFiles,
  readState,
  writeState,
  appendSyncLog,
  appendEvent,
  replayEvents,
  createProjectState,
  type ProjectStateApi,
} from './daemon/state.ts';
import { listProjects, findProject } from './hydra-registry.ts';
import { countInFlight, type ProjectInFlight } from './daemon/scheduler.ts';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type {
  HydraStateShape,
  TaskEntry,
  ReadRouteCtx,
  WriteRouteCtx,
  UsageCheckResult,
  ModelSummaryEntry,
  AgentDef,
} from './types.ts';
import pc from 'picocolors';
import { exit } from './hydra-process.ts';

const config = resolveProject();

const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const STATUS_PATH = config.statusPath;

const DEFAULT_HOST = process.env['AI_ORCH_HOST'] ?? '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env['AI_ORCH_PORT'] ?? '4173', 10);
const ORCH_TOKEN = process.env['AI_ORCH_TOKEN'] ?? '';

// ── Hydra Lite multi-project runtime ────────────────────────────────────────
// A daemon started the legacy way (`project=<path>` CLI arg, or cwd) serves
// exactly the one project resolved above — zero behavior change for every
// pre-existing caller/test, since none of them ever send `?projectId=`.
// When a request DOES carry `?projectId=<id>`, the daemon resolves it
// against the Hydra Lite registry (lib/hydra-registry.ts) and serves that
// project's own `.hydra/` state instead, via `createProjectState()`
// (lib/daemon/state.ts) — so one daemon process can serve many registered
// projects, each with its own isolated state file and event-sequence
// counter, while every project's own mutations stay strictly ordered
// (its own `writeQueue`, cached for the life of the process in
// `ctx.projects`).

const LEGACY_PROJECT_KEY = '__legacy__';

interface ProjectRuntime {
  config: ProjectConfig;
  stateApi: ProjectStateApi;
  writeQueue: Promise<unknown>;
}

const legacyRuntime: ProjectRuntime = {
  config,
  stateApi: {
    ensureCoordFiles,
    readState,
    writeState,
    appendSyncLog,
    getEventSeq,
    resetEventSeq,
    initEventSeq,
    appendEvent,
    replayEvents,
  },
  writeQueue: Promise.resolve(),
};

function resolveRuntime(ctx: DaemonContext, projectId: string | undefined): ProjectRuntime {
  const key = projectId ?? LEGACY_PROJECT_KEY;
  const existing = ctx.projects.get(key);
  if (existing) return existing;

  const entry = findProject(key);
  if (!entry) {
    throw new Error(`No registered Hydra Lite project with id: ${key}`);
  }
  const projectConfig = resolveProject({ project: entry.path });
  const runtime: ProjectRuntime = {
    config: projectConfig,
    stateApi: createProjectState({
      coordDir: projectConfig.coordDir,
      statePath: projectConfig.statePath,
      logPath: projectConfig.logPath,
      eventsPath: projectConfig.eventsPath,
      projectName: projectConfig.projectName,
    }),
    writeQueue: Promise.resolve(),
  };
  ctx.projects.set(key, runtime);
  return runtime;
}

/**
 * In-flight read/write load for every registered Hydra Lite project OTHER
 * than `excludeProjectId`, read fresh from each project's persisted
 * `.hydra/state.json` (not from `ctx.projects`' cached runtimes, since this
 * is read-only and needs no write-queue continuity). Used by the
 * task/claim concurrency gate (lib/daemon/scheduler.ts's canClaim) to build
 * a global snapshot alongside the current project's own `state.tasks`.
 */
function countOtherProjectsInFlight(
  excludeProjectId: string | undefined,
): Record<string, ProjectInFlight> {
  const result: Record<string, ProjectInFlight> = {};
  for (const project of listProjects()) {
    if (project.id === excludeProjectId) continue;
    try {
      const projectConfig = resolveProject({ project: project.path, skipValidation: true });
      const state = createProjectState({
        coordDir: projectConfig.coordDir,
        statePath: projectConfig.statePath,
        logPath: projectConfig.logPath,
        eventsPath: projectConfig.eventsPath,
        projectName: projectConfig.projectName,
      }).readState();
      result[project.id] = countInFlight(state.tasks);
    } catch {
      // Unreadable/missing project state — treat as idle rather than
      // failing an unrelated project's claim over it.
      result[project.id] = { reading: 0, writing: false };
    }
  }
  return result;
}

function buildPrompt(agent: string, state: HydraStateShape) {
  return _buildPrompt(agent, state, config.projectRoot, config.projectName);
}

function parseArgs(argv: string[]) {
  const [command = 'start', ...rest] = argv.slice(2);
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key !== '') {
        options[key] = rawValue.join('=').trim();
      }
    }
  }

  return { command, options };
}

interface DaemonContext {
  host: string;
  port: number;
  isShuttingDown: boolean;
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  sseClients: Set<ServerResponse>;
  conversationStore: ConversationStore;
  streamManager: StreamManager;
  eventBridge: EventBridge;
  /** Resolved Hydra Lite project runtimes, keyed by registry id (or
   * LEGACY_PROJECT_KEY for the daemon's own startup project), cached for
   * the life of the process so each project's writeQueue stays continuous
   * across requests. */
  projects: Map<string, ProjectRuntime>;
}

interface DaemonIntervals {
  statusInterval: ReturnType<typeof setInterval>;
  metricsInterval: ReturnType<typeof setInterval>;
  archiveInterval: ReturnType<typeof setInterval>;
  staleInterval: ReturnType<typeof setInterval>;
  streamPurgeInterval: ReturnType<typeof setInterval>;
}

type VerificationCallback = (error: Error | null, stdout: string, stderr: string) => void;

function createDaemonContext(host: string, port: number): DaemonContext {
  const conversationStore = new ConversationStore();
  const eventBridge = new EventBridge();
  const projects = new Map<string, ProjectRuntime>();
  projects.set(LEGACY_PROJECT_KEY, legacyRuntime);
  return {
    host,
    port,
    isShuttingDown: false,
    startedAt: nowIso(),
    lastEventAt: nowIso(),
    eventCount: 0,
    sseClients: new Set<ServerResponse>(),
    conversationStore,
    streamManager: new StreamManager(conversationStore, undefined, eventBridge),
    eventBridge,
    projects,
  };
}

function broadcastEvent(sseClients: Set<ServerResponse>, event: unknown) {
  if (sseClients.size === 0) return;
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

/** Losslessly coerce unknown agent output to a string. */
function coerceOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw != null) return JSON.stringify(raw);
  return '';
}

/**
 * Build the ExecutorDeps for the conversation executor/continuator from the
 * daemon context.  Uses `executeAgentWithRecovery` as the real agent backend.
 */
function buildExecutorDeps(ctx: DaemonContext): ExecutorDeps {
  return {
    conversationStore: ctx.conversationStore,
    streamManager: ctx.streamManager,
    executeAgent: async (agent, prompt) => {
      const result = await executeAgentWithRecovery(agent, prompt);
      return { ok: result.ok, output: coerceOutput(result.output) };
    },
  };
}

/**
 * Pre-built conversation route handlers, constructed once per daemon context
 * rather than per request. Safe to share because executor deps reference
 * the mutable context (store, streamManager) by closure.
 */
function buildConversationHandlers(ctx: DaemonContext) {
  const deps = buildExecutorDeps(ctx);
  return {
    store: ctx.conversationStore,
    streamManager: ctx.streamManager,
    executeTurn: createConversationExecutor(deps),
    continueAfterApproval: createApprovalContinuator(deps),
  };
}

function writeStatus(ctx: DaemonContext, extra: Record<string, unknown> = {}) {
  const state = readState();
  const payload = {
    service: 'hydra-orchestrator',
    project: config.projectName,
    projectRoot: config.projectRoot,
    running: !ctx.isShuttingDown,
    pid: process.pid,
    host: ctx.host,
    port: ctx.port,
    startedAt: ctx.startedAt,
    updatedAt: nowIso(),
    uptimeSec: Math.floor(process.uptime()),
    stateUpdatedAt: state.updatedAt,
    activeSessionId: state.activeSession?.id ?? null,
    eventsRecorded: ctx.eventCount,
    lastEventAt: ctx.lastEventAt,
    ...extra,
  };
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function enqueueMutation<T>(
  ctx: DaemonContext,
  runtime: ProjectRuntime,
  label: string,
  mutator: (state: HydraStateShape) => T,
  detail: Record<string, unknown> = {},
) {
  const mutation = runtime.writeQueue.then(() => {
    const state = runtime.stateApi.readState();
    const result = mutator(state);
    runtime.stateApi.writeState(state);
    runtime.stateApi.appendSyncLog(`[orch] ${label}`);
    const at = nowIso();
    const event = {
      id: `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
      seq: runtime.stateApi.getEventSeq() + 1,
      at,
      type: 'mutation',
      payload: { label, ...detail },
    };
    runtime.stateApi.appendEvent('mutation', { label, ...detail }, event.id);
    broadcastEvent(ctx.sseClients, event);
    ctx.lastEventAt = at;
    ctx.eventCount += 1;
    writeStatus(ctx);
    return result;
  });
  // Prevent queue poisoning: failed mutations must not block subsequent ones
  runtime.writeQueue = mutation.catch(() => {});
  return mutation;
}

function handleVerificationResult(
  ctx: DaemonContext,
  taskId: string,
  plan: Record<string, unknown>,
  error: Error | null,
  stdout: string,
  stderr: string,
) {
  if (error) {
    const snippet = ([stderr, stdout, error.message] as string[]).find((s) => s !== '') ?? '';
    const snippetSliced = snippet.slice(0, 500);
    void enqueueMutation(
      ctx,
      legacyRuntime,
      `verify:fail id=${taskId}`,
      (state: HydraStateShape) => {
        const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
        if (task) {
          task.status = 'blocked';
          const note = `[AUTO-VERIFY FAILED] ${String(plan['command'])}:\n${snippetSliced}`;
          task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
          task.updatedAt = nowIso();
        }
      },
      { event: 'verify', taskId, passed: false, command: plan['command'] },
    );
    appendEvent('verification_complete', {
      taskId,
      passed: false,
      command: plan['command'],
      snippet: snippetSliced,
    });
    return;
  }

  void enqueueMutation(
    ctx,
    legacyRuntime,
    `verify:pass id=${taskId}`,
    (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) {
        const note = `[AUTO-VERIFY PASSED] ${String(plan['command'])} completed cleanly.`;
        task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
        task.updatedAt = nowIso();
      }
    },
    { event: 'verify', taskId, passed: true, command: plan['command'] },
  );
  appendEvent('verification_complete', { taskId, passed: true, command: plan['command'] });
}

interface SpawnVerifyOptions {
  command: string;
  cwd: string;
  stdoutFd: number;
  stderrFd: number;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  tmpDir: string;
  handleResult: VerificationCallback;
}

function spawnVerifyChild(opts: SpawnVerifyOptions) {
  const child = spawn(opts.command, [], {
    cwd: opts.cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', opts.stdoutFd, opts.stderrFd],
  });

  // Parent can close immediately; child holds its own handles.
  try {
    fs.closeSync(opts.stdoutFd);
  } catch {
    /* ignore */
  }
  try {
    fs.closeSync(opts.stderrFd);
  } catch {
    /* ignore */
  }

  let timedOut = false;
  let finished = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
    Math.max(1, opts.timeoutMs === 0 ? 60_000 : opts.timeoutMs),
  );

  function finish(err: Error | null, code: number | null) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    let out = '';
    let errText = '';
    try {
      out = fs.readFileSync(opts.stdoutPath, 'utf8');
    } catch {
      /* ignore */
    }
    try {
      errText = fs.readFileSync(opts.stderrPath, 'utf8');
    } catch {
      /* ignore */
    }
    const effectiveError =
      err ??
      (timedOut || code !== 0
        ? new Error(timedOut ? 'Verification timed out.' : `Exit ${String(code)}`)
        : null);
    opts.handleResult(effectiveError, out, errText);
    try {
      fs.rmSync(opts.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  child.on('error', (err: Error) => {
    finish(err, null);
  });
  child.on('close', (code: number | null) => {
    finish(null, code);
  });
}

function runVerificationFallback(
  plan: Record<string, unknown>,
  handleResult: VerificationCallback,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-verify-'));
  const stdoutPath = path.join(tmpDir, 'stdout.txt');
  const stderrPath = path.join(tmpDir, 'stderr.txt');

  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    stdoutFd = fs.openSync(stdoutPath, 'w');
    stderrFd = fs.openSync(stderrPath, 'w');
    spawnVerifyChild({
      command: plan['command'] as string,
      cwd: config.projectRoot,
      stdoutFd,
      stderrFd,
      timeoutMs: plan['timeoutMs'] as number,
      stdoutPath,
      stderrPath,
      tmpDir,
      handleResult,
    });
    // Fds were handed off to the child process — clear refs so finally doesn't double-close.
    stdoutFd = null;
    stderrFd = null;
  } catch (err) {
    // If even the fallback can't start, treat as a failure but never throw.
    try {
      const msg = (
        (err as Error).message === '' ? 'Verification failed to start.' : (err as Error).message
      ).slice(0, 500);
      handleResult(new Error(msg), '', '');
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } finally {
    if (stdoutFd !== null) {
      try {
        fs.closeSync(stdoutFd);
      } catch {
        /* ignore */
      }
    }
    if (stderrFd !== null) {
      try {
        fs.closeSync(stderrFd);
      } catch {
        /* ignore */
      }
    }
  }
}

function runVerification(ctx: DaemonContext, taskId: string, plan: Record<string, unknown>) {
  if (plan['enabled'] !== true || plan['command'] == null || plan['command'] === '') {
    return;
  }

  appendEvent('verification_start', { taskId, command: plan['command'], source: plan['source'] });

  const handleResult: VerificationCallback = (error, stdout, stderr) => {
    handleVerificationResult(ctx, taskId, plan, error, stdout, stderr);
  };

  // Prefer exec (captures stdout/stderr) when possible, but fall back to a
  // no-pipes spawn mode for restricted sandboxes that forbid stdio pipes.
  try {
    exec(
      plan['command'] as string,
      { cwd: config.projectRoot, timeout: plan['timeoutMs'] as number, encoding: 'utf8' },
      handleResult,
    );
    return;
  } catch {
    // Fall through to spawn-based implementation below.
  }

  // No-pipes fallback: redirect stdout/stderr to temp files and read them at the end.
  runVerificationFallback(plan, handleResult);
}

/**
 * Resolve the Hydra Lite project a request targets from its `?projectId=`
 * query param. Returns undefined for legacy requests (no query param —
 * every pre-existing caller), in which case route handlers fall back to
 * this daemon's own startup project, unchanged from before the registry
 * existed.
 */
function requestedProjectId(requestUrl: URL): string | undefined {
  return requestUrl.searchParams.get('projectId') ?? undefined;
}

function buildReadRouteCtx(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
): ReadRouteCtx {
  const projectId = requestedProjectId(requestUrl);
  const runtime = resolveRuntime(ctx, projectId);
  return {
    method: req.method ?? 'GET',
    route: requestUrl.pathname,
    requestUrl,
    req,
    res,
    sendJson,
    sendError,
    writeStatus: () => {
      writeStatus(ctx);
    },
    readStatus: () => JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as Record<string, unknown>,
    checkUsage: checkUsage as unknown as () => UsageCheckResult,
    getModelSummary: getModelSummary as () => Record<string, ModelSummaryEntry>,
    readState: runtime.stateApi.readState,
    getSummary,
    projectRoot: runtime.config.projectRoot,
    projectName: runtime.config.projectName,
    buildPrompt,
    suggestNext,
    readEvents,
    replayEvents: runtime.stateApi.replayEvents,
    sseClients: ctx.sseClients,
    readArchive,
    getMetricsSummary,
    getEventCount: () => ctx.eventCount,
    projectId,
  };
}

function buildWriteRouteCtx(
  ctx: DaemonContext,
  server: http.Server,
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
) {
  const projectId = requestedProjectId(requestUrl);
  const runtime = resolveRuntime(ctx, projectId);
  return {
    method: req.method ?? 'GET',
    route: requestUrl.pathname,
    req,
    res,
    readJsonBody,
    sendJson,
    sendError,
    enqueueMutation: <T>(
      label: string,
      mutator: (state: HydraStateShape) => T,
      detail?: Record<string, unknown>,
    ) => enqueueMutation(ctx, runtime, label, mutator, detail ?? {}),
    ensureKnownAgent,
    ensureKnownStatus,
    parseList,
    getCurrentBranch: () => _getCurrentBranch(runtime.config.projectRoot),
    toSessionId,
    nowIso,
    classifyTask,
    nextId,
    detectCycle,
    autoUnblock,
    readState: runtime.stateApi.readState,
    replayEvents: runtime.stateApi.replayEvents,
    AGENT_NAMES,
    getAgent: getAgent as (name: string) => AgentDef | undefined,
    listAgents: listAgents as (...args: unknown[]) => AgentDef[],
    resolveVerificationPlan: resolveVerificationPlan as unknown as (
      ...args: unknown[]
    ) => Record<string, unknown>,
    projectRoot: runtime.config.projectRoot,
    runVerification: (taskId: unknown, plan: unknown) => {
      runVerification(ctx, taskId as string, plan as Record<string, unknown>);
    },
    archiveState,
    truncateEventsFile,
    writeStatus: (extra?: Record<string, unknown>) => {
      writeStatus(ctx, extra);
    },
    appendEvent: runtime.stateApi.appendEvent,
    broadcastEvent: (event: unknown) => {
      broadcastEvent(ctx.sseClients, event);
    },
    setIsShuttingDown: (value: boolean) => {
      ctx.isShuttingDown = value;
    },
    server,
    createSnapshot,
    cleanOldSnapshots,
    checkIdempotency,
    createTaskWorktree,
    mergeTaskWorktree,
    cleanupTaskWorktree,
    projectId,
    countOtherProjectsInFlight: () => countOtherProjectsInFlight(projectId),
  };
}

async function handleHttpRequest(
  ctx: DaemonContext,
  convHandlers: ReturnType<typeof buildConversationHandlers>,
  server: http.Server,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const requestUrl = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? `${ctx.host}:${String(ctx.port)}`}`,
  );
  const route = requestUrl.pathname;
  const method = req.method ?? 'GET';

  try {
    if (await handleReadRoute(buildReadRouteCtx(ctx, req, res, requestUrl))) return;

    if (!isAuthorized(req, ORCH_TOKEN)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    if (handleConversationRoute(req, res, convHandlers)) {
      return;
    }

    if (
      await handleWriteRoute(
        buildWriteRouteCtx(ctx, server, req, res, requestUrl) as unknown as WriteRouteCtx,
      )
    ) {
      return;
    }

    if (await handleMutationRoute(req, res, requestUrl)) return;

    sendError(res, 404, `Route not found: ${method} ${route}`);
  } catch (err) {
    sendError(res, 400, (err as Error).message === '' ? 'Bad request' : (err as Error).message);
  }
}

function autoArchiveIfNeeded(ctx: DaemonContext) {
  void enqueueMutation(ctx, legacyRuntime, 'auto_archive', (state: HydraStateShape) => {
    const completedCount = state.tasks.filter((t: TaskEntry) =>
      ['done', 'cancelled'].includes(t.status),
    ).length;
    if (completedCount > 20) {
      const moved = archiveState(state);
      if (moved > 0) {
        truncateEventsFile(500);
        return { moved };
      }
    }
    return { moved: 0 };
  })
    .then((result: Record<string, unknown>) => {
      if ((result['moved'] as number) > 0) {
        appendEvent('auto_archive', { moved: result['moved'] });
      }
    })
    .catch(() => {});
}

function printStartupInfo(host: string, port: number) {
  console.log(hydraSplash());
  console.log(uiLabel('Project', pc.white(config.projectName)));
  console.log(uiLabel('Root', DIM(config.projectRoot)));
  console.log(uiLabel('URL', pc.white(`http://${host}:${String(port)}`)));
  console.log(uiLabel('PID', pc.white(String(process.pid))));
  console.log(uiLabel('State', DIM(path.relative(config.projectRoot, STATE_PATH))));
  console.log(uiLabel('Status', DIM(path.relative(config.projectRoot, STATUS_PATH))));
  console.log(divider());
  console.log(SUCCESS('  Daemon ready'));
  console.log('');
}

// Stale task reaper: uses heartbeat timeout (fast) or updatedAt fallback (slow)
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — no-heartbeat fallback

function isTaskStale(
  task: TaskEntry,
  now: number,
  heartbeatTimeoutMs: number,
  staleThresholdMs: number,
): boolean {
  if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
    let lastActivity = task.updatedAt === '' ? 0 : new Date(task.updatedAt).getTime();
    if (Array.isArray(task.checkpoints) && task.checkpoints.length > 0) {
      const lastCp = task.checkpoints.at(-1);
      const cpTime = lastCp ? new Date(lastCp['savedAt'] as string).getTime() : 0;
      if (cpTime > lastActivity) lastActivity = cpTime;
    }
    return now - lastActivity > staleThresholdMs;
  }
  const hbAge =
    now - new Date((task as Record<string, unknown>)['lastHeartbeat'] as string).getTime();
  return hbAge > heartbeatTimeoutMs;
}

function handleHeartbeatTimeout(
  sseClients: Set<ServerResponse>,
  task: TaskEntry,
  state: HydraStateShape,
  maxAttempts: number,
) {
  const currentFailCount = (task as Record<string, unknown>)['failCount'] as number | undefined;
  const failCount = (currentFailCount ?? 0) + 1;
  (task as Record<string, unknown>)['failCount'] = failCount;

  if (failCount < maxAttempts) {
    // Requeue: reset to todo for retry
    task.status = 'todo';
    task.stale = false;
    delete task.staleSince;
    task.updatedAt = nowIso();
    broadcastEvent(sseClients, {
      type: 'mutation',
      payload: {
        event: 'task:heartbeat_timeout',
        taskId: task.id,
        owner: task.owner,
        action: 'requeue',
        failCount,
      },
    });
    appendEvent('task:heartbeat_timeout', {
      taskId: task.id,
      owner: task.owner,
      action: 'requeue',
      failCount,
      category: 'heartbeat',
    });
  } else {
    // Exhausted retries → dead-letter queue
    if (!Array.isArray(state['deadLetter'])) state['deadLetter'] = [];
    (state['deadLetter'] as unknown[]).push({
      id: task.id,
      title: task.title,
      owner: task.owner,
      failCount,
      reason: 'heartbeat_timeout',
      movedAt: nowIso(),
    });
    (task as Record<string, unknown>)['status'] = 'failed';
    task.updatedAt = nowIso();
    broadcastEvent(sseClients, {
      type: 'mutation',
      payload: {
        event: 'task:heartbeat_timeout',
        taskId: task.id,
        owner: task.owner,
        action: 'dead_letter',
        failCount,
      },
    });
    appendEvent('task:heartbeat_timeout', {
      taskId: task.id,
      owner: task.owner,
      action: 'dead_letter',
      failCount,
      category: 'heartbeat',
    });
  }
}

function markStaleTasks(ctx: DaemonContext) {
  try {
    const cfg = loadHydraConfig();
    const heartbeatTimeoutMsRaw = Number(
      ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
        'heartbeatTimeoutMs'
      ],
    );
    const heartbeatTimeoutMs = heartbeatTimeoutMsRaw === 0 ? 90_000 : heartbeatTimeoutMsRaw; // 90s default
    const maxAttemptsRaw = Number(
      (
        ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
          'retry'
        ] as Record<string, unknown> | undefined
      )?.['maxAttempts'],
    );
    const maxAttempts = maxAttemptsRaw === 0 ? 3 : maxAttemptsRaw;
    const state = readState();
    const now = Date.now();
    let changed = false;

    for (const task of state.tasks) {
      if (task.status !== 'in_progress') continue;

      const isStale = isTaskStale(task, now, heartbeatTimeoutMs, STALE_THRESHOLD_MS);

      if (isStale && task.stale !== true) {
        task.stale = true;
        task.staleSince = nowIso();
        changed = true;

        if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
          broadcastEvent(ctx.sseClients, {
            type: 'mutation',
            payload: {
              event: 'task_stale',
              taskId: task.id,
              owner: task.owner,
              title: task.title,
            },
          });
        } else {
          handleHeartbeatTimeout(ctx.sseClients, task, state, maxAttempts);
        }
      } else if (!isStale && task.stale === true) {
        task.stale = false;
        delete task.staleSince;
        changed = true;
      }
    }

    if (changed) {
      writeState(state);
    }
  } catch {
    // Non-critical — skip silently.
  }
}

function gracefulExit(
  ctx: DaemonContext,
  server: http.Server,
  intervals: DaemonIntervals,
  signal: string,
) {
  if (ctx.isShuttingDown) {
    return;
  }
  ctx.isShuttingDown = true;
  console.log('');
  console.log(DIM(`  Shutting down (${signal})...`));
  appendSyncLog(`[orch] daemon stopping (${signal})`);
  appendEvent('daemon_stop', { signal, pid: process.pid });
  // Close all SSE clients
  for (const client of ctx.sseClients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  ctx.sseClients.clear();
  // Close MCP clients
  void import('./hydra-mcp.ts').then((m) => m.closeCodexMCP()).catch(() => {});
  persistMetrics(COORD_DIR);
  clearInterval(intervals.statusInterval);
  clearInterval(intervals.metricsInterval);
  clearInterval(intervals.archiveInterval);
  clearInterval(intervals.staleInterval);
  clearInterval(intervals.streamPurgeInterval);
  writeStatus(ctx, { running: false, stoppingAt: nowIso(), signal });
  server.close(() => {
    writeStatus(ctx, { running: false, stoppedAt: nowIso(), signal });
    console.log(SUCCESS('  Daemon stopped'));
    exit(0);
  });
}

/**
 * Crash-recovery policy for registered Hydra Lite projects only (never the
 * legacy startup project, whose restart semantics must stay exactly as
 * before the registry existed): since no process can still be running a
 * task from a previous daemon instance, any task found `in_progress` is
 * reset to `todo` on startup, incrementing its `attempts` counter. This is
 * deliberately simple because milestone-1 tasks are read-only — a crash
 * mid-task has made zero changes to the project's working tree, so there is
 * nothing to roll back, only a queue position to restore.
 */
function resetStuckTasksForRegisteredProjects(): void {
  for (const project of listProjects()) {
    try {
      const projectConfig = resolveProject({ project: project.path, skipValidation: true });
      const stateApi = createProjectState({
        coordDir: projectConfig.coordDir,
        statePath: projectConfig.statePath,
        logPath: projectConfig.logPath,
        eventsPath: projectConfig.eventsPath,
        projectName: projectConfig.projectName,
      });
      const state = stateApi.readState();
      let changed = false;
      for (const task of state.tasks) {
        if (task.status !== 'in_progress') continue;
        task.status = 'todo';
        task.attempts = (task.attempts ?? 0) + 1;
        task.updatedAt = nowIso();
        changed = true;
      }
      if (changed) stateApi.writeState(state);
    } catch {
      // Best-effort: an unreadable registered project shouldn't block
      // daemon startup for every other project.
    }
  }
}

function startDaemon(options: Record<string, string>) {
  ensureCoordFiles();
  resetStuckTasksForRegisteredProjects();

  // Register built-in virtual sub-agents
  try {
    registerBuiltInSubAgents();
  } catch {
    /* sub-agents optional */
  }

  // Sync HYDRA.md → agent instruction files (silent)
  try {
    syncHydraMd(config.projectRoot);
  } catch {
    /* non-critical */
  }

  const host = options['host'] ?? DEFAULT_HOST;
  const port = Number.parseInt(options['port'] ?? String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid port: ${options['port']}`);
    process.exitCode = 1;
    return;
  }

  const ctx = createDaemonContext(host, port);
  const convHandlers = buildConversationHandlers(ctx);

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async HTTP handler, errors caught in try/catch block
  const server = http.createServer(async (req, res) =>
    handleHttpRequest(ctx, convHandlers, server, req, res),
  );

  server.on('error', (error: Error) => {
    console.error(`Orchestrator server error: ${error.message}`);
    exit(1);
  });

  // Load persisted metrics from previous session
  loadPersistedMetrics(COORD_DIR);

  server.listen(port, host, () => {
    appendSyncLog(`[orch] daemon started at http://${host}:${String(port)}`);
    appendEvent('daemon_start', {
      host,
      port: String(port),
      pid: process.pid,
      project: config.projectName,
    });
    writeStatus(ctx);
    autoArchiveIfNeeded(ctx);
    printStartupInfo(host, port);
  });

  const statusInterval = setInterval(() => {
    writeStatus(ctx);
  }, 5000);
  const metricsInterval = setInterval(() => {
    persistMetrics(COORD_DIR);
  }, 30_000);
  const archiveInterval = setInterval(
    () => {
      autoArchiveIfNeeded(ctx);
    },
    30 * 60 * 1000,
  );
  const staleInterval = setInterval(() => {
    markStaleTasks(ctx);
  }, 60 * 1000); // 60s — frequent enough for heartbeat timeouts
  const streamPurgeInterval = setInterval(() => {
    ctx.streamManager.purgeTerminalStreams();
  }, 60 * 1000); // 60s — enforce wall-clock retention even when idle

  const intervals: DaemonIntervals = {
    statusInterval,
    metricsInterval,
    archiveInterval,
    staleInterval,
    streamPurgeInterval,
  };

  // SIGTERM is not reliably delivered on Windows; use HTTP POST /stop for graceful shutdown there.
  process.on('SIGINT', () => {
    gracefulExit(ctx, server, intervals, 'SIGINT');
  });
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => {
      gracefulExit(ctx, server, intervals, 'SIGTERM');
    });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'start':
      startDaemon(options);
      return;
    case 'status':
      await commandStatus(options);
      return;
    case 'stop':
      await commandStop(options);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

void main();
