/**
 * The kernel's own store (`Server.withStore`, the native add-on only): the engine opens the server over the store the
 * environment selects, declares no capabilities of its own, and never asks the host's persistence for a row. The
 * scripted module stands in for the add-on; the gated suite runs the real `kernel.node` (twin of
 * `orbital-wasm/tests/wasm_server_api.rs`, `orbital-node/tests/stored.test.mjs`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { KernelEngine, type KernelHostPorts, type KernelModule, type KernelServerClass, type KernelServerHandle } from '../src/kernel/index.js';
import { KernelProgram } from '../src/kernel/program-node.js';
import { NATIVE_ADDON, stubKernelModule } from './helpers/kernel-module.js';

const ports = (persistence: InMemoryPersistence): KernelHostPorts => ({
  persistence,
  inFlightCalls: new InFlightCalls(),
  callService: async () => null,
  programEffect: () => undefined,
  servicePorts: (caller, _user, message) => ({ caller, message, inputs: () => [], readableEntities: () => [], dispatchInput: async () => { throw new Error('no input channel'); }, read: async () => [] }),
  deliverLive: () => undefined,
  deferCallOutcome: () => undefined,
});

class Scripted implements KernelServerHandle {
  constructor(protected readonly log: string[], private readonly label: string) {}
  start(): string { throw new Error('unused'); }
  resume(): string { throw new Error('unused'); }
  resolveRows(): string { throw new Error('unused'); }
  resumeResolve(): string { throw new Error('unused'); }
  abandon(): boolean { return true; }
  osAllows(): boolean { return false; }
  inFlight(): number { return 0; }
  getState(): string { return ''; }
  setDefaultUser(): void {}
  mount(): void {}
  remount(): void {}
  setTickMount(): void {}
  seedRuntimeMock(): void {}
  setMessages(): void {}
  lastError(): string { return ''; }
  setCapabilities(entity: string): void { this.log.push(`${this.label} setCapabilities ${entity}`); }
  free(): void { this.log.push(`${this.label} free`); }
}

function module(log: string[], withStore: boolean): KernelModule {
  class Server extends Scripted {
    constructor(_schema: string) { super(log, 'plain'); log.push('new'); }
    static withStore: KernelServerClass['withStore'] = withStore
      ? (_schema, envJson) => { log.push(`withStore ${envJson}`); return new Scripted(log, 'stored'); }
      : undefined;
  }
  return stubKernelModule(Server);
}

const env = { DATA_BACKEND: 'mock', NODE_ENV: 'development' };
const schema: OrbitalSchema = { name: 'notes', orbitals: [{ name: 'Main', entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] }, traits: [], pages: [] }] };

describe('KernelEngine over the kernel store', () => {
  it('opens the server with the store and declares no capabilities of its own, again after a reset', () => {
    const log: string[] = [];
    const engine = KernelEngine.open(module(log, true), schema, ports(new InMemoryPersistence()), env);
    expect(log).toEqual([`withStore ${JSON.stringify(env)}`]);
    engine.reset();
    expect(log).toEqual([`withStore ${JSON.stringify(env)}`, 'stored free', `withStore ${JSON.stringify(env)}`]);
  });

  it('control: without a store the plain server is opened and the host declares its capabilities', () => {
    const log: string[] = [];
    KernelEngine.open(module(log, true), schema, ports(new InMemoryPersistence()));
    expect(log).toEqual(['new', 'plain setCapabilities Note']);
  });

  it('control: a module without withStore (the wasm kernel) refuses a store by name', () => {
    expect(() => KernelEngine.open(module([], false), schema, ports(new InMemoryPersistence()), env)).toThrow(/native add-on/);
  });

  it('control: a program asks for the store only on the native engine, and not beside a seed', async () => {
    await expect(KernelProgram.open(schema, { store: env })).rejects.toThrow(/engine: 'native'/);
    await expect(KernelProgram.open(schema, { engine: 'native', store: env, seed: {} })).rejects.toThrow(/replaces/);
  });
});

describe.skipIf(NATIVE_ADDON === undefined)('the native add-on with its own store', () => {
  const notes: OrbitalSchema = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/notes.schema.json', import.meta.url)), 'utf8'));

  it('a persist dispatch finishes with no row ever asked of the host', async () => {
    const program = await KernelProgram.open(notes, { engine: 'native', ...(NATIVE_ADDON !== undefined ? { nativeAddon: NATIVE_ADDON } : {}), store: env });
    try {
      const run = await program.dispatch('Main', 'SAVE', {}, 'Draft');
      expect(run.success).toBe(true);
    } finally {
      program.close();
    }
  });

  it('control: production refuses the memory store', async () => {
    await expect(KernelProgram.open(notes, { engine: 'native', ...(NATIVE_ADDON !== undefined ? { nativeAddon: NATIVE_ADDON } : {}), store: { DATA_BACKEND: 'mock' } })).rejects.toThrow(/not permitted/);
  });
});
