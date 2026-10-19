// std-ci-status on the kernel against the boards the gha-almadar runs route answered (archive/tools/gha-almadar
// scripts/record-parity.ts, which replayed the same scenarios through a fake `gh`): the same runs per request, the same
// GraphQL pages asked for, the same extra repositories read, the cache window and the stale board kept.
// One adapted difference: `gh run list` reports an unfinished run's conclusion as "" where GitHub's REST and GraphQL
// say null, so the route answered "" for the extra repositories only; the atom answers null for every repository.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';

const dir = new URL('./fixtures/ci-status/', import.meta.url);
const program = fileURLToPath(new URL('almadar-ops-board.lolo', dir));

interface GraphqlReply { status: number; data?: JsonValue; errors?: JsonValue }
type RestRun = { id: number; name: string; status: string; conclusion: string | null; created_at: string; html_url: string };
interface ExtraReply { status: number; runs?: RestRun[] }
interface Scenario { name: string; requests: Array<'GET' | 'POST'>; graphql: GraphqlReply[]; extras: { [repo: string]: ExtraReply[] } }
interface RecordedRun { repo: string; fullName: string; status: string; conclusion: string | null; name: string; url: string; databaseId: number; createdAt: string }
interface RecordedCall { kind: 'graphql' | 'runs'; body?: { query: string; variables: { [name: string]: JsonValue } }; repo?: string }
interface Recorded { name: string; responses: Array<{ method: string; status: number; runs: RecordedRun[]; fetchedAtIsIso: boolean }>; calls: RecordedCall[] }

const { scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Recorded[] };
const EXTRA_FULL_NAMES = new Set(['itechdom/kflow.ai', 'itechdom/almadar-studio']);
const REASON: { [status: number]: string } = { 401: 'Bad credentials', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function github(scenario: Scenario) {
  const graphql = [...scenario.graphql];
  const extras = new Map(Object.entries(scenario.extras).map(([repo, replies]) => [repo, [...replies]]));
  const calls: RecordedCall[] = [];
  const json = (status: number, body: JsonValue) => new Response(JSON.stringify(body), { status, headers: [['content-type', 'application/json']] });
  return {
    calls,
    http: {
      secrets: memorySecrets({ GITHUB_TOKEN: 'ghp-test' }),
      fetch: async (url: URL, init: PinnedInit) => {
        if (init.method === 'POST' && url.pathname === '/graphql') {
          const body = JSON.parse(new TextDecoder().decode(init.body)) as { query: string; variables: { [name: string]: JsonValue } };
          calls.push({ kind: 'graphql', body });
          const reply = graphql.shift();
          if (reply === undefined) throw new Error('no GraphQL reply left');
          if (reply.status !== 200) return new Response(`<html>${REASON[reply.status]}</html>`, { status: reply.status });
          return json(200, { data: reply.data ?? null, ...(reply.errors !== undefined ? { errors: reply.errors } : {}) });
        }
        const runs = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(url.pathname);
        if (init.method === 'GET' && runs !== null) {
          const repo = `${runs[1]}/${runs[2]}`;
          calls.push({ kind: 'runs', repo });
          expect(url.searchParams.get('per_page')).toBe('1');
          const reply = extras.get(repo)?.shift();
          if (reply === undefined) throw new Error(`no run list reply left for ${repo}`);
          if (reply.status !== 200) return json(reply.status, { message: REASON[reply.status] });
          return json(200, { total_count: reply.runs?.length ?? 0, workflow_runs: reply.runs ?? [] });
        }
        throw new Error(`unexpected request ${init.method} ${url.href}`);
      },
      resolve: async (host: string) => ({ literal: true, addresses: [host] }),
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** One request: the board's answer, firing std-retry's backoff tick every 100 ms as a host would until it comes. */
async function board(p: KernelProgram, event: 'CI_STATUS_LOAD' | 'CI_STATUS_REFRESH'): Promise<EventPayload> {
  let run = await p.dispatch('CiBoard', event, {});
  const deadline = Date.now() + 10_000;
  for (;;) {
    const answer = run.emits.find((e) => e.event === 'CI_STATUS');
    if (answer?.payload !== undefined) return answer.payload;
    if (run.error !== undefined) throw new Error(run.error);
    if (Date.now() > deadline) throw new Error(`${event}: no CI_STATUS within 10 s`);
    await sleep(100);
    run = await p.tick('CiBoard', 'CiBoardCiRetry', 'backoffCheck');
  }
}

/** The route's runs as the atom answers them: an extra repository's "" conclusion (from `gh`) is null. */
function adapted(runs: RecordedRun[]): RecordedRun[] {
  return runs.map((run) => (EXTRA_FULL_NAMES.has(run.fullName) && run.conclusion === '' ? { ...run, conclusion: null } : run));
}

describe.skipIf(KERNEL_DIR === undefined)('std-ci-status on the kernel, against the gha-almadar runs route', () => {
  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const want = recorded[index];
      const t = github(scenario);
      const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: t.http });
      try {
        for (const [i, method] of scenario.requests.entries()) {
          const got = await board(p, method === 'POST' ? 'CI_STATUS_REFRESH' : 'CI_STATUS_LOAD');
          expect(got.runs, `${method} #${i}`).toEqual(adapted(want.responses[i].runs));
          expect(typeof got.fetchedAt === 'string' && ISO.test(got.fetchedAt)).toBe(want.responses[i].fetchedAtIsIso);
        }
        const graphqlOf = (calls: RecordedCall[]) => calls.filter((c) => c.kind === 'graphql').map((c) => c.body);
        expect(graphqlOf(t.calls)).toEqual(graphqlOf(want.calls));
        const extrasOf = (calls: RecordedCall[]) => calls.filter((c) => c.kind === 'runs').map((c) => c.repo ?? '').sort();
        expect(extrasOf(t.calls)).toEqual(extrasOf(want.calls));
      } finally {
        p.close();
      }
    }, 20_000);
  }

  it('edge: a load asked for while a page waits to be retried starts no second read; that read answers it', async () => {
    const t = github(scenarios[1]);
    const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: t.http });
    try {
      expect((await p.dispatch('CiBoard', 'CI_STATUS_LOAD', {})).emits.map((e) => e.event)).not.toContain('CI_STATUS');
      expect((await p.dispatch('CiBoard', 'CI_STATUS_LOAD', {})).emits.map((e) => e.event)).not.toContain('CI_STATUS');
      expect((await p.dispatch('CiBoard', 'CI_STATUS_REFRESH', {})).emits.map((e) => e.event)).not.toContain('CI_STATUS');
      expect(t.calls.filter((c) => c.kind === 'graphql')).toHaveLength(1);
      await sleep(600);
      const run = await p.tick('CiBoard', 'CiBoardCiRetry', 'backoffCheck');
      expect(run.emits.filter((e) => e.event === 'CI_STATUS').map((e) => e.payload?.runs)).toEqual([adapted(recorded[1].responses[0].runs)]);
      expect(t.calls.filter((c) => c.kind === 'graphql')).toHaveLength(2);
    } finally {
      p.close();
    }
  });

  it('control: with the skip list emptied the skipped repositories come back, so the comparison sees the skip list', async () => {
    const t = github(scenarios[0]);
    const source = readFileSync(program, 'utf8').replace(/skipRepos: \[[^\]]*\]/, 'skipRepos: []');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const scratch = mkdtempSync(join(tmpdir(), 'ci-status-control-'));
    try {
      const file = join(scratch, 'board.lolo');
      writeFileSync(file, source);
      const p = await KernelProgram.open(await resolveProgramFile(file, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: t.http });
      try {
        const got = await board(p, 'CI_STATUS_LOAD');
        expect(got.runs).not.toEqual(adapted(recorded[0].responses[0].runs));
        expect(Array.isArray(got.runs) ? got.runs.map((r) => (typeof r === 'object' && r !== null && !Array.isArray(r) ? r.repo : null)) : []).toContain('homebrew-tap');
      } finally {
        p.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
