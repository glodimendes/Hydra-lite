/**
 * Tests for lib/daemon/scheduler.ts — the Hydra Lite concurrency gate.
 * Pure, no I/O, no daemon needed: fast, deterministic coverage of the core
 * "2 global / 1 per-project read, single-writer-exclusive" invariant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canClaim, countInFlight, DEFAULT_LIMITS } from '../../lib/daemon/scheduler.ts';

describe('countInFlight', () => {
  it('counts in_progress read tasks as reading', () => {
    const load = countInFlight([
      { status: 'in_progress', effect: 'read' },
      { status: 'in_progress', effect: 'read' },
      { status: 'todo', effect: 'read' },
    ]);
    assert.deepEqual(load, { reading: 2, writing: false });
  });

  it('counts an in_progress edit task as writing', () => {
    const load = countInFlight([{ status: 'in_progress', effect: 'edit' }]);
    assert.deepEqual(load, { reading: 0, writing: true });
  });

  it('treats a task with no effect field as a read', () => {
    const load = countInFlight([{ status: 'in_progress' }]);
    assert.deepEqual(load, { reading: 1, writing: false });
  });

  it('ignores non-in_progress tasks regardless of effect', () => {
    const load = countInFlight([
      { status: 'awaiting_approval', effect: 'edit' },
      { status: 'todo', effect: 'read' },
      { status: 'done', effect: 'read' },
    ]);
    assert.deepEqual(load, { reading: 0, writing: false });
  });

  it('returns zero load for an empty task list', () => {
    assert.deepEqual(countInFlight([]), { reading: 0, writing: false });
  });
});

describe('canClaim', () => {
  it('allows a read in an idle project under the global cap', () => {
    assert.equal(canClaim({}, 'p1', 'read'), true);
  });

  it('allows a read in a different project while one project is at its read cap', () => {
    const snapshot = { p1: { reading: 1, writing: false } };
    assert.equal(canClaim(snapshot, 'p2', 'read'), true);
  });

  it('rejects a second concurrent read in the same project at the default cap', () => {
    const snapshot = { p1: { reading: 1, writing: false } };
    assert.equal(canClaim(snapshot, 'p1', 'read'), false);
  });

  it('allows a second concurrent read when perProjectReadCap is raised', () => {
    const snapshot = { p1: { reading: 1, writing: false } };
    assert.equal(canClaim(snapshot, 'p1', 'read', { globalCap: 5, perProjectReadCap: 2 }), true);
  });

  it('rejects a read once the global cap is reached, even in an idle project', () => {
    const snapshot = {
      p1: { reading: 1, writing: false },
      p2: { reading: 1, writing: false },
    };
    assert.equal(canClaim(snapshot, 'p3', 'read'), false);
  });

  it('rejects an edit when the project already has a read in flight', () => {
    const snapshot = { p1: { reading: 1, writing: false } };
    assert.equal(canClaim(snapshot, 'p1', 'edit'), false);
  });

  it('rejects an edit when the project already has an edit in flight', () => {
    const snapshot = { p1: { reading: 0, writing: true } };
    assert.equal(canClaim(snapshot, 'p1', 'edit'), false);
  });

  it('rejects a read when the project already has an edit in flight', () => {
    const snapshot = { p1: { reading: 0, writing: true } };
    assert.equal(canClaim(snapshot, 'p1', 'read'), false);
  });

  it('allows an edit in an idle project under the global cap', () => {
    assert.equal(canClaim({}, 'p1', 'edit'), true);
  });

  it('rejects an edit once the global cap is reached', () => {
    const snapshot = {
      p1: { reading: 1, writing: false },
      p2: { reading: 1, writing: false },
    };
    assert.equal(canClaim(snapshot, 'p3', 'edit'), false);
  });

  it('matches "one task per project at a time" at the milestone-1 default limits', () => {
    assert.deepEqual(DEFAULT_LIMITS, { globalCap: 2, perProjectReadCap: 1 });
  });
});
