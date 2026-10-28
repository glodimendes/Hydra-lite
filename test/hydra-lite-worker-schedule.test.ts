/**
 * Tests for lib/hydra-lite-worker-schedule.ts — the worker's weighted
 * round-robin project/task picker. Pure, no I/O, no daemon needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNext,
  createCreditMap,
  weightFromPriority,
  type SchedulableProject,
} from '../lib/hydra-lite-worker-schedule.ts';

describe('weightFromPriority', () => {
  it('maps unset/0 priority to the baseline weight of 1', () => {
    assert.equal(weightFromPriority(), 1);
    assert.equal(weightFromPriority(0), 1);
  });

  it('adds one share per +1 priority', () => {
    assert.equal(weightFromPriority(4), 5);
    assert.equal(weightFromPriority(9), 10);
  });

  it('floors negative priority at weight 1 — deprioritized, never starved', () => {
    assert.equal(weightFromPriority(-1), 1);
    assert.equal(weightFromPriority(-100), 1);
  });
});

describe('pickNext', () => {
  it('returns null when no project has a runnable task', () => {
    const projects: SchedulableProject[] = [
      { projectId: 'p1', tasks: [] },
      { projectId: 'p2', tasks: [] },
    ];
    assert.equal(pickNext(projects, createCreditMap()), null);
  });

  it('always picks the only eligible project', () => {
    const projects: SchedulableProject[] = [
      { projectId: 'p1', tasks: [{ id: 'T1', approvedAt: '2026-01-01T00:00:00Z' }] },
    ];
    const pick = pickNext(projects, createCreditMap());
    assert.deepEqual(pick, { projectId: 'p1', taskId: 'T1' });
  });

  it('distributes picks proportional to weight (5:1 over 6 picks)', () => {
    // Project B (priority 4 -> weight 5) should get picked 5 times to
    // project A's (priority 0 -> weight 1) 1 time across 6 total picks —
    // the documented example from the design discussion.
    const makeProjects = (aTasks: number, bTasks: number): SchedulableProject[] => [
      {
        projectId: 'A',
        priority: 0,
        tasks: Array.from({ length: aTasks }, (_, i) => ({
          id: `A${String(i)}`,
          approvedAt: `2026-01-01T00:00:0${String(i)}Z`,
        })),
      },
      {
        projectId: 'B',
        priority: 4,
        tasks: Array.from({ length: bTasks }, (_, i) => ({
          id: `B${String(i)}`,
          approvedAt: `2026-01-01T00:00:0${String(i)}Z`,
        })),
      },
    ];

    const credits = createCreditMap();
    const picks: string[] = [];
    let remainingA = 10;
    let remainingB = 10;
    for (let i = 0; i < 6; i++) {
      const projects = makeProjects(remainingA, remainingB);
      const pick = pickNext(projects, credits);
      assert.ok(pick);
      picks.push(pick.projectId);
      if (pick.projectId === 'A') remainingA -= 1;
      else remainingB -= 1;
    }

    const bCount = picks.filter((p) => p === 'B').length;
    const aCount = picks.filter((p) => p === 'A').length;
    assert.equal(bCount, 5);
    assert.equal(aCount, 1);
  });

  it('eventually picks a weight-1 project within one window of (sum of weights) picks, even against a much higher weight', () => {
    // Classic weighted-round-robin property: over any window of
    // (weightLow + weightHigh) consecutive picks, each project gets picks
    // proportional to its weight — low's fair share here is exactly 1 in
    // 11, not zero, so it must appear at least once in 11 picks (listing
    // it first in the input array makes it also win the credit tie it's
    // guaranteed to hit on its "turn").
    const credits = createCreditMap();
    let remainingLow = 5;
    let remainingHigh = 50;
    const picks: string[] = [];
    for (let i = 0; i < 11; i++) {
      const projects: SchedulableProject[] = [
        {
          projectId: 'low',
          priority: 0,
          tasks: Array.from({ length: remainingLow }, (_, j) => ({
            id: `low${String(j)}`,
            approvedAt: '2026-01-01T00:00:00Z',
          })),
        },
        {
          projectId: 'high',
          priority: 9,
          tasks: Array.from({ length: remainingHigh }, (_, j) => ({
            id: `high${String(j)}`,
            approvedAt: '2026-01-01T00:00:00Z',
          })),
        },
      ];
      const pick = pickNext(projects, credits);
      assert.ok(pick);
      picks.push(pick.projectId);
      if (pick.projectId === 'low') remainingLow -= 1;
      else remainingHigh -= 1;
    }
    assert.ok(
      picks.includes('low'),
      'the weight-1 project must get at least its proportional share, not zero',
    );
  });

  it('drops a project from rotation once it has no runnable tasks left', () => {
    const credits = createCreditMap();
    // B starts with 1 task and much higher weight; once consumed, A (with
    // tasks remaining) must be picked instead of returning null.
    let bTasks = [{ id: 'B0', approvedAt: '2026-01-01T00:00:00Z' }];
    const aTasks = [{ id: 'A0', approvedAt: '2026-01-01T00:00:00Z' }];

    const first = pickNext(
      [
        { projectId: 'A', priority: 0, tasks: aTasks },
        { projectId: 'B', priority: 99, tasks: bTasks },
      ],
      credits,
    );
    assert.equal(first?.projectId, 'B');
    bTasks = [];

    const second = pickNext(
      [
        { projectId: 'A', priority: 0, tasks: aTasks },
        { projectId: 'B', priority: 99, tasks: bTasks },
      ],
      credits,
    );
    assert.deepEqual(second, { projectId: 'A', taskId: 'A0' });
  });

  it('within a project, picks the highest task priority first', () => {
    const projects: SchedulableProject[] = [
      {
        projectId: 'p1',
        tasks: [
          { id: 'low', priority: 0, approvedAt: '2026-01-01T00:00:00Z' },
          { id: 'high', priority: 5, approvedAt: '2026-01-02T00:00:00Z' },
        ],
      },
    ];
    const pick = pickNext(projects, createCreditMap());
    assert.equal(pick?.taskId, 'high');
  });

  it('within a project, breaks equal task priority by oldest approvedAt', () => {
    const projects: SchedulableProject[] = [
      {
        projectId: 'p1',
        tasks: [
          { id: 'newer', priority: 0, approvedAt: '2026-01-02T00:00:00Z' },
          { id: 'older', priority: 0, approvedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    ];
    const pick = pickNext(projects, createCreditMap());
    assert.equal(pick?.taskId, 'older');
  });

  it('breaks an equal-credit tie by earlier position in the input array', () => {
    const credits = createCreditMap();
    const projects: SchedulableProject[] = [
      { projectId: 'first', tasks: [{ id: 'f0', approvedAt: '2026-01-01T00:00:00Z' }] },
      { projectId: 'second', tasks: [{ id: 's0', approvedAt: '2026-01-01T00:00:00Z' }] },
    ];
    const pick = pickNext(projects, credits);
    assert.equal(pick?.projectId, 'first');
  });
});
