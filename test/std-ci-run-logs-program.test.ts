// std-ci-run-logs on the Node os host against what the gha-almadar logs route answered (tools/gha-almadar
// scripts/record-logs-parity.ts), both replaying the same `gh` replies through test/fixtures/fake-cli.mjs on PATH:
// the same lines and the same gh calls in order. Adapted, by owner rule (no heuristics, decisions log 2026-10-19): the
// route guessed a level from words in the text; the atom reads it only from a leading ##[error] / ##[warning] marker.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const dir = new URL('./fixtures/ci-run-logs/', import.meta.url);
const fake = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
interface Line { job: string; step: string; msg: string; level: string }
interface Scenario { name: string; table: { [key: string]: unknown } }
const { owner, repo, runId, scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { owner: string; repo: string; runId: string; scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; response: { status: number; body: { repo: string; runId: string; lines: Line[] } }; calls: string[] }> };

/** The route's lines as the atom answers them; every changed line is named with what the route guessed. */
const ADAPTED: { [scenario: number]: { [msg: string]: Line } } = {
  0: {
    '[ERROR] Tests failed: 3': { job: 'build', step: '', msg: '[ERROR] Tests failed: 3', level: 'info' },
    'see  in the middle': { job: 'build', step: '', msg: 'see ##[error] in the middle', level: 'info' },
  },
  1: { 'failed step: error in setup': { job: '', step: '', msg: 'failed step: error in setup', level: 'info' } },
};
const adapted = (index: number, lines: Line[]): Line[] => lines.map((line) => ADAPTED[index]?.[line.msg] ?? line);

describe.skipIf(KERNEL_DIR === undefined)('std-ci-run-logs on the Node os host, against the gha-almadar logs route', () => {
  const savedPath = process.env.PATH;
  afterAll(() => { process.env.PATH = savedPath; });

  const read = async (scenario: Scenario): Promise<{ answer: EventPayload | undefined; calls: string[] }> => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-gh-bin-'));
    try {
      symlinkSync(fake, join(bin, 'gh'));
      writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(scenario.table));
      process.env.PATH = `${bin}:${savedPath ?? ''}`;
      const p = await KernelProgram.open(await resolveProgramFile(stdInfraAtom('std-ci-run-logs'), process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
      try {
        const run = await p.dispatch('CiRunLogsOrbital', 'CI_LOGS_LOAD', { owner, repo, runId });
        if (run.error !== undefined) throw new Error(run.error);
        const calls = readFileSync(join(bin, 'fake-cli-state', 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { key: string }).key);
        return { answer: run.emits.find((e) => e.event === 'CI_LOGS')?.payload, calls };
      } finally {
        p.close();
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };

  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const want = recorded[index];
      const { answer, calls } = await read(scenario);
      expect(answer).toEqual({ repo: want.response.body.repo, runId: want.response.body.runId, lines: adapted(index, want.response.body.lines) });
      expect(calls).toEqual(want.calls);
    });
  }

  it('control: a different job log changes the answer, so the comparison reads the log', async () => {
    const scenario = scenarios[0];
    const key = `gh api repos/${owner}/${repo}/actions/jobs/3/logs`;
    const { answer } = await read({ ...scenario, table: { ...scenario.table, [key]: [{ stdout: '2026-10-19T11:00:00.000Z ##[error]other\n' }] } });
    expect(answer?.lines).not.toEqual(adapted(0, recorded[0].response.body.lines));
  });
});
