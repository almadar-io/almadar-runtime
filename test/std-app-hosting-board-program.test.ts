// std-app-hosting-board on the Node os host against what the gha-almadar firebase route answered (tools/gha-almadar
// scripts/record-firebase-parity.ts): the same gcloud replies played by test/fixtures/fake-cli.mjs, the App Hosting REST
// replies the route fetched with curl played by a pinned fetch. The same answers, gcloud calls and REST reads. Adapted,
// by owner rule (no heuristics, decisions log 2026-10-19): a structured log line with no `message` shows its payload as
// JSON (the route also guessed a pino `msg` field).
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile, type ProgramRun } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';

const dir = new URL('./fixtures/app-hosting-board/', import.meta.url);
const program = fileURLToPath(new URL('board.lolo', dir));
const fake = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
type CliReply = { stdout?: string; stderr?: string; code?: number };
interface Scenario { name: string; requests: string[]; table: { [key: string]: CliReply[] } }
const { scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ path: string; body: { [field: string]: JsonValue } }>; calls: string[] }> };

const MSG: { [scenario: number]: { [msg: string]: string } } = { 2: { 'pino line': JSON.stringify({ msg: 'pino line', level: 30 }) } };
function adapted(index: number, body: { [field: string]: JsonValue }): { [field: string]: JsonValue } {
  const lines = body.lines;
  if (!Array.isArray(lines)) return body;
  return { lines: lines.map((l) => (typeof l === 'object' && l !== null && !Array.isArray(l) && typeof l.msg === 'string' && MSG[index]?.[l.msg] !== undefined ? { ...l, msg: MSG[index][l.msg] } : l)) };
}

/** One route request as the atom's event, and the answer read back in the route's response shape. */
async function ask(p: KernelProgram, path: string): Promise<{ [field: string]: JsonValue }> {
  const url = new URL(path, 'http://route');
  const [, first, second] = url.pathname.split('/');
  let run: ProgramRun;
  if (first === 'build-logs') {
    const region = url.searchParams.get('region');
    run = await p.dispatch('Board', 'AH_BUILD_LOGS_LOAD', { cloudBuildId: second, ...(region !== null ? { region } : {}) });
  } else if (second === 'logs') run = await p.dispatch('Board', 'AH_LOGS_LOAD', { backendId: first });
  else run = await p.dispatch('Board', 'AH_STATUS_LOAD', { backendId: first, force: url.searchParams.get('force') === 'true' });
  if (run.error !== undefined) throw new Error(run.error);
  const answer = run.emits.find((e) => ['AH_STATUS', 'AH_LOGS', 'AH_BUILD_LOGS'].includes(e.event));
  const payload: EventPayload = answer?.payload ?? {};
  const out = answer?.event === 'AH_STATUS' ? payload.status : { lines: payload.lines ?? null };
  return JSON.parse(JSON.stringify(out ?? null)) as { [field: string]: JsonValue };
}

describe.skipIf(KERNEL_DIR === undefined)('std-app-hosting-board on the Node os host, against the gha-almadar firebase route', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const want = recorded[index];
      const bin = mkdtempSync(join(tmpdir(), 'fake-firebase-bin-'));
      const reads: string[] = [];
      try {
        symlinkSync(fake, join(bin, 'gcloud'));
        writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(scenario.table));
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
        const http = {
          secrets: memorySecrets({}),
          fetch: async (url: URL, init: PinnedInit) => {
            const auth = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
            const key = `curl -s ${url.href} -H Authorization: ${auth}`;
            reads.push(key);
            const reply = scenario.table[key]?.[0];
            if (reply === undefined) throw new Error(`no reply for ${key}`);
            return new Response(reply.stdout ?? '', { status: 200, headers: [['content-type', 'application/json']] });
          },
          resolve: async (host: string) => ({ literal: true, addresses: [host] }),
        };
        const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true, http });
        try {
          for (const [i, path] of scenario.requests.entries()) {
            expect(await ask(p, path), path).toEqual(adapted(index, want.responses[i].body));
          }
        } finally {
          p.close();
        }
        let calls: string[] = [];
        try {
          calls = readFileSync(join(bin, 'fake-cli-state', 'calls.ndjson'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { key: string }).key);
        } catch {
          calls = [];
        }
        expect(calls).toEqual(want.calls.filter((c) => c.startsWith('gcloud ')));
        expect(reads).toEqual(want.calls.filter((c) => c.startsWith('curl ')));
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }

  it('edge: a request that arrives while a read is in flight waits, and both are answered in order', async () => {
    const scenario = scenarios[0];
    const bin = mkdtempSync(join(tmpdir(), 'fake-firebase-bin-'));
    try {
      symlinkSync(fake, join(bin, 'gcloud'));
      writeFileSync(join(bin, 'fake-cli-table.json'), JSON.stringify(scenario.table));
      process.env.PATH = `${bin}:${savedPath ?? ''}`;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      const http = {
        secrets: memorySecrets({}),
        fetch: async (url: URL, init: PinnedInit) => {
          if (first) { first = false; await held; }
          const auth = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
          const reply = scenario.table[`curl -s ${url.href} -H Authorization: ${auth}`]?.[0];
          return new Response(reply?.stdout ?? '{}', { status: 200, headers: [['content-type', 'application/json']] });
        },
        resolve: async (host: string) => ({ literal: true, addresses: [host] }),
      };
      const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true, http });
      try {
        const a = p.dispatch('Board', 'AH_STATUS_LOAD', { backendId: 'studio' });
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        const b = p.dispatch('Board', 'AH_STATUS_LOAD', { backendId: 'empty' });
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        release();
        const runs = await Promise.all([a, b]);
        const answered = runs.map((r) => r.emits.filter((e) => e.event === 'AH_STATUS').map((e) => e.payload?.backendId));
        expect(answered, 'the waiting request is answered by the read in flight, right after its own answer').toEqual([['studio', 'empty'], []]);
      } finally {
        p.close();
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

