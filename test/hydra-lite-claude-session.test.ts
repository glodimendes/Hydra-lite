/**
 * Tests for lib/hydra-lite-claude-session.ts.
 *
 * REAL_ERROR_RESULT below is literal output captured from a real
 * `claude -p ... --output-format json` run against the installed Claude
 * Code CLI (2.1.308) — its own OAuth session had expired, which is why
 * `is_error` is true here. That run used plain `json`, not `stream-json`
 * (this module switched afterward, to support progress streaming), so it
 * exercises parseResult's single-object fallback path rather than the
 * JSONL path. A real stream-json fixture isn't available yet (same
 * expired-session blocker) — SUCCESS_STREAM below is constructed from
 * Claude Code's documented stream-json shape, not live-captured, so it's
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
  parseUsage,
  formatClaudeProgressEvent,
} from '../lib/hydra-lite-claude-session.ts';

const REAL_ERROR_RESULT = JSON.stringify({
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

const SUCCESS_STREAM = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: '11111111-2222-3333-4444-555555555555',
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at greet.js now.' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'greet.js' } }],
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'greet.js exports a single greet(name) function.',
    session_id: '11111111-2222-3333-4444-555555555555',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 100 },
  }),
  '',
].join('\n');

describe('buildAskArgs', () => {
  it('always includes --permission-mode plan and streams JSONL', () => {
    const [cmd, args] = buildAskArgs('what does this project do?');
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'what does this project do?',
      '--output-format',
      'stream-json',
      '--verbose',
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
      'stream-json',
      '--verbose',
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

  it('streams JSONL just like buildAskArgs', () => {
    const [cmd, args] = buildEditArgs('add a NOTES.md file');
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, [
      '-p',
      'add a NOTES.md file',
      '--output-format',
      'stream-json',
      '--verbose',
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
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '-r',
      '11111111-2222-3333-4444-555555555555',
    ]);
  });
});

describe('parseUsage', () => {
  it('returns null for a real error response with no usage', () => {
    assert.equal(parseUsage(REAL_ERROR_RESULT), null);
  });

  it('extracts tokens and cost from a successful stream', () => {
    const usage = parseUsage(SUCCESS_STREAM);
    assert.ok(usage != null);
    assert.equal(usage.inputTokens, 500);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.cachedInputTokens, 100);
    assert.equal(usage.costUsd, 0.0123);
  });

  it('falls back to parsing a single JSON object with no JSONL result event', () => {
    const usage = parseUsage(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'ok',
        session_id: 'x',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    assert.ok(usage != null);
    assert.equal(usage.inputTokens, 1);
    assert.equal(usage.outputTokens, 2);
  });

  it('returns null for non-JSON output', () => {
    assert.equal(parseUsage('not json at all'), null);
  });
});

describe('formatClaudeProgressEvent', () => {
  it('formats an assistant text block', () => {
    const line = formatClaudeProgressEvent(
      JSON.parse(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Looking at greet.js now.' }] },
        }),
      ),
    );
    assert.match(line ?? '', /Looking at greet\.js now\./);
  });

  it('formats an assistant tool_use block by tool name', () => {
    const line = formatClaudeProgressEvent(
      JSON.parse(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        }),
      ),
    );
    assert.match(line ?? '', /Edit/);
  });

  it('returns null for a result event', () => {
    assert.equal(formatClaudeProgressEvent(JSON.parse(REAL_ERROR_RESULT)), null);
  });

  it('returns null for a system event', () => {
    assert.equal(formatClaudeProgressEvent({ type: 'system', subtype: 'init' }), null);
  });
});
