// std-llm-spend-board on the kernel against the boards the gha-almadar llm route answered (archive/tools/gha-almadar
// scripts/record-llm-parity.ts): provider balances and the kernel trace from a pinned fetch, keys from the credential
// store (a key the route had no environment variable for is a credential the store does not hold), prices as seeded
// LlmPrice rows (the route read a file), balance snapshots kept as rows across the requests. Adapted, by owner ruling
// (decisions log 2026-10-19): there is no Anthropic row; an absent number or error is null (the route left the key out);
// an unreachable provider's error is the kernel's message, the no-trace message names the traceOrigin knob, and the
// prices are listed by provider, then model (rows have no file order).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';

const dir = new URL('./fixtures/llm-spend-board/', import.meta.url);
type Reply = { status: number; body: JsonValue } | 'unreachable';
type Price = { provider: string; model: string; promptPer1K: number; completionPer1K: number };
interface Scenario { name: string; keys: string[]; trace: boolean; prices: Price[] | null; requests: Array<'GET' | 'POST'>; replies: { [api: string]: Reply[] } }
type Obj = { [field: string]: JsonValue };
const { traceOrigin, scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { traceOrigin: string; scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ body: Obj }>; fetched: string[] }> };

const isObj = (v: JsonValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const withoutNulls = (v: JsonValue): JsonValue => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v);

/** The route's board as the atom answers it, every change named (see the header). */
function adapted(index: number, body: Obj): Obj {
  const providers = isObj(body.providers) ? body.providers : {};
  const { anthropic: _anthropic, ...rest } = providers;
  const usage = isObj(body.usage) ? body.usage : {};
  const deepseek: JsonValue = index === 2 ? { ...(isObj(rest.deepseek) ? rest.deepseek : {}), error: 'UNREACHABLE' } : (rest.deepseek ?? null);
  const usageError: JsonValue = scenarios[index].trace ? (usage.error ?? null) : 'no traceOrigin is configured; point it at a kernel server that serves /api/trace';
  const { fetchedAt: _fetchedAt, ...board } = body;
  const pricing = Array.isArray(board.modelPricing) ? [...board.modelPricing].sort((a, b) => (isObj(a) && isObj(b) ? `${String(a.provider)}\u0000${String(a.model)}`.localeCompare(`${String(b.provider)}\u0000${String(b.model)}`) : 0)) : [];
  return { ...board, modelPricing: pricing, providers: { ...rest, deepseek }, usage: { ...usage, error: usageError } };
}
function normalized(got: Obj): Obj {
  const providers = isObj(got.providers) ? got.providers : {};
  const { fetchedAt: _fetchedAt, ...board } = got;
  return {
    ...board,
    providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, isObj(v) && v.available === false && typeof v.error === 'string' && v.error.length > 0 && k === 'deepseek' && !String(v.error).startsWith('HTTP ') ? { ...withoutNulls(v) as Obj, error: 'UNREACHABLE' } : withoutNulls(v)])),
  };
}

function program(dirPath: string, origin: string): string {
  const file = join(dirPath, 'board.lolo');
  writeFileSync(file, `app llm-spend-board [
  version: "1.0.0",
  description: "std-llm-spend-board as the gha-almadar llm route was configured.",
  egress: ["https://openrouter.ai", "https://api.deepseek.com", "https://api.moonshot.ai", "${traceOrigin}"]
]
uses Board from "std/behaviors/std-llm-spend-board"

orbital Board = Board.orbitals.LlmSpendBoardOrbital {
  traits { LlmSpend { config {
    traceOrigin: "${origin}"
  } } }
}
`);
  return file;
}

describe.skipIf(KERNEL_DIR === undefined)('std-llm-spend-board on the kernel, against the gha-almadar llm route', () => {
  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'llm-spend-'));
      const queues = new Map(Object.entries(scenario.replies).map(([api, replies]) => [api, [...replies]]));
      const fetched: string[] = [];
      const API: Array<[string, string]> = [['https://openrouter.ai/', 'openrouter'], ['https://api.deepseek.com/', 'deepseek'], ['https://api.moonshot.ai/', 'kimi'], [`${traceOrigin}/`, 'trace']];
      try {
        const http = {
          secrets: memorySecrets(Object.fromEntries(scenario.keys.map((k) => [k, `test-${k.toLowerCase()}`]))),
          fetch: async (url: URL, init: PinnedInit) => {
            const api = API.find(([prefix]) => url.href.startsWith(prefix))?.[1];
            fetched.push(`${url.href} auth=${init.headers.find(([n]) => n.toLowerCase() === 'authorization')?.[1] ?? ''}`);
            const reply = api === undefined ? undefined : queues.get(api)?.shift();
            if (reply === undefined || reply === 'unreachable') throw new TypeError('fetch failed');
            return new Response(JSON.stringify(reply.body), { status: reply.status, headers: [['content-type', 'application/json']] });
          },
          resolve: async (host: string) => ({ literal: /^\d/.test(host), addresses: [host === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34'] }),
        };
        // The import names its entities after the local orbital (Board + LlmPrice).
        const seed = { BoardLlmPrice: (scenario.prices ?? []).map((p) => ({ id: `${p.provider}/${p.model}`, ...p })) };
        const p = await KernelProgram.open(await resolveProgramFile(program(scratch, scenario.trace ? traceOrigin : ''), process.cwd()), { kernelDir: KERNEL_DIR ?? '', http, seed });
        try {
          for (const [i, method] of scenario.requests.entries()) {
            const run = await p.dispatch('Board', method === 'POST' ? 'LLM_SPEND_REFRESH' : 'LLM_SPEND_LOAD', {});
            if (run.error !== undefined) throw new Error(run.error);
            const got = JSON.parse(JSON.stringify(run.emits.find((e) => e.event === 'LLM_SPEND')?.payload ?? {})) as Obj;
            expect(normalized(got), `${method} #${i}`).toEqual(adapted(index, recorded[index].responses[i].body));
          }
        } finally {
          p.close();
        }
        const keyed = (f: string) => f.replace(/auth=Bearer test-[a-z_]+$/, 'auth=Bearer <key>');
        expect(fetched.map(keyed)).toEqual(recorded[index].fetched.filter((f) => !f.startsWith('https://') || scenario.keys.length > 0).map(keyed));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  it('a price set from the app is used by the next read; control: setting it again updates the one row', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'llm-spend-'));
    try {
      const http = { secrets: memorySecrets({}), fetch: async () => new Response('{}', { status: 500 }), resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }) };
      const p = await KernelProgram.open(await resolveProgramFile(program(scratch, ''), process.cwd()), { kernelDir: KERNEL_DIR ?? '', http });
      try {
        const set = await p.dispatch('Board', 'LLM_PRICE_SET', { provider: 'openai', model: 'gpt-4o', promptPer1K: 0.005, completionPer1K: 0.015 });
        expect(set.emits.find((e) => e.event === 'LLM_PRICE_SAVED')?.payload).toEqual({ provider: 'openai', model: 'gpt-4o' });
        const board = (await p.dispatch('Board', 'LLM_SPEND_LOAD', {})).emits.find((e) => e.event === 'LLM_SPEND')?.payload;
        expect(board?.modelPricing).toEqual([{ provider: 'openai', model: 'gpt-4o', promptPer1K: 0.005, completionPer1K: 0.015 }]);
        await p.dispatch('Board', 'LLM_PRICE_SET', { provider: 'openai', model: 'gpt-4o', promptPer1K: 0.0025, completionPer1K: 0.01 });
        expect((await p.rows('BoardLlmPrice')).map((r) => [r.id, r.promptPer1K])).toEqual([['openai/gpt-4o', 0.0025]]);
      } finally {
        p.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

