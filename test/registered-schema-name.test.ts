import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(name: string): OrbitalSchema {
  return {
    name,
    schemaVersion: 4,
    orbitals: [{
      name: `${name}Orbital`,
      entity: { name: `${name}Row`, persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [{ name: `${name}Home`, scope: 'instance', linkedEntity: `${name}Row`, stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] } }],
      pages: [],
    }],
  };
}

// The one answer to "which program is registered right now", so callers never keep a second copy that drifts.
describe('OrbitalServerRuntime.registeredSchemaName', () => {
  it('names the program once it is registered', async () => {
    const rt = new OrbitalServerRuntime();
    await rt.register(schema('Accounting'));
    expect(rt.registeredSchemaName()).toBe('Accounting');
  });

  it('control: nothing is registered before register or after unregisterAll', async () => {
    const rt = new OrbitalServerRuntime();
    expect(rt.registeredSchemaName()).toBeNull();
    await rt.register(schema('Accounting'));
    rt.unregisterAll();
    expect(rt.registeredSchemaName()).toBeNull();
  });

  it('edge: a swap names the new program', async () => {
    const rt = new OrbitalServerRuntime();
    await rt.register(schema('Accounting'));
    rt.unregisterAll();
    await rt.register(schema('Gateway'));
    expect(rt.registeredSchemaName()).toBe('Gateway');
  });
});
