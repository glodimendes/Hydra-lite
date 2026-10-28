/**
 * Tests for lib/hydra-tier.ts — Hydra Lite's deterministic Codex tier.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier, tierToReasoningEffort } from '../lib/hydra-tier.ts';

describe('resolveTier', () => {
  it('defaults a read task to low with no override', () => {
    assert.equal(resolveTier('read'), 'low');
  });

  it('defaults a read task to low with override "auto"', () => {
    assert.equal(resolveTier('read', 'auto'), 'low');
  });

  it('honors an explicit override for a read task', () => {
    assert.equal(resolveTier('read', 'high'), 'high');
    assert.equal(resolveTier('read', 'balanced'), 'balanced');
  });

  it('floors an edit task at balanced with no override', () => {
    assert.equal(resolveTier('edit'), 'balanced');
  });

  it('floors an edit task at balanced when override is "auto"', () => {
    assert.equal(resolveTier('edit', 'auto'), 'balanced');
  });

  it('raises a "low" override to "balanced" for an edit task, never rejecting it', () => {
    assert.equal(resolveTier('edit', 'low'), 'balanced');
  });

  it('honors an override at or above balanced for an edit task', () => {
    assert.equal(resolveTier('edit', 'balanced'), 'balanced');
    assert.equal(resolveTier('edit', 'high'), 'high');
  });
});

describe('tierToReasoningEffort', () => {
  it('maps low -> low, balanced -> medium, high -> high', () => {
    assert.equal(tierToReasoningEffort('low'), 'low');
    assert.equal(tierToReasoningEffort('balanced'), 'medium');
    assert.equal(tierToReasoningEffort('high'), 'high');
  });
});
