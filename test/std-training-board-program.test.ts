// std-training-board on the Node os host against the boards the gha-almadar training route answered (tools/gha-almadar
// scripts/record-training-parity.ts), the same aws and ssh replies played by test/fixtures/fake-cli.mjs. The atom runs
// `ssh -i ~/… -l ubuntu <host>` where the route's shell ran `ssh -i <expanded home>/… ubuntu@<host>` (same login; a
// program's strings cannot hold a bare `@`). Adapted, by owner rule (no heuristics, decisions log 2026-10-19): there is no
// `phase` (the route guessed it from words in the log), and a Hugging Face eval line is not marked best.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const dir = new URL('./fixtures/training-board/', import.meta.url);
const program = fileURLToPath(new URL('board.lolo', dir));
const fake = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
interface Scenario { name: string; requests: Array<'GET' | 'POST'>; table: { [key: string]: unknown } }
type Instance = { epochs: Array<{ [field: string]: JsonValue }>; [field: string]: JsonValue };
const { scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ body: { instances: Instance[] } }>; calls: string[] }> };

const asAtomRuns = (key: string): string => key.replace('HOMEKEY', '~/.ssh/masar-training-key.pem').replace(/ ubuntu@(\S+) /, ' -l ubuntu $1 ');
function adapted(instances: Instance[]): Instance[] {
  return instances.map(({ phase: _phase, ...rest }) => ({
    ...rest,
    epochs: rest.epochs.map((e) => (typeof e.metrics === 'object' && e.metrics !== null && !Array.isArray(e.metrics) && 'eval_loss' in e.metrics ? { ...e, isBest: false } : e)),
  }));
}

describe.skipIf(KERNEL_DIR === undefined)('std-training-board on the Node os host, against the gha-almadar training route', () => {
  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const bin = mkdtempSync(join(tmpdir(), 'fake-training-bin-'));
      const savedPath = process.env.PATH;
      try {
        for (const name of ['aws', 'ssh']) symlinkSync(fake, join(bin, name));
        writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(Object.fromEntries(Object.entries(scenario.table).map(([k, v]) => [asAtomRuns(k), v]))));
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
        const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
        try {
          for (const [i, method] of scenario.requests.entries()) {
            const run = await p.dispatch('Board', method === 'POST' ? 'TRAINING_REFRESH' : 'TRAINING_LOAD', {});
            if (run.error !== undefined) throw new Error(run.error);
            const got = JSON.parse(JSON.stringify(run.emits.find((e) => e.event === 'TRAINING_BOARD')?.payload ?? null)) as { instances: Instance[]; fetchedAt: string };
            expect(got.instances, `${method} #${i}`).toEqual(adapted(recorded[index].responses[i].body.instances));
            expect(got.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          }
        } finally {
          p.close();
        }
        const calls = readFileSync(join(bin, 'fake-cli-state', 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { key: string }).key);
        expect(calls).toEqual(recorded[index].calls.map(asAtomRuns));
      } finally {
        process.env.PATH = savedPath;
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
});
