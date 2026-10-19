// std-cloud-run-board on the Node os host against the boards the gha-almadar gcloud route answered (tools/gha-almadar
// scripts/record-gcloud-parity.ts), the clock frozen at the scenarios' `now` on both sides and the same gcloud and bq
// replies played by test/fixtures/fake-cli.mjs, Cloud Monitoring by a pinned fetch. Adapted, by owner rule (no
// heuristics or fallbacks, decisions log 2026-10-19): a service whose describe cannot be read has hasResourceData false
// and zero resources (the route showed Cloud Run's defaults as if configured); every service row carries hasResourceData;
// the export table is configured, so the route's `bq ls` table discovery is not run.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';

const dir = new URL('./fixtures/cloud-run-board/', import.meta.url);
const program = fileURLToPath(new URL('board.lolo', dir));
const fake = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
type CliReply = { stdout?: string; stderr?: string; code?: number };
type HttpReply = { status: number; body: JsonValue };
interface Scenario { name: string; requests: Array<'GET' | 'POST'>; monitoring?: { [metric: string]: HttpReply } }
type Row = { [field: string]: JsonValue };
interface Board { billing: Row; cloudRun: { services: Row[]; [field: string]: JsonValue }; fetchedAt: string }
const { now, scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { now: string; scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ body: Board }>; calls: string[]; httpCalls: string[]; table?: { [key: string]: CliReply[] } }> };
const T = Date.parse(now);

/** The route's rows as the atom answers them (see the header); the unreadable describe is named per scenario. */
const UNREADABLE: { [scenario: number]: string[] } = { 1: ['studio'] };
function adapted(index: number, board: Board): Board {
  return {
    ...board,
    cloudRun: {
      ...board.cloudRun,
      services: board.cloudRun.services.map((s) =>
        (UNREADABLE[index] ?? []).includes(String(s.name))
          ? { ...s, hasResourceData: false, cpu: 0, memoryGb: 0, minInstances: 0, maxInstances: 0, concurrency: 0, gpu: null, gpuCount: 0, hourlyIfUp: 0 }
          : { ...s, hasResourceData: true }),
    },
  };
}

describe.skipIf(KERNEL_DIR === undefined)('std-cloud-run-board on the Node os host, against the gha-almadar gcloud route', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; vi.restoreAllMocks(); });

  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const want = recorded[index];
      const bin = mkdtempSync(join(tmpdir(), 'fake-gcloud-bin-'));
      const httpCalls: string[] = [];
      try {
        symlinkSync(fake, join(bin, 'gcloud'));
        symlinkSync(fake, join(bin, 'bq'));
        const table = JSON.parse(readFileSync(new URL(`table-${index}.json`, dir), 'utf8')) as { [key: string]: CliReply[] };
        writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(table));
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
        vi.spyOn(Date, 'now').mockReturnValue(T);
        const http = {
          secrets: memorySecrets({}),
          fetch: async (url: URL, init: PinnedInit) => {
            const metric = /metric\.type="run\.googleapis\.com\/(?:container\/)?([a-z_]+)"/.exec(url.searchParams.get('filter') ?? '')?.[1] ?? '';
            const auth = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
            httpCalls.push(`${url.pathname}?${[...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&')} auth=${auth}`);
            const reply = scenario.monitoring?.[metric];
            if (reply === undefined) throw new Error(`no monitoring reply for ${metric}`);
            return new Response(JSON.stringify(reply.body), { status: reply.status, headers: [['content-type', 'application/json']] });
          },
          resolve: async (host: string) => ({ literal: true, addresses: [host] }),
        };
        const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true, http });
        try {
          for (const [i, method] of scenario.requests.entries()) {
            const run = await p.dispatch('Board', method === 'POST' ? 'CLOUD_RUN_REFRESH' : 'CLOUD_RUN_LOAD', {});
            if (run.error !== undefined) throw new Error(run.error);
            const got: EventPayload | undefined = run.emits.find((e) => e.event === 'CLOUD_RUN_BOARD')?.payload;
            expect(JSON.parse(JSON.stringify(got ?? null)), `${method} #${i} (as JSON, the way the board reaches a page)`).toEqual(adapted(index, want.responses[i].body));
          }
        } finally {
          p.close();
        }
        const calls = readFileSync(join(bin, 'fake-cli-state', 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { key: string }).key);
        expect([...calls].sort(), 'the route ran its describes in parallel, so the calls compare as a set').toEqual(want.calls.filter((c) => !c.includes(' ls --format=json ')).sort());
        expect(httpCalls).toEqual(want.httpCalls);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }

  it('control: a different describe reply changes the board, so the comparison reads the resources', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-gcloud-bin-'));
    try {
      symlinkSync(fake, join(bin, 'gcloud'));
      symlinkSync(fake, join(bin, 'bq'));
      const table = JSON.parse(readFileSync(new URL('table-0.json', dir), 'utf8')) as { [key: string]: CliReply[] };
      const key = Object.keys(table).find((k) => k.startsWith('gcloud run services describe studio ')) ?? '';
      table[key] = [{ stdout: (table[key]?.[0]?.stdout ?? '').replace('"cpu": "2"', '"cpu": "3"').replace('"cpu":"2"', '"cpu":"3"') }];
      writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(table));
      process.env.PATH = `${bin}:${savedPath ?? ''}`;
      vi.spyOn(Date, 'now').mockReturnValue(T);
      const http = {
        secrets: memorySecrets({}),
        fetch: async (url: URL) => {
          const metric = /([a-z_]+)"$/.exec(url.searchParams.get('filter') ?? '')?.[1] ?? '';
          const reply = scenarios[0].monitoring?.[metric];
          return new Response(JSON.stringify(reply?.body ?? {}), { status: reply?.status ?? 200, headers: [['content-type', 'application/json']] });
        },
        resolve: async (host: string) => ({ literal: true, addresses: [host] }),
      };
      const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true, http });
      try {
        const got = (await p.dispatch('Board', 'CLOUD_RUN_LOAD', {})).emits.find((e) => e.event === 'CLOUD_RUN_BOARD')?.payload;
        expect(JSON.parse(JSON.stringify(got ?? null))).not.toEqual(adapted(0, recorded[0].responses[0].body));
      } finally {
        p.close();
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

