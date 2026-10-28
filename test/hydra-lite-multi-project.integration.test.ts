/**
 * Acceptance test for Hydra Lite macOS Milestone 1 ("Lean safety spine"),
 * matching docs/plan/hydra-lite-macos-plan.md's acceptance criteria:
 *
 *   "Register two temporary Git repositories and queue three read-only
 *   tasks. One task in each project runs concurrently while the third
 *   remains queued. Restart the daemon and confirm task histories stay
 *   isolated. Queue an edit task and confirm it remains awaiting_approval
 *   with no Codex process launched."
 *
 * One real daemon subprocess serves BOTH registered projects via
 * `?projectId=`, following test/orchestrator-daemon.integration.test.ts's
 * spawn pattern. The registry is redirected to a disposable temp file via
 * HYDRA_REGISTRY_PATH (the daemon runs in its own process, so it can't see
 * this process's in-memory _setTestRegistryPath override).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { addProject, type RegisteredProject } from '../lib/hydra-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(REPO_ROOT, 'lib', 'orchestrator-daemon.ts');

interface DaemonInstance {
  child: ChildProcess;
  baseUrl: string;
}

interface RequestJsonResponse {
  response: { status: number; ok: boolean };
  json: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTempProject(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hydra-lite-it-${name}-`));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name, private: true }, null, 2)}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function requestJson(
  baseUrl: string,
  method: string,
  route: string,
  body: Record<string, unknown> | null = null,
  timeoutMs = 4_000,
): Promise<RequestJsonResponse> {
  const target = new URL(route, baseUrl);
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text);
          } catch {
            /* fallback {} */
          }
          const status = res.statusCode ?? 0;
          resolve({ response: { status, ok: status >= 200 && status < 300 }, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout: ${method} ${route}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before becoming healthy (exit=${child.exitCode})`);
    }
    try {
      const { response } = await requestJson(baseUrl, 'GET', '/health');
      if (response.ok) return;
    } catch {
      /* keep retrying */
    }
    await sleep(125);
  }
  throw new Error('Timed out waiting for daemon health check');
}

async function waitForExit(child: ChildProcess, timeoutMs = 4_000): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Starts the daemon bound to `legacyProjectRoot` (satisfies resolveProject()
 * at module load) with the registry redirected to `registryPath` via env,
 * so the same two registered projects are visible across restarts.
 */
async function startDaemon(
  legacyProjectRoot: string,
  registryPath: string,
): Promise<DaemonInstance> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${port}`, `project=${legacyProjectRoot}`],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, HYDRA_REGISTRY_PATH: registryPath },
    },
  );
  child.unref();
  await waitForHealth(baseUrl, child);
  return { child, baseUrl };
}

async function stopDaemon(instance: DaemonInstance | null): Promise<void> {
  if (!instance?.child) return;
  try {
    await requestJson(instance.baseUrl, 'POST', '/shutdown', {}, 1_500);
  } catch {
    /* fall back to kill below */
  }
  await waitForExit(instance.child, 1_500);
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await waitForExit(instance.child, 2_000);
  }
}

async function removeDirBestEffort(dirPath: string, attempts = 8): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || i === attempts - 1) return;
      await sleep(150);
    }
  }
}

function readTasksFromDisk(projectRoot: string): Record<string, unknown>[] {
  const statePath = path.join(projectRoot, '.hydra', 'AI_SYNC_STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    tasks: Record<string, unknown>[];
  };
  return state.tasks;
}

test(
  'Lean safety spine: multi-project scheduling, restart isolation, and the edit-approval gate',
  { timeout: 60_000 },
  async (t) => {
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-lite-it-registry-'));
    const registryPath = path.join(registryDir, 'registry.json');
    const projectA = createTempProject('project-a');
    const projectB = createTempProject('project-b');
    const daemons: DaemonInstance[] = [];

    t.after(async () => {
      for (const instance of daemons.reverse()) {
        await stopDaemon(instance);
      }
      await removeDirBestEffort(registryDir);
      await removeDirBestEffort(projectA);
      await removeDirBestEffort(projectB);
    });

    // Register both projects directly through the registry API — no daemon
    // dependency, matching the plan's "terminal-only" framing.
    const originalRegistryEnv = process.env['HYDRA_REGISTRY_PATH'];
    process.env['HYDRA_REGISTRY_PATH'] = registryPath;
    let a: RegisteredProject;
    let b: RegisteredProject;
    try {
      a = addProject(projectA);
      b = addProject(projectB);
    } finally {
      if (originalRegistryEnv === undefined) delete process.env['HYDRA_REGISTRY_PATH'];
      else process.env['HYDRA_REGISTRY_PATH'] = originalRegistryEnv;
    }

    const daemon = await startDaemon(projectA, registryPath);
    daemons.push(daemon);

    // ── Queue three read-only tasks: two in project A, one in project B ──
    const addA1 = await requestJson(daemon.baseUrl, 'POST', `/task/add?projectId=${a.id}`, {
      title: 'A task 1',
      effect: 'read',
    });
    const addA2 = await requestJson(daemon.baseUrl, 'POST', `/task/add?projectId=${a.id}`, {
      title: 'A task 2',
      effect: 'read',
    });
    const addB1 = await requestJson(daemon.baseUrl, 'POST', `/task/add?projectId=${b.id}`, {
      title: 'B task 1',
      effect: 'read',
    });
    assert.equal(addA1.response.status, 200);
    assert.equal(addA2.response.status, 200);
    assert.equal(addB1.response.status, 200);
    const a1Id = (addA1.json['task'] as Record<string, unknown>)['id'] as string;
    const a2Id = (addA2.json['task'] as Record<string, unknown>)['id'] as string;
    const b1Id = (addB1.json['task'] as Record<string, unknown>)['id'] as string;

    // ── One task per project claims (runs) concurrently ──
    const claimA1 = await requestJson(daemon.baseUrl, 'POST', `/task/claim?projectId=${a.id}`, {
      taskId: a1Id,
      agent: 'codex',
    });
    assert.equal(claimA1.response.status, 200, 'A1 should claim successfully (project A idle)');
    const claimB1 = await requestJson(daemon.baseUrl, 'POST', `/task/claim?projectId=${b.id}`, {
      taskId: b1Id,
      agent: 'codex',
    });
    assert.equal(claimB1.response.status, 200, 'B1 should claim successfully (project B idle)');

    // ── The third task remains queued: project A is already at its
    // per-project read cap (1), even though the global cap (2) is also
    // exactly reached. ──
    const claimA2 = await requestJson(daemon.baseUrl, 'POST', `/task/claim?projectId=${a.id}`, {
      taskId: a2Id,
      agent: 'codex',
    });
    assert.equal(
      claimA2.response.status,
      400,
      'A2 should be rejected: project A is already at its per-project concurrency cap',
    );

    const stateA = await requestJson(daemon.baseUrl, 'GET', `/state?projectId=${a.id}`);
    const tasksA = (stateA.json['state'] as { tasks: Record<string, unknown>[] }).tasks;
    const a1 = tasksA.find((task) => task['id'] === a1Id);
    const a2 = tasksA.find((task) => task['id'] === a2Id);
    assert.equal(a1?.['status'], 'in_progress');
    assert.equal(a2?.['status'], 'todo', 'A2 must still be queued, not running');

    const stateB = await requestJson(daemon.baseUrl, 'GET', `/state?projectId=${b.id}`);
    const tasksB = (stateB.json['state'] as { tasks: Record<string, unknown>[] }).tasks;
    assert.equal(tasksB.find((task) => task['id'] === b1Id)?.['status'], 'in_progress');

    // ── Restart the daemon and confirm task histories stay isolated ──
    await stopDaemon(daemon);
    const restartedDaemon = await startDaemon(projectA, registryPath);
    daemons.push(restartedDaemon);

    // Note: task ids are NOT globally unique across projects — each
    // project's nextId() sequence starts independently from its own file —
    // so isolation is checked by title/projectId, not by raw id equality.
    const diskTasksA = readTasksFromDisk(projectA);
    const diskTasksB = readTasksFromDisk(projectB);
    assert.equal(diskTasksA.length, 2, 'project A keeps exactly its own two tasks');
    assert.equal(diskTasksB.length, 1, 'project B keeps exactly its own one task');
    assert.ok(
      diskTasksA.every((task) => task['projectId'] === a.id),
      "every task in project A's file is tagged with project A's id",
    );
    assert.ok(
      diskTasksB.every((task) => task['projectId'] === b.id),
      "every task in project B's file is tagged with project B's id",
    );
    assert.ok(
      diskTasksA.every((task) => task['title'] !== 'B task 1'),
      'no cross-project contamination',
    );
    assert.ok(
      diskTasksB.every((task) => task['title'] !== 'A task 1' && task['title'] !== 'A task 2'),
    );

    // ── Queue an edit task: it must land at awaiting_approval, and must
    // never be claimable (i.e. no Codex process can ever be launched for
    // it — the daemon never reaches the executor call for a task it will
    // not hand to a worker). ──
    const addEdit = await requestJson(
      restartedDaemon.baseUrl,
      'POST',
      `/task/add?projectId=${a.id}`,
      {
        title: 'A edit task',
        effect: 'edit',
        status: 'todo', // deliberately tries to bypass the gate — must be ignored
      },
    );
    assert.equal(addEdit.response.status, 200);
    const editTask = addEdit.json['task'] as Record<string, unknown>;
    assert.equal(
      editTask['status'],
      'awaiting_approval',
      'edit tasks are always created awaiting_approval, regardless of client-supplied status',
    );
    const editId = editTask['id'] as string;

    const claimEdit = await requestJson(
      restartedDaemon.baseUrl,
      'POST',
      `/task/claim?projectId=${a.id}`,
      {
        taskId: editId,
        agent: 'codex',
      },
    );
    assert.equal(
      claimEdit.response.status,
      400,
      'claiming an awaiting_approval task must be refused',
    );

    const stateAfterEditAttempt = await requestJson(
      restartedDaemon.baseUrl,
      'GET',
      `/state?projectId=${a.id}`,
    );
    const editAfter = (
      stateAfterEditAttempt.json['state'] as { tasks: Record<string, unknown>[] }
    ).tasks.find((task) => task['id'] === editId);
    assert.equal(
      editAfter?.['status'],
      'awaiting_approval',
      'still gated — no process was ever launched',
    );

    // ── Approving re-queues it as todo, but still does not run it itself ──
    const approve = await requestJson(
      restartedDaemon.baseUrl,
      'POST',
      `/task/approve?projectId=${a.id}`,
      {
        taskId: editId,
        approvedBy: 'test-human',
      },
    );
    assert.equal(approve.response.status, 200);
    assert.equal((approve.json['task'] as Record<string, unknown>)['status'], 'todo');
  },
);
