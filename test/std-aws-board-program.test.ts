// std-aws-board on the Node os host against the boards the gha-almadar aws route answered (archive/tools/gha-almadar
// scripts/record-aws-parity.ts), the clock frozen at the scenarios' `now` on both sides and the same aws replies played by
// test/fixtures/fake-cli.mjs: the same board and the same aws calls in order. Adapted, by owner rule (no heuristics,
// decisions log 2026-10-19): the G/VT quota's `used` sums catalog vCPUs of the running G/VT-family instances (the route
// guessed 4 or 8 per instance from its type name), and each quota says whether that sum is complete.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const dir = new URL('./fixtures/aws-board/', import.meta.url);
const program = fileURLToPath(new URL('board.lolo', dir));
const fake = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
interface Scenario { name: string; requests: Array<'GET' | 'POST'>; table: { [key: string]: unknown } }
type Board = { quotas: Array<{ [field: string]: JsonValue }>; [field: string]: JsonValue };
const { now, scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { now: string; scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ body: Board }>; calls: string[] }> };

/** The on-demand quota's use, from the catalog: g5.xlarge (4) + g4dn.12xlarge (48) are the running G/VT instances. */
const USED: { [scenario: number]: { [quota: string]: number } } = { 0: { 'On-Demand G/VT instances (vCPUs)': 52 } };
function adapted(index: number, board: Board): Board {
  return { ...board, quotas: board.quotas.map((q) => ({ ...q, used: USED[index]?.[String(q.name)] ?? q.used, usedComplete: true })) };
}

async function read(scenario: Scenario, table: { [key: string]: unknown }): Promise<{ boards: JsonValue[]; calls: string[] }> {
  const bin = mkdtempSync(join(tmpdir(), 'fake-aws-bin-'));
  const savedPath = process.env.PATH;
  try {
    symlinkSync(fake, join(bin, 'aws'));
    writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(table));
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
    const boards: JsonValue[] = [];
    try {
      for (const method of scenario.requests) {
        const run = await p.dispatch('Board', method === 'POST' ? 'AWS_REFRESH' : 'AWS_LOAD', {});
        if (run.error !== undefined) throw new Error(run.error);
        boards.push(JSON.parse(JSON.stringify(run.emits.find((e) => e.event === 'AWS_BOARD')?.payload ?? null)) as JsonValue);
      }
    } finally {
      p.close();
    }
    const calls = readFileSync(join(bin, 'fake-cli-state', 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { key: string }).key);
    return { boards, calls };
  } finally {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

describe.skipIf(KERNEL_DIR === undefined)('std-aws-board on the Node os host, against the gha-almadar aws route', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const { boards, calls } = await read(scenario, scenario.table);
      expect(boards).toEqual(recorded[index].responses.map((r) => adapted(index, r.body)));
      expect(calls).toEqual(recorded[index].calls);
    });
  }

  it('control: a different instance list changes the board, so the comparison reads the instances', async () => {
    const scenario = scenarios[0];
    const key = Object.keys(scenario.table).find((k) => k.startsWith('aws ec2 describe-instances ')) ?? '';
    const { boards } = await read(scenario, { ...scenario.table, [key]: [{ stdout: '[[["i-9","t3.small","running","x","2026-10-15T00:00:00.000Z",null,"us-east-1a"]]]' }] });
    expect(boards[0]).not.toEqual(adapted(0, recorded[0].responses[0].body));
  });
});
