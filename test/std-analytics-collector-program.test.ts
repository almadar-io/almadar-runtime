// std-analytics-collector parity: the live atom, delivered the beacons that @almadar-io/analytics-server's scripts/record-parity.ts
// sent to createServer (fixed salt, in-memory store), answers each with the same status and stores the same event, and its
// stats answer the recorded queries the same way. Adapted (G-CROSS-264): the IP comes from x-forwarded-for only (a kernel
// delivery carries no peer address), countries stay empty (GeoIP is an approved drop), and a field the server left undefined
// is null in the row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityRow, EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-analytics-collector');

interface Delivery { body: string; xff: string; ua: string; status: number; event: { [key: string]: JsonValue } | null }
interface StatsCase { query: { [key: string]: string | number }; result: JsonValue }
interface Recording { salt: string; deliveries: Delivery[]; stats: StatsCase[] }

const recorded: Recording = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/analytics-collector/recorded.json', import.meta.url)), 'utf8'));
const today = (): string => new Date().toISOString().slice(0, 10);
const FIELDS = ['name', 'domain', 'path', 'referrer', 'screenWidth', 'visitorId', 'props'] as const;

function stored(row: EntityRow): { [key: string]: NonNullable<EntityRow[string]> } {
  const out: { [key: string]: NonNullable<EntityRow[string]> } = {};
  for (const field of FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined) out[field] = value;
  }
  return out;
}

function stats(payload: EventPayload | undefined): EventPayload | null {
  if (payload === undefined) return null;
  const { pageviews, visitors, pages, countries, referrers } = payload;
  return { pageviews: pageviews ?? null, visitors: visitors ?? null, pages: pages ?? null, countries: countries ?? null, referrers: referrers ?? null };
}

describe.skipIf(KERNEL_DIR === undefined)('std-analytics-collector on the kernel (parity with analytics-server)', () => {
  let dir = '';
  let program = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'std-analytics-collector-'));
    const source = readFileSync(atom, 'utf8');
    const domains = 'domains : [string] = []';
    if (!source.includes(domains)) throw new Error(`std-analytics-collector no longer declares ${domains}`);
    program = join(dir, 'std-analytics-collector-sites.lolo');
    writeFileSync(program, source.replace(domains, 'domains : [string] = ["almadar.io"]'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const open = async (file: string, seed?: Record<string, EntityRow[]>): Promise<KernelProgram> =>
    KernelProgram.open(await resolveProgramFile(file, process.cwd()), { kernelDir: KERNEL_DIR ?? '', ...(seed !== undefined ? { seed } : {}) });

  const deliver = (p: KernelProgram, d: Pick<Delivery, 'body' | 'xff' | 'ua'>) =>
    p.deliverInbound('analytics', { headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': d.xff, 'User-Agent': d.ua }, rawBody: d.body });

  it('answers every recorded beacon with its status and stores the same event', async () => {
    const p = await open(atom, { AnalyticsSalt: [{ id: today(), salt: recorded.salt }] });
    try {
      for (const d of recorded.deliveries) {
        const before = (await p.rows('AnalyticsEvent')).length;
        const answer = await deliver(p, d);
        expect(answer.status, d.body).toBe(d.status);
        const rows = await p.rows('AnalyticsEvent');
        const row = rows.length > before ? rows[rows.length - 1] : undefined;
        expect(row === undefined ? null : stored(row), d.body).toEqual(d.event);
      }
      for (const { query, result } of recorded.stats) {
        const payload: EventPayload = {};
        for (const [key, value] of Object.entries(query)) payload[key] = value === 'FUTURE' ? Date.now() + 1e9 : value;
        const run = await p.dispatch('AnalyticsCollectorOrbital', 'ANALYTICS_STATS', payload);
        expect(stats(run.emits.find((e) => e.event === 'ANALYTICS_STATS_RESULT')?.payload), JSON.stringify(query)).toEqual(result);
      }
    } finally {
      p.close();
    }
  });

  it('never stores an IP or user agent', async () => {
    const p = await open(atom, { AnalyticsSalt: [{ id: today(), salt: recorded.salt }] });
    try {
      for (const d of recorded.deliveries) await deliver(p, d);
      const raw = JSON.stringify(await p.rows('AnalyticsEvent'));
      for (const d of recorded.deliveries) for (const ip of d.xff.split(',')) expect(raw).not.toContain(ip.trim());
      expect(raw).not.toContain('Mozilla');
    } finally {
      p.close();
    }
  });

  it("draws the day's salt on the first beacon and keeps it for the rest of the day", async () => {
    const p = await open(atom);
    try {
      const beacon = { body: JSON.stringify({ n: 'pageview', d: 'almadar.io', u: '/' }), xff: '5.5.5.5', ua: 'UA' };
      expect((await deliver(p, beacon)).status).toBe(202);
      expect((await deliver(p, beacon)).status).toBe(202);
      expect((await deliver(p, { ...beacon, xff: '6.6.6.6' })).status).toBe(202);
      const salts = await p.rows('AnalyticsSalt');
      expect(salts.map((s) => s.id)).toEqual([today()]);
      expect(salts[0]?.salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const ids = (await p.rows('AnalyticsEvent')).map((r) => r.visitorId);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    } finally {
      p.close();
    }
  });

  it('a salt another instance already created is read, not replaced', async () => {
    const p = await open(atom, { AnalyticsSalt: [{ id: today(), salt: recorded.salt }] });
    try {
      const first = recorded.deliveries[0];
      if (first === undefined) throw new Error('no recorded delivery');
      expect((await deliver(p, first)).status).toBe(202);
      expect((await p.rows('AnalyticsEvent'))[0]?.visitorId).toBe(first.event?.visitorId);
      expect((await p.rows('AnalyticsSalt')).map((s) => s.salt)).toEqual([recorded.salt]);
    } finally {
      p.close();
    }
  });

  it('the domains knob refuses a site it does not list', async () => {
    const p = await open(program, { AnalyticsSalt: [{ id: today(), salt: recorded.salt }] });
    try {
      expect((await deliver(p, { body: JSON.stringify({ n: 'pageview', d: 'kflow.ai', u: '/' }), xff: '1.1.1.1', ua: 'UA' })).status).toBe(400);
      expect((await deliver(p, { body: JSON.stringify({ n: 'pageview', d: 'almadar.io', u: '/' }), xff: '1.1.1.1', ua: 'UA' })).status).toBe(202);
      expect((await p.rows('AnalyticsEvent')).map((r) => r.domain)).toEqual(['almadar.io']);
    } finally {
      p.close();
    }
  });
});
