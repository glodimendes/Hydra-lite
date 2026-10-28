/**
 * Tests for lib/hydra-lite-codex-session.ts.
 *
 * FRESH_RUN_OUTPUT/RESUME_RUN_OUTPUT are literal output captured from a
 * real `codex exec ... --json` run against the installed codex-cli
 * (0.163.0), including the real "Reading additional input from
 * stdin..." noise line codex prints before the JSON stream starts. The
 * single-line fixtures inline inside the formatCodexProgressEvent tests
 * below are constructed to exercise item types other than agent_message
 * (never observed live) — not captured output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskArgs,
  buildResumeArgs,
  buildEditArgs,
  parseThreadId,
  parseAgentMessage,
  parseUsage,
  formatCodexProgressEvent,
} from '../lib/hydra-lite-codex-session.ts';

const FRESH_RUN_OUTPUT = [
  'Reading additional input from stdin...',
  '{"type":"thread.started","thread_id":"01a166b5-8a83-7640-b2b0-3be3bcdb3777"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":18490,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  '',
].join('\n');

const RESUME_RUN_OUTPUT = [
  '{"type":"thread.started","thread_id":"01a166b5-dafd-7660-956c-c600cbde01ed"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"BANANA"}}',
  '{"type":"turn.completed","usage":{"input_tokens":38385,"cached_input_tokens":24320,"cache_write_input_tokens":0,"output_tokens":12,"reasoning_output_tokens":0}}',
  '',
].join('\n');

describe('buildAskArgs', () => {
  it('always includes -s read-only', () => {
    const [, args] = buildAskArgs('hello', { cwd: '/tmp/project' });
    const sIndex = args.indexOf('-s');
    assert.ok(sIndex !== -1, 'expected -s flag');
    assert.equal(args[sIndex + 1], 'read-only');
  });

  it('passes the prompt and cwd, and requests JSONL output', () => {
    const [cmd, args] = buildAskArgs('what does this project do?', { cwd: '/tmp/project' });
    assert.equal(cmd, 'codex');
    assert.deepEqual(args, [
      'exec',
      'what does this project do?',
      '-s',
      'read-only',
      '-C',
      '/tmp/project',
      '--json',
    ]);
  });
});

describe('buildResumeArgs', () => {
  it('never includes -C or -s (the real CLI rejects both on resume)', () => {
    const [, args] = buildResumeArgs('01a166b5-8a83-7640-b2b0-3be3bcdb3777', 'follow-up question');
    assert.ok(!args.includes('-C'));
    assert.ok(!args.includes('-s'));
  });

  it('passes the thread id and prompt, and requests JSONL output', () => {
    const [cmd, args] = buildResumeArgs('01a166b5-8a83-7640-b2b0-3be3bcdb3777', 'follow-up');
    assert.equal(cmd, 'codex');
    assert.deepEqual(args, [
      'exec',
      'resume',
      '01a166b5-8a83-7640-b2b0-3be3bcdb3777',
      'follow-up',
      '--json',
    ]);
  });
});

describe('buildEditArgs', () => {
  it('always includes -s workspace-write', () => {
    const [, args] = buildEditArgs('add a file', { cwd: '/tmp/project' });
    const sIndex = args.indexOf('-s');
    assert.ok(sIndex !== -1, 'expected -s flag');
    assert.equal(args[sIndex + 1], 'workspace-write');
  });

  it('never includes the dangerous bypass flag, --worktree, or the nonexistent --full-auto flag', () => {
    const [, args] = buildEditArgs('add a file', { cwd: '/tmp/project' });
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--worktree'));
    assert.ok(!args.includes('--full-auto'));
  });

  it('passes the prompt and cwd, and requests JSONL output', () => {
    const [cmd, args] = buildEditArgs('add a NOTES.md file', { cwd: '/tmp/project' });
    assert.equal(cmd, 'codex');
    assert.deepEqual(args, [
      'exec',
      'add a NOTES.md file',
      '-s',
      'workspace-write',
      '-C',
      '/tmp/project',
      '--json',
    ]);
  });
});

describe('parseThreadId', () => {
  it('extracts the thread id from a real fresh-run JSONL output', () => {
    assert.equal(parseThreadId(FRESH_RUN_OUTPUT), '01a166b5-8a83-7640-b2b0-3be3bcdb3777');
  });

  it('extracts the thread id from a real resume-run JSONL output', () => {
    assert.equal(parseThreadId(RESUME_RUN_OUTPUT), '01a166b5-dafd-7660-956c-c600cbde01ed');
  });

  it('skips non-JSON noise lines (e.g. "Reading additional input from stdin...")', () => {
    assert.equal(
      parseThreadId(`not json at all\n${FRESH_RUN_OUTPUT}`),
      '01a166b5-8a83-7640-b2b0-3be3bcdb3777',
    );
  });

  it('returns null when there is no thread.started event', () => {
    assert.equal(parseThreadId('{"type":"turn.started"}\n'), null);
  });
});

describe('parseAgentMessage', () => {
  it('extracts the agent reply from a real fresh-run JSONL output', () => {
    assert.equal(parseAgentMessage(FRESH_RUN_OUTPUT), 'OK');
  });

  it('extracts the agent reply from a real resume-run JSONL output', () => {
    assert.equal(parseAgentMessage(RESUME_RUN_OUTPUT), 'BANANA');
  });

  it('returns the last agent_message when there are several', () => {
    const output = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      '',
    ].join('\n');
    assert.equal(parseAgentMessage(output), 'second');
  });

  it('returns null when there is no agent_message item', () => {
    assert.equal(parseAgentMessage('{"type":"turn.started"}\n'), null);
  });
});

describe('parseUsage', () => {
  it('extracts token usage from a real fresh-run turn.completed event', () => {
    const usage = parseUsage(FRESH_RUN_OUTPUT);
    assert.ok(usage != null);
    assert.equal(usage.inputTokens, 18490);
    assert.equal(usage.cachedInputTokens, 12160);
    assert.equal(usage.outputTokens, 5);
  });

  it('extracts token usage from a real resume-run turn.completed event', () => {
    const usage = parseUsage(RESUME_RUN_OUTPUT);
    assert.ok(usage != null);
    assert.equal(usage.inputTokens, 38385);
    assert.equal(usage.outputTokens, 12);
  });

  it('returns null when there is no turn.completed event', () => {
    assert.equal(parseUsage('{"type":"turn.started"}\n'), null);
  });
});

describe('formatCodexProgressEvent', () => {
  it('formats an agent_message item as a progress line', () => {
    const line = formatCodexProgressEvent(
      JSON.parse('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'),
    );
    assert.match(line ?? '', /OK/);
  });

  it('formats a non-agent_message item with its type and a detail field', () => {
    const line = formatCodexProgressEvent(
      JSON.parse(
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
      ),
    );
    assert.match(line ?? '', /command_execution/);
    assert.match(line ?? '', /npm test/);
  });

  it('returns null for a non-item.completed event', () => {
    assert.equal(formatCodexProgressEvent(JSON.parse('{"type":"turn.started"}')), null);
  });

  it('returns null for a turn.completed event', () => {
    assert.equal(
      formatCodexProgressEvent(JSON.parse('{"type":"turn.completed","usage":{}}')),
      null,
    );
  });
});
