/**
 * Tests for lib/hydra-registry.ts — the Hydra Lite macOS project registry.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _setTestRegistryPath,
  addProject,
  listProjects,
  getCurrentProjectId,
  findProject,
  findProjectByName,
  resolveProjectByNameOrId,
  useProject,
  removeProject,
  ProjectRegistryError,
} from '../lib/hydra-registry.ts';

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-registry-test-'));
  tempDirs.add(dir);
  return dir;
}

function makeProjectDir(name = 'proj'): string {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
  return dir;
}

afterEach(() => {
  _setTestRegistryPath(null);
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function useTempRegistry(): void {
  const dir = makeTempDir();
  _setTestRegistryPath(path.join(dir, 'registry.json'));
}

describe('addProject', () => {
  it('registers a valid project and returns id/name/path', () => {
    useTempRegistry();
    const projectDir = makeProjectDir('alpha');

    const entry = addProject(projectDir);

    assert.ok(entry.id.length > 0);
    assert.equal(entry.name, 'alpha');
    assert.equal(entry.path, fs.realpathSync(projectDir));
  });

  it('rejects a directory with no project markers', () => {
    useTempRegistry();
    const dir = makeTempDir();

    assert.throws(() => addProject(dir), ProjectRegistryError);
  });

  it('rejects registering the same resolved path twice', () => {
    useTempRegistry();
    const projectDir = makeProjectDir('alpha');
    addProject(projectDir);

    assert.throws(() => addProject(projectDir), /already registered/);
  });

  it('rejects registering two projects with the same name', () => {
    useTempRegistry();
    const dirA = makeProjectDir('same-name');
    const dirB = makeProjectDir('same-name');

    addProject(dirA);
    assert.throws(() => addProject(dirB), /name already registered/);
  });

  it('sets the first registered project as current', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('first'));

    assert.equal(getCurrentProjectId(), entry.id);
  });

  it('does not change current when a second project is added', () => {
    useTempRegistry();
    const first = addProject(makeProjectDir('first'));
    addProject(makeProjectDir('second'));

    assert.equal(getCurrentProjectId(), first.id);
  });
});

describe('listProjects / findProject', () => {
  it('lists every registered project', () => {
    useTempRegistry();
    const a = addProject(makeProjectDir('alpha'));
    const b = addProject(makeProjectDir('beta'));

    const projects = listProjects();
    assert.equal(projects.length, 2);
    assert.ok(projects.some((p) => p.id === a.id));
    assert.ok(projects.some((p) => p.id === b.id));
  });

  it('returns an empty array when nothing is registered', () => {
    useTempRegistry();
    assert.deepEqual(listProjects(), []);
  });

  it('finds a project by id', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.deepEqual(findProject(entry.id), entry);
  });

  it('returns undefined for an unknown id', () => {
    useTempRegistry();
    assert.equal(findProject('does-not-exist'), undefined);
  });
});

describe('findProjectByName / resolveProjectByNameOrId', () => {
  it('finds a project by exact name', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.deepEqual(findProjectByName('alpha'), entry);
  });

  it('is case-insensitive', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.deepEqual(findProjectByName('ALPHA'), entry);
    assert.deepEqual(findProjectByName('AlPhA'), entry);
  });

  it('returns undefined for an unknown name', () => {
    useTempRegistry();
    assert.equal(findProjectByName('does-not-exist'), undefined);
  });

  it('resolveProjectByNameOrId prefers a name match', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.deepEqual(resolveProjectByNameOrId('alpha'), entry);
  });

  it('resolveProjectByNameOrId falls back to id when no name matches', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.deepEqual(resolveProjectByNameOrId(entry.id), entry);
  });

  it('resolveProjectByNameOrId returns undefined when neither matches', () => {
    useTempRegistry();
    addProject(makeProjectDir('alpha'));

    assert.equal(resolveProjectByNameOrId('nope'), undefined);
  });
});

describe('useProject', () => {
  it('sets the current project pointer by id', () => {
    useTempRegistry();
    addProject(makeProjectDir('alpha'));
    const beta = addProject(makeProjectDir('beta'));

    useProject(beta.id);

    assert.equal(getCurrentProjectId(), beta.id);
  });

  it('throws for an unregistered id', () => {
    useTempRegistry();
    assert.throws(() => useProject('nope'), ProjectRegistryError);
  });
});

describe('removeProject', () => {
  it('drops the registry entry but keeps .hydra/ on disk by default', () => {
    useTempRegistry();
    const projectDir = makeProjectDir('alpha');
    const entry = addProject(projectDir);
    const hydraDir = path.join(projectDir, '.hydra');
    fs.mkdirSync(hydraDir, { recursive: true });
    fs.writeFileSync(path.join(hydraDir, 'AI_SYNC_STATE.json'), '{}', 'utf8');

    removeProject(entry.id);

    assert.equal(findProject(entry.id), undefined);
    assert.equal(fs.existsSync(hydraDir), true);
  });

  it('deletes .hydra/ when purge is requested', () => {
    useTempRegistry();
    const projectDir = makeProjectDir('alpha');
    const entry = addProject(projectDir);
    const hydraDir = path.join(projectDir, '.hydra');
    fs.mkdirSync(hydraDir, { recursive: true });

    removeProject(entry.id, { purge: true });

    assert.equal(fs.existsSync(hydraDir), false);
  });

  it('refuses to remove a project with live tasks', () => {
    useTempRegistry();
    const entry = addProject(makeProjectDir('alpha'));

    assert.throws(() => {
      removeProject(entry.id, { hasLiveTasks: () => true });
    }, /in_progress or awaiting_approval task/);
    assert.ok(findProject(entry.id));
  });

  it('clears current when the current project is removed, picking another if any', () => {
    useTempRegistry();
    const a = addProject(makeProjectDir('alpha'));
    const b = addProject(makeProjectDir('beta'));
    assert.equal(getCurrentProjectId(), a.id);

    removeProject(a.id);

    assert.equal(getCurrentProjectId(), b.id);
  });

  it('throws for an unregistered id', () => {
    useTempRegistry();
    assert.throws(() => {
      removeProject('nope');
    }, ProjectRegistryError);
  });
});
