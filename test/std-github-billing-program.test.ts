// std-github-billing on the kernel against the boards the gha-almadar github route answered (tools/gha-almadar
// scripts/record-github-parity.ts, which replayed the same usage replies through `gh api`): the same accounts,
// breakdowns, rounding, order and totals, the same reads per request and the cache window. Adapted, by owner rule (no
// heuristics, decisions log 2026-10-19): an error is GitHub's own message, not the route's guessed scope hint, and a
// SKU's category comes only from its declared unit (the route also matched words in the SKU name).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';

const dir = new URL('./fixtures/github-billing/', import.meta.url);
const program = fileURLToPath(new URL('billing-board.lolo', dir));
type Reply = { status: number; body?: JsonValue; raw?: string };
interface Scenario { name: string; requests: Array<'GET' | 'POST'>; replies: { [account: string]: Reply[] } }
type Sku = { product: string; sku: string; unit: string; category: string; quantity: number; gross: number; net: number };
type Account = { name: string; kind: string; available: boolean; error: string | null; bySku: Sku[]; [field: string]: JsonValue };
interface Board { accounts: Account[]; period: string; totalGrossUsd: number; totalNetUsd: number; fetchedAt: string }
const { scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', dir), 'utf8')) as { scenarios: Scenario[] };
const { recorded } = JSON.parse(readFileSync(new URL('recorded.json', dir), 'utf8')) as { recorded: Array<{ name: string; responses: Array<{ method: string; body: Board }>; calls: string[] }> };

const ERRORS: { [scenario: number]: { [account: string]: string } } = {
  2: { 'almadar-io': 'GitHub API request failed: Not Found', itechdom: 'GitHub answered a billing usage body that is not JSON' },
};
const CATEGORIES: { [sku: string]: string } = { 'Copilot seat storage': 'other' };

/** The route's board as the atom answers it: every changed field is named above. */
function adapted(index: number, board: Board): Board {
  return {
    ...board,
    accounts: board.accounts.map((a) => ({
      ...a,
      error: ERRORS[index]?.[a.name] ?? a.error,
      bySku: a.bySku.map((s) => (CATEGORIES[s.sku] === undefined ? s : { ...s, category: CATEGORIES[s.sku] })),
    })),
  };
}

function github(scenario: Scenario) {
  const queues = new Map(Object.entries(scenario.replies).map(([account, replies]) => [account, [...replies]]));
  const calls: string[] = [];
  const now = new Date();
  return {
    calls,
    http: {
      secrets: memorySecrets({ GITHUB_TOKEN: 'ghp-test' }),
      fetch: async (url: URL, init: PinnedInit) => {
        const m = /^\/(organizations|users)\/([^/]+)\/settings\/billing\/usage$/.exec(url.pathname);
        if (init.method !== 'GET' || m === null) throw new Error(`unexpected request ${init.method} ${url.href}`);
        expect([url.searchParams.get('year'), url.searchParams.get('month')]).toEqual([String(now.getUTCFullYear()), String(now.getUTCMonth() + 1)]);
        calls.push(`gh api /${m[1]}/${m[2]}/settings/billing/usage`);
        const queue = queues.get(m[2]) ?? [];
        const reply = queue.length > 1 ? queue.shift() : queue[0];
        if (reply === undefined) throw new Error(`no reply for ${m[2]}`);
        return new Response(reply.raw ?? JSON.stringify(reply.body ?? null), { status: reply.status, headers: [['content-type', 'application/json']] });
      },
      resolve: async (host: string) => ({ literal: true, addresses: [host] }),
    },
  };
}

describe.skipIf(KERNEL_DIR === undefined)('std-github-billing on the kernel, against the gha-almadar github route', () => {
  it('the recordings cover every scenario', () => {
    expect(recorded.map((r) => r.name)).toEqual(scenarios.map((s) => s.name));
  });

  for (const [index, scenario] of scenarios.entries()) {
    it(scenario.name, async () => {
      const t = github(scenario);
      const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: t.http });
      try {
        for (const [i, method] of scenario.requests.entries()) {
          const run = await p.dispatch('Billing', method === 'POST' ? 'BILLING_REFRESH' : 'BILLING_LOAD', {});
          const got: EventPayload | undefined = run.emits.find((e) => e.event === 'BILLING')?.payload;
          const want = adapted(index, recorded[index].responses[i].body);
          const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
          expect(got?.accounts, `${method} #${i}`).toEqual(want.accounts);
          expect([got?.period, got?.totalGrossUsd, got?.totalNetUsd]).toEqual([period, want.totalGrossUsd, want.totalNetUsd]);
          expect(typeof got?.fetchedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(got.fetchedAt)).toBe(true);
        }
        expect([...t.calls].sort()).toEqual(recorded[index].calls);
      } finally {
        p.close();
      }
    });
  }

  it('control: a different usage item changes the board, so the comparison reads the breakdowns', async () => {
    const changed: Scenario = { ...scenarios[0], replies: { ...scenarios[0].replies, itechdom: [{ status: 200, body: { usageItems: [{ product: 'actions', sku: 'Actions Linux', quantity: 1, unitType: 'Minutes', grossAmount: 0.5, discountAmount: 0, netAmount: 0.5 }] } }] } };
    const p = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', http: github(changed).http });
    try {
      const got = (await p.dispatch('Billing', 'BILLING_LOAD', {})).emits.find((e) => e.event === 'BILLING')?.payload;
      expect(got?.accounts).not.toEqual(adapted(0, recorded[0].responses[0].body).accounts);
    } finally {
      p.close();
    }
  });
});
