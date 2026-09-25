/**
 * G-STD-001: std-driver's detail actions Suspend / Reinstate / Terminate only
 * re-fetched, so the status never changed. The atom's own DriverUpdated
 * contract says they persist the row's status like SET_STATUS. Both topologies.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { DEFAULT_VIEWER } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  evaluateOrbitalEvent,
  StateMachineManager,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ORB = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/atoms/std-driver.orb');
const TRAIT = 'DriverRoster';

const cases = (['stateful', 'stateless'] as const).flatMap((topology) => [
  { topology, event: 'SUSPEND', status: 'suspended' },
  { topology, event: 'REINSTATE', status: 'active' },
  { topology, event: 'TERMINATE', status: 'terminated' },
]);

describe.skipIf(!existsSync(ORB)).each(cases)('std-driver $event ($topology)', ({ topology, event, status }) => {
  it(`persists status ${status} on the opened driver and nothing else`, async () => {
    const raw = JSON.parse(readFileSync(ORB, 'utf-8')) as OrbitalSchema;
    const resolved = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!resolved.success) throw new Error(resolved.errors.join('; '));
    const schema = resolved.data.schema;
    const persistence = new MockPersistenceAdapter({ ownerId: DEFAULT_VIEWER.id });
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
    await runtime.register(schema);
    const index = buildTraitIndex(schema.orbitals);
    const store = createMemoryCircuitStore([...index.byName.values()].map((e) => e.traitDef));
    const transport = topology === 'stateful'
      ? createInProcessTransport((o, request) => runtime.processOrbitalEvent(o, request))
      : createInProcessTransport(async (_o, request) => {
        const manager = new StateMachineManager([...index.byName.values()].map((e) => e.traitDef));
        const frames = new Map<string, EntityRow>();
        return evaluateOrbitalEvent(
          { traitIndex: index, manager, persistence, frames, runtimeRowSentinel: true, runEffects: createIndexStageRunner({ traitIndex: index, persistence, frames, manager, schema }) },
          request,
        );
      }, { carriesCircuitState: true });
    const orbital = schema.orbitals.find((o) => (o.pages ?? []).some((p) => typeof p === 'object' && p.path === '/drivers'));
    const kernel = createClientKernel({ orbitalName: orbital?.name ?? '', traitIndex: index, store, carriesCircuitState: topology === 'stateless', transport });

    const before = await persistence.list('Driver');
    const [target, other] = before;
    // Start from a status the action changes.
    await persistence.update('Driver', String(target['id']), { status: status === 'active' ? 'suspended' : 'active' });
    const otherStatus = other?.['status'];

    await kernel.dispatch({ event: 'INIT', targetTrait: TRAIT });
    await kernel.dispatch({ event: 'OPEN_DRIVER', targetTrait: TRAIT, payload: { id: target['id'], row: { ...target } } });
    await kernel.dispatch({ event, targetTrait: TRAIT, payload: { id: target['id'] } });

    expect((await persistence.getById('Driver', String(target['id'])))?.['status']).toBe(status);
    if (other !== undefined) expect((await persistence.getById('Driver', String(other['id'])))?.['status']).toBe(otherStatus);
  }, 120_000);
});
