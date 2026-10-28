/**
 * Tests for lib/hydra-lite-project-config.ts — per-project `.hydra/config.json`
 * verify overrides, layered on top of the global hydra.config.json.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setTestConfig } from '../lib/hydra-config.ts';
import {
  loadProjectConfig,
  saveProjectVerificationOverride,
  resolveProjectVerificationPlan,
} from '../lib/hydra-lite-project-config.ts';

const tempDirs = new Set<string>();

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-lite-projcfg-test-'));
  tempDirs.add(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'proj' }), 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  _setTestConfig({});
});

describe('loadProjectConfig', () => {
  it('returns {} when .hydra/config.json does not exist', () => {
    const dir = makeProjectDir();
    assert.deepEqual(loadProjectConfig(dir), {});
  });

  it('returns {} for malformed JSON rather than throwing', () => {
    const dir = makeProjectDir();
    fs.mkdirSync(path.join(dir, '.hydra'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hydra', 'config.json'), 'not json', 'utf8');
    assert.deepEqual(loadProjectConfig(dir), {});
  });

  it('reads back a saved verification override', () => {
    const dir = makeProjectDir();
    saveProjectVerificationOverride(dir, { command: 'npm run lint' });
    assert.deepEqual(loadProjectConfig(dir), { verification: { command: 'npm run lint' } });
  });
});

describe('saveProjectVerificationOverride', () => {
  it('merges into an existing override rather than replacing it wholesale', () => {
    const dir = makeProjectDir();
    saveProjectVerificationOverride(dir, { command: 'npm run lint', timeoutMs: 5000 });
    saveProjectVerificationOverride(dir, { command: 'npm run test' });
    assert.deepEqual(loadProjectConfig(dir), {
      verification: { command: 'npm run test', timeoutMs: 5000 },
    });
  });

  it('clears the override when passed null', () => {
    const dir = makeProjectDir();
    saveProjectVerificationOverride(dir, { command: 'npm run lint' });
    saveProjectVerificationOverride(dir, null);
    assert.deepEqual(loadProjectConfig(dir), {});
  });
});

describe('resolveProjectVerificationPlan', () => {
  it('falls back to global config / auto-detect when there is no override', () => {
    const dir = makeProjectDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'proj', scripts: { verify: 'echo ok' } }),
      'utf8',
    );
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.enabled, true);
    assert.equal(plan.command, 'npm run verify');
    assert.equal(plan.source, 'auto');
  });

  it('a project override wins over auto-detection', () => {
    const dir = makeProjectDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'proj', scripts: { verify: 'echo ok' } }),
      'utf8',
    );
    saveProjectVerificationOverride(dir, { command: 'npm run lint' });
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.command, 'npm run lint');
  });

  it('a project override wins over the global hydra.config.json command', () => {
    const dir = makeProjectDir();
    _setTestConfig({ verification: { command: 'npm run global-verify' } });
    saveProjectVerificationOverride(dir, { command: 'npm run project-verify' });
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.command, 'npm run project-verify');
  });

  it('the global command still applies when a project has no override', () => {
    const dir = makeProjectDir();
    _setTestConfig({ verification: { command: 'npm run global-verify' } });
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.command, 'npm run global-verify');
  });

  it('"off" disables verification for that project only', () => {
    const dir = makeProjectDir();
    saveProjectVerificationOverride(dir, { command: 'off' });
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.enabled, false);
  });

  it('"auto" clears back to auto-detection', () => {
    const dir = makeProjectDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'proj', scripts: { verify: 'echo ok' } }),
      'utf8',
    );
    saveProjectVerificationOverride(dir, { command: 'off' });
    saveProjectVerificationOverride(dir, { command: 'auto' });
    const plan = resolveProjectVerificationPlan(dir);
    assert.equal(plan.enabled, true);
    assert.equal(plan.command, 'npm run verify');
  });
});
