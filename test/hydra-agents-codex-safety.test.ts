/**
 * Codex sandbox-correctness safety invariant for Hydra Lite's "Lean safety
 * spine" milestone: the entire read-only guarantee for non-approved tasks
 * rests on `-s read-only` always being passed by `invoke.nonInteractive`,
 * and the dangerous bypass flag
 * (`--dangerously-bypass-approvals-and-sandbox`) never being reachable
 * except when a caller explicitly opts in via `opts.permissionMode ===
 * 'full-auto'` — which no Hydra Lite code path does this milestone (only
 * `invoke.nonInteractive` is ever called; `invoke.headless` is not wired up
 * yet). This test locks in that shape so a future edit to
 * lib/hydra-agents.ts can't silently weaken it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAgent } from '../lib/hydra-agents.ts';

describe('codex invoke.nonInteractive (the read-only path)', () => {
  it('always includes "-s read-only"', () => {
    const codex = getAgent('codex')!;
    const [, args] = codex.invoke!.nonInteractive!('do the thing', { cwd: '/tmp/project' });
    const sIndex = args.indexOf('-s');
    assert.ok(sIndex !== -1, 'expected -s flag in nonInteractive args');
    assert.equal(args[sIndex + 1], 'read-only');
  });

  it('never includes --full-auto or the dangerous bypass flag', () => {
    const codex = getAgent('codex')!;
    const [, args] = codex.invoke!.nonInteractive!('do the thing', { cwd: '/tmp/project' });
    assert.ok(!args.includes('--full-auto'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('throws without opts.cwd, so a caller cannot accidentally omit the sandboxed root', () => {
    const codex = getAgent('codex')!;
    assert.throws(() => codex.invoke!.nonInteractive!('do the thing'), /requires opts\.cwd/);
  });
});

describe('codex invoke.headless (not reachable from Hydra Lite this milestone)', () => {
  it('defaults to the sandboxed --full-auto flag, not the dangerous bypass', () => {
    const codex = getAgent('codex')!;
    const [, args] = codex.invoke!.headless!('do the thing', { cwd: '/tmp/project' });
    assert.ok(args.includes('--full-auto'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('only escalates to the dangerous bypass when a caller explicitly sets permissionMode: "full-auto"', () => {
    const codex = getAgent('codex')!;
    const [, args] = codex.invoke!.headless!('do the thing', {
      cwd: '/tmp/project',
      permissionMode: 'full-auto',
    });
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--full-auto'));
  });
});
