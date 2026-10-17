/**
 * EXEC-STEP-8 and the batch rules (G-DB-003): on Firestore a `persist batch` whose op cannot apply fails whole with
 * its code, index and completed count, and writes nothing. Runs against the Firestore emulator
 * (`FIRESTORE_EMULATOR_HOST`), on the JS engine and the kernel host.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FirestorePersistence, firestoreRows } from '@almadar/db';
import { getFirestore, initializeFirebase } from '@almadar/db/firebase';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { KernelModule } from '../src/kernel/index.js';
import { KERNEL_DIR, loadKernel } from './helpers/kernel-module.js';

const emit = { emit: { success: 'DONE', failure: 'FAILED' } };
const EVENTS = ['TAKEN', 'MISSING', 'TAKEN_AFTER_OK', 'FRESH', 'DONE', 'FAILED'];

function program(): OrbitalSchema {
  const batch = (ops: object[]) => [['persist', 'batch', ops, emit]];
  const transitions = [
    { from: 'idle', to: 'idle', event: 'TAKEN', effects: batch([['create', 'Note', { id: 'n1', title: 'again' }]]) },
    { from: 'idle', to: 'idle', event: 'MISSING', effects: batch([['update', 'Note', 'nope', { title: 'u' }]]) },
    { from: 'idle', to: 'idle', event: 'TAKEN_AFTER_OK', effects: batch([['update', 'Note', 'n2', { title: 'u' }], ['create', 'Note', { id: 'n1', title: 'again' }]]) },
    { from: 'idle', to: 'idle', event: 'FRESH', effects: batch([['update', 'Note', 'n2', { title: 'u' }], ['create', 'Note', { id: 'n9', title: 'new' }]]) },
    { from: 'idle', to: 'idle', event: 'DONE' },
    { from: 'idle', to: 'idle', event: 'FAILED' },
  ];
  return {
    name: 'batch-semantics',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'persistent',
        collection: 'notes',
        fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }],
      },
      traits: [{
        name: 'Notes',
        scope: 'instance',
        linkedEntity: 'Note',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: EVENTS.map((e) => ({ key: e, name: e })),
          transitions,
        },
      }],
    }],
  } as OrbitalSchema;
}

let seq = 0;
async function run(event: string, kernel?: KernelModule) {
  initializeFirebase();
  const store = new FirestorePersistence({ root: `batch-tests-${Date.now()}/run-${++seq}`, firestore: firestoreRows(getFirestore()) });
  await store.create('Note', { id: 'n1', title: 'seed' });
  await store.create('Note', { id: 'n2', title: 'seed' });
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: store, ...(kernel !== undefined ? { engine: 'kernel' as const, kernel } : {}) });
  await runtime.register(program());
  const response = await runtime.processOrbitalEvent('Main', { event, targetTrait: 'Notes' });
  const persist = response.effectResults?.find((r) => r.effect === 'persist');
  return { rows: await store.list('Note'), persist, events: response.emittedEvents.map((e) => e.event), response };
}

/** The JS interpreter reports `success: false` but fires the success route and carries no `code` (G-RUNTIME-089); the kernel host fires `failure` with the typed code (EXEC-STEP-8). */
function suite(kernel: () => KernelModule | undefined, coded: boolean): void {
  const code = (value: string) => (coded ? { code: value } : {});
  const title = (rows: { id?: unknown; title?: unknown }[], id: string) => rows.find((r) => r.id === id)?.title;
  it('a batch creating a taken id fails duplicate-id at index 0 and fires failure', async () => {
    const { rows, persist, events } = await run('TAKEN', kernel());
    expect(persist).toMatchObject({ success: false, ...code('duplicate-id') });
    if (coded) expect(events).toEqual(['FAILED']);
    expect(title(rows, 'n1')).toBe('seed');
  });
  it('a batch updating a missing row fails not-found and creates nothing', async () => {
    const { rows, persist, events } = await run('MISSING', kernel());
    expect(persist).toMatchObject({ success: false, ...code('not-found') });
    if (coded) expect(events).toEqual(['FAILED']);
    expect(rows.find((r) => r.id === 'nope')).toBeUndefined();
  });
  it('an earlier op that applied is rolled back by a later failure', async () => {
    const { rows, persist } = await run('TAKEN_AFTER_OK', kernel());
    expect(persist).toMatchObject({ success: false, ...code('duplicate-id') });
    expect(title(rows, 'n2')).toBe('seed');
  });
  it('control: a batch whose ops all apply succeeds and writes', async () => {
    const { rows, persist, events } = await run('FRESH', kernel());
    expect(persist?.success).toBe(true);
    expect(events).toContain('DONE');
    expect(title(rows, 'n2')).toBe('u');
    expect(title(rows, 'n9')).toBe('new');
  });
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('persist batch on Firestore, JS engine', () => suite(() => undefined, false));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST || KERNEL_DIR === undefined)('persist batch on Firestore, kernel host', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });
  suite(() => kernel, true);
});
