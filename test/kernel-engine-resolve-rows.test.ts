/**
 * `KernelEngine.resolveRows`: a row-set reference resolved through the host-answered store. The kernel (a scripted
 * handle here, standing in for the wasm `Server`; the Rust twin is `orbital-core/tests/server_resolve_rows.rs`) asks
 * for the by-id window and the re-count; the host answers them from its persistence and the engine returns the page.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EntityRow, RowSetRef } from '@almadar/core';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { KernelEngine, type KernelHostPorts, type KernelModule, type KernelServerHandle } from '../src/kernel/index.js';
import { stubKernelModule } from './helpers/kernel-module.js';

const reference: RowSetRef = {
  entityType: 'Ticket',
  ids: ['t2', 't5'],
  total: 4,
  query: { filter: { kind: 'compare', field: 'status', op: '==', value: 'open' }, limit: 2 },
};

const ROWS: EntityRow[] = [
  { id: 't1', status: 'open' }, { id: 't2', status: 'open' }, { id: 't3', status: 'open' }, { id: 't5', status: 'open' },
];

const ports = (persistence: InMemoryPersistence): KernelHostPorts => ({
  persistence,
  inFlightCalls: new InFlightCalls(),
  callService: async () => null,
  programEffect: () => undefined,
  servicePorts: (caller, _user, message) => ({ caller, message, inputs: () => [], readableEntities: () => [], dispatchInput: async () => { throw new Error('no input channel'); }, read: async () => [] }),
  deliverLive: () => undefined,
  deferCallOutcome: () => undefined,
});

/** A kernel that resolves by asking for two reads and folding the answers, as the Rust resolve does. */
function scripted(log: string[]): KernelModule {
  class Handle implements KernelServerHandle {
    private answers: string[] = [];
    resolveRows(_ref: string, _viewer: string): string {
      log.push('resolveRows');
      return JSON.stringify({ status: 'await', flight: 7, requests: [{ id: 0, request: { kind: 'listRows', entityType: 'Ticket' } }] });
    }
    resumeResolve(flight: number, repliesJson: string): string {
      log.push(`resumeResolve ${flight}`);
      const [reply] = JSON.parse(repliesJson);
      this.answers.push(JSON.stringify(reply.answer));
      const rows: EntityRow[] = reply.answer.result.ok;
      return JSON.stringify({ status: 'done', rows: rows.filter((r) => reference.ids.includes(String(r.id))), total: rows.length });
    }
    abandon(flight: number): boolean { log.push(`abandon ${flight}`); return true; }
    start(): string { throw new Error('unused'); }
    resume(): string { throw new Error('unused'); }
    inFlight(): number { return 0; }
    getState(): string { return ''; }
    setDefaultUser(): void {}
    mount(): void {}
    remount(): void {}
    setTickMount(): void {}
    seedRuntimeMock(): void {}
    setCapabilities(): void {}
    setMessages(): void {}
    lastError(): string { return ''; }
    osAllows(): boolean { return false; }
    fork(): KernelServerHandle { throw new Error('unused'); }
    free(): void {}
  }
  return stubKernelModule(Handle);
}

describe('KernelEngine.resolveRows', () => {
  it('answers the kernel\'s reads from the host store and returns the resolved page', async () => {
    const persistence = new InMemoryPersistence();
    for (const row of ROWS) await persistence.create('Ticket', { ...row });
    const log: string[] = [];
    const engine = new KernelEngine(scripted(log), '{}', ports(persistence));
    const page = await engine.resolveRows(reference, { orbital: 'Main', user: { id: 'u1', role: 'member' } });
    expect(page.rows.map((r) => r.id)).toEqual(['t2', 't5']);
    expect(page.total).toBe(4);
    expect(log).toEqual(['resolveRows', 'resumeResolve 7']);
  });

  it('a row deleted since the fetch is omitted and the total follows the store', async () => {
    const persistence = new InMemoryPersistence();
    for (const row of ROWS) await persistence.create('Ticket', { ...row });
    await persistence.delete('Ticket', 't2');
    const engine = new KernelEngine(scripted([]), '{}', ports(persistence));
    const page = await engine.resolveRows(reference, { orbital: 'Main' });
    expect(page.rows.map((r) => r.id)).toEqual(['t5']);
    expect(page.total).toBe(3);
  });
});
