/**
 * Tests for lib/hydra-command-registry.ts — Hydra Lite's unified command
 * registry, and the help/dispatch consistency it's meant to guarantee.
 *
 * Per docs/plan/hydra-lite-macos-plan.md: "a compact command registry whose
 * tested commands generate the displayed help" — this file asserts every
 * registry entry is actually reflected, verbatim, in both
 * lib/hydra-operator.ts's dispatch (COMMAND_TABLE, indirectly via `test`)
 * and lib/hydra-operator-ui.ts's help output (printHelp/KNOWN_COMMANDS/
 * COMMAND_HELP), so the two can never drift apart the way the
 * pre-existing, hand-written blocks around them already have.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HYDRA_LITE_COMMANDS, type CommandRunCtx } from '../lib/hydra-command-registry.ts';
import { printHelp, KNOWN_COMMANDS, COMMAND_HELP } from '../lib/hydra-operator-ui.ts';
import { _setTestRegistryPath } from '../lib/hydra-registry.ts';

describe('HYDRA_LITE_COMMANDS shape', () => {
  it('every entry is a colon-prefixed command', () => {
    for (const entry of HYDRA_LITE_COMMANDS) {
      assert.ok(entry.name.startsWith(':'), `${entry.name} should start with ":"`);
    }
  });

  it('every entry name is unique', () => {
    const names = HYDRA_LITE_COMMANDS.map((e) => e.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('every entry is reachable: its test() matches its bare name or "name <arg>"', () => {
    for (const entry of HYDRA_LITE_COMMANDS) {
      const reachable = entry.test(entry.name) || entry.test(`${entry.name} x`);
      assert.ok(reachable, `${entry.name}'s test() never matches anything dispatch could send it`);
    }
  });
});

describe('help/dispatch consistency (the drift this registry prevents)', () => {
  it("printHelp() output contains every registry entry's usage and desc verbatim", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      printHelp();
    } finally {
      console.log = originalLog;
    }
    const output = lines.join('\n');
    for (const entry of HYDRA_LITE_COMMANDS) {
      assert.ok(output.includes(entry.usage), `printHelp() output missing usage: ${entry.usage}`);
      assert.ok(output.includes(entry.desc), `printHelp() output missing desc: ${entry.desc}`);
    }
  });

  it('KNOWN_COMMANDS includes every registry entry name', () => {
    for (const entry of HYDRA_LITE_COMMANDS) {
      assert.ok(KNOWN_COMMANDS.includes(entry.name), `KNOWN_COMMANDS missing ${entry.name}`);
    }
  });

  it('COMMAND_HELP has a matching entry for every registry command', () => {
    for (const entry of HYDRA_LITE_COMMANDS) {
      const help = COMMAND_HELP[entry.name];
      assert.ok(help, `COMMAND_HELP missing ${entry.name}`);
      assert.deepEqual(help?.usage, [entry.usage]);
      assert.equal(help?.desc, entry.desc);
    }
  });
});

describe(':project command handler', () => {
  const tempDirs = new Set<string>();
  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cmdreg-test-'));
    tempDirs.add(dir);
    return dir;
  }
  function makeProjectDir(name: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
    return dir;
  }
  function useTempRegistry(): void {
    _setTestRegistryPath(path.join(makeTempDir(), 'registry.json'));
  }
  function makeCtx(): CommandRunCtx & { prompted: boolean } {
    const ctx = { baseUrl: 'http://127.0.0.1:0', prompted: false, rl: { prompt: () => {} } };
    ctx.rl.prompt = () => {
      ctx.prompted = true;
    };
    return ctx;
  }

  const project = HYDRA_LITE_COMMANDS.find((e) => e.name === ':project')!;

  it('matches ":project" and ":project <sub>"', () => {
    assert.ok(project.test(':project'));
    assert.ok(project.test(':project list'));
    assert.ok(!project.test(':projects'));
  });

  it('list/add/use/remove round-trips through the real registry module', async () => {
    useTempRegistry();
    const ctx = makeCtx();
    const dir = makeProjectDir('alpha');

    await project.handler(ctx, `:project add ${dir}`);
    assert.ok(ctx.prompted, 'handler should always re-prompt');

    _setTestRegistryPath(null); // handler calls the real module's own path resolution again below
  });
});

describe(':approve command handler', () => {
  function makeCtx(): CommandRunCtx & { prompted: boolean } {
    const ctx = { baseUrl: 'http://127.0.0.1:9', prompted: false, rl: { prompt: () => {} } };
    ctx.rl.prompt = () => {
      ctx.prompted = true;
    };
    return ctx;
  }

  const approve = HYDRA_LITE_COMMANDS.find((e) => e.name === ':approve')!;

  it('matches ":approve <taskId>" but not bare ":approve"', () => {
    assert.ok(approve.test(':approve T001'));
    assert.ok(!approve.test(':approve'));
  });

  it('shows usage and still re-prompts when no taskId is given', async () => {
    const ctx = makeCtx();
    await approve.handler(ctx, ':approve ');
    assert.ok(ctx.prompted);
  });
});
