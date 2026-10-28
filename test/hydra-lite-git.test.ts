/**
 * Tests for lib/hydra-lite-git.ts — real git operations against disposable
 * temp repos (not mocked, since the whole point is scoped staging
 * correctness).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../lib/hydra-shared/git-ops.ts';
import {
  listChangedFiles,
  stageAndCommitFiles,
  isWorkingTreeCleanIgnoringHydraState,
} from '../lib/hydra-lite-git.ts';

const tempDirs = new Set<string>();

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-lite-git-test-'));
  tempDirs.add(dir);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial commit'], dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('listChangedFiles', () => {
  it('returns an empty array for a clean tree', () => {
    const dir = makeRepo();
    assert.deepEqual(listChangedFiles(dir), []);
  });

  it('lists a new untracked file', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'hello\n', 'utf8');
    assert.deepEqual(listChangedFiles(dir), ['NOTES.md']);
  });

  it('lists a modified tracked file', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'README.md'), '# repo\nchanged\n', 'utf8');
    assert.deepEqual(listChangedFiles(dir), ['README.md']);
  });

  it('lists multiple changed files', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'README.md'), '# repo\nchanged\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'hello\n', 'utf8');
    const files = listChangedFiles(dir).sort();
    assert.deepEqual(files, ['NOTES.md', 'README.md']);
  });

  it("excludes .hydra/ — it is Hydra Lite's own state dir, not the user's content", () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, '.hydra'));
    fs.writeFileSync(path.join(dir, '.hydra', 'AI_SYNC_STATE.json'), '{}', 'utf8');
    assert.deepEqual(listChangedFiles(dir), []);
  });

  it('excludes .hydra/ even alongside a genuinely changed file', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, '.hydra'));
    fs.writeFileSync(path.join(dir, '.hydra', 'AI_SYNC_STATE.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'hello\n', 'utf8');
    assert.deepEqual(listChangedFiles(dir), ['NOTES.md']);
  });
});

describe('isWorkingTreeCleanIgnoringHydraState', () => {
  it('is true for a clean tree', () => {
    const dir = makeRepo();
    assert.equal(isWorkingTreeCleanIgnoringHydraState(dir), true);
  });

  it('is true when only .hydra/ has changed', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, '.hydra'));
    fs.writeFileSync(path.join(dir, '.hydra', 'AI_SYNC_STATE.json'), '{}', 'utf8');
    assert.equal(isWorkingTreeCleanIgnoringHydraState(dir), true);
  });

  it('is false when a real file has unrelated uncommitted changes', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'UNRELATED.md'), 'someone else was mid-edit\n', 'utf8');
    assert.equal(isWorkingTreeCleanIgnoringHydraState(dir), false);
  });
});

describe('stageAndCommitFiles', () => {
  it('stages only the given files and commits exactly one commit', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'hello\n', 'utf8');
    const before = git(['rev-list', '--count', 'HEAD'], dir).stdout.trim();

    const { sha } = stageAndCommitFiles(dir, ['NOTES.md'], 'Hydra Lite: add notes');

    const after = git(['rev-list', '--count', 'HEAD'], dir).stdout.trim();
    assert.equal(Number(after), Number(before) + 1);
    assert.equal(git(['rev-parse', 'HEAD'], dir).stdout.trim(), sha);
    assert.deepEqual(listChangedFiles(dir), []);
  });

  it('never stages a file outside the given list (scoped, not git add -A)', () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'from the task\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'UNRELATED.md'), 'someone else was mid-edit\n', 'utf8');

    stageAndCommitFiles(dir, ['NOTES.md'], 'Hydra Lite: add notes only');

    // The unrelated file must still show up as an untracked change —
    // committing NOTES.md must not have swept it in.
    assert.deepEqual(listChangedFiles(dir), ['UNRELATED.md']);
  });

  it('throws when given an empty file list, rather than committing nothing useful', () => {
    const dir = makeRepo();
    assert.throws(() => stageAndCommitFiles(dir, [], 'empty'), /no files to stage/);
  });

  it('throws when a listed file does not exist', () => {
    const dir = makeRepo();
    assert.throws(() => stageAndCommitFiles(dir, ['does-not-exist.md'], 'bad'), /git add failed/);
  });
});
