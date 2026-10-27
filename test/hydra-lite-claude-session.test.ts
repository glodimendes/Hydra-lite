/**
 * Tests for lib/hydra-lite-claude-session.ts.
 *
 * REAL_ERROR_OUTPUT below is literal output captured from a real
 * `claude -p ... --output-format json` run against the installed Claude
 * Code CLI (2.1.308) — its own OAuth session had expired, which is why
 * `is_error` is true here; the shape (a single JSON object, not JSONL,
 * with `is_error`/`result`/`session_id`/`type` fields) is what
 * parseResultJson is written against. A successful-run fixture isn't
 * available yet (same expired-session blocker), so SUCCESS_OUTPUT below is
 * constructed from that same observed shape, not live-captured — it's
 * only as trustworthy as that assumption until this module gets its real
 * end-to-end verification.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskArgs,
  buildAskResumeArgs,
  buildEditArgs,
  buildEditResumeArgs,
  parseResultJson,
} from '../lib/hydra-lite-claude-session.ts';

const REAL_ERROR_OUTPUT = JSON.stringify({
  duration_api_ms: 0,
  stop_reason: 'stop_sequence',
  session_id: 'fc56ec0b-c77d-43e0-9c19-fb3884616f7a',
  total_cost_usd: 0,
  is_error: true,
  num_turns: 1,
  subtype: 'success',
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  type: 'result',
  duration_ms: 96,
});

const SUCCESS_OUTPUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'greet.js exports a single greet(name) function.',
  session_id: '11111111-2222-3333-4444-555555555555',
});

describe('buildAskArgs', () => {
  it('always includes --permission-mode plan', () => {
    const [, args] = buildAskArgs('what does this project do?');
    const modeIndex = args.indexOf('--permission-mode');
    assert.ok(modeIndex !== -1, 'expected --permission-mode flag');
    assert.equal(args[modeIndex + 1], 'plan');
  });

  it('passes the prompt via -p and requests JSON output', () => {
    const [cmd, args] = buildAskArgs('what does this project do?');
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'what does this project do?',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
    ]);
  });
});

describe('buildAskResumeArgs', () => {
  it('includes -r with the session id and stays in plan mode', () => {
    const [cmd, args] = buildAskResumeArgs(
      '11111111-2222-3333-4444-555555555555',
      'follow-up question',
    );
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'follow-up question',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      '-r',
      '11111111-2222-3333-4444-555555555555',
    ]);
  });
});

describe('buildEditArgs', () => {
  it('always includes --permission-mode acceptEdits and --permission-prompts none', () => {
    const [, args] = buildEditArgs('add a file');
    const modeIndex = args.indexOf('--permission-mode');
    assert.ok(modeIndex !== -1, 'expected --permission-mode flag');
    assert.equal(args[modeIndex + 1], 'acceptEdits');
    const promptsIndex = args.indexOf('--permission-prompts');
    assert.ok(promptsIndex !== -1, 'expected --permission-prompts flag');
    assert.equal(args[promptsIndex + 1], 'none');
  });

  it('never includes the dangerous bypass flag or --worktree', () => {
    const [, args] = buildEditArgs('add a file');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('-w'));
    assert.ok(!args.includes('--worktree'));
  });

  it('passes the prompt via -p and requests JSON output', () => {
    const [cmd, args] = buildEditArgs('add a NOTES.md file');
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'add a NOTES.md file',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
    ]);
  });
});

describe('buildEditResumeArgs', () => {
  it('includes -r with the session id and stays in acceptEdits mode', () => {
    const [cmd, args] = buildEditResumeArgs(
      '11111111-2222-3333-4444-555555555555',
      'fix the failing test',
    );
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'fix the failing test',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '-r',
      '11111111-2222-3333-4444-555555555555',
    ]);
  });
});

describe('parseResultJson', () => {
  it('parses a real error response (expired OAuth session)', () => {
    const parsed = parseResultJson(REAL_ERROR_OUTPUT);
    assert.ok(parsed != null);
    assert.equal(parsed.is_error, true);
    assert.equal(parsed.session_id, 'fc56ec0b-c77d-43e0-9c19-fb3884616f7a');
    assert.match(parsed.result ?? '', /OAuth session expired/);
  });

  it('parses a successful response', () => {
    const parsed = parseResultJson(SUCCESS_OUTPUT);
    assert.ok(parsed != null);
    assert.equal(parsed.is_error, false);
    assert.equal(parsed.session_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(parsed.result, 'greet.js exports a single greet(name) function.');
  });

  it('tolerates surrounding whitespace', () => {
    const parsed = parseResultJson(`\n${SUCCESS_OUTPUT}\n`);
    assert.ok(parsed != null);
    assert.equal(parsed.is_error, false);
  });

  it('returns null for non-JSON output', () => {
    assert.equal(parseResultJson('not json at all'), null);
  });
});
