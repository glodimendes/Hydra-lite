/**
 * Tests for lib/hydra-lite-process-registry.ts.
 *
 * Uses real spawned `sleep`/`cat` processes (not mocks) so the signal
 * delivery and exit-cleanup assertions are about real OS behavior, not
 * about whether a mock was called correctly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  registerChild,
  killAllChildren,
  killAllChildrenSync,
  registeredChildCountForTests,
} from '../lib/hydra-lite-process-registry.ts';

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

describe('registerChild', () => {
  it('removes the child from the registry once it exits on its own', async () => {
    const before = registeredChildCountForTests();
    const child = spawn('true', []);
    registerChild(child);
    assert.equal(registeredChildCountForTests(), before + 1);
    await waitForExit(child);
    assert.equal(registeredChildCountForTests(), before);
  });
});

describe('killAllChildren', () => {
  it('kills a long-running registered child', async () => {
    const child = spawn('sleep', ['30']);
    registerChild(child);
    const exited = waitForExit(child);
    await killAllChildren(50);
    await exited;
    assert.notEqual(child.signalCode, null);
  });

  it('is a no-op when nothing is registered', async () => {
    await assert.doesNotReject(killAllChildren(10));
  });

  it('does not throw for a child that already exited', async () => {
    const child = spawn('true', []);
    registerChild(child);
    await waitForExit(child);
    await assert.doesNotReject(killAllChildren(10));
  });
});

describe('killAllChildrenSync', () => {
  it('synchronously signals a long-running registered child', async () => {
    const child = spawn('sleep', ['30']);
    registerChild(child);
    const exited = waitForExit(child);
    killAllChildrenSync();
    await exited;
    assert.notEqual(child.signalCode, null);
  });

  it('does not throw when nothing is registered', () => {
    assert.doesNotThrow(() => {
      killAllChildrenSync();
    });
  });
});
