/**
 * std-project-manager's task page: the checklist lists only the open task's
 * steps — scoped by the task load (std-scoped-list SET_SCOPE) — and stays
 * scoped when a new step makes the list reload.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, EventPayload, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { IO_ROOT, STD_ROOT } from './helpers/behavior-packages.js';

const ORBITAL = 'TaskOrbital';
const USER = { id: 'manager-1', role: 'manager', name: 'Mia' };

async function pmRuntime() {
  const raw = JSON.parse(readFileSync(join(IO_ROOT, 'behaviors/registry/app/organisms/std-project-manager.orb'), 'utf-8')) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, { basePath: IO_ROOT, stdLibPath: STD_ROOT, allowOutsideBasePath: true });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  const persistence = new MockPersistenceAdapter();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
  await runtime.register(resolved.data.schema);
  const send = (targetTrait: string, event: string, payload: EventPayload = {}) =>
    runtime.processOrbitalEvent(ORBITAL, { event, targetTrait, payload, user: USER });
  return { persistence, send };
}

/** Step names in the last list the checklist loaded. */
function checklist(response: OrbitalEventResponse): unknown[] {
  const loaded = response.emittedEvents.filter((e) => e.event === 'ScopedListLoaded' && e.source?.trait === 'TaskChecklist').at(-1);
  const rows = loaded?.payload?.['data'];
  return Array.isArray(rows)
    ? rows.filter((r): r is EntityRow => r !== null && typeof r === 'object' && !Array.isArray(r)).map((r) => r['name'])
    : [];
}

async function twoTasksWithSteps() {
  const env = await pmRuntime();
  const alpha = await env.persistence.create('Task', { title: 'Alpha' });
  const beta = await env.persistence.create('Task', { title: 'Beta' });
  await env.persistence.create('TaskChecklistItem', { name: 'alpha step', taskId: alpha.id });
  await env.persistence.create('TaskChecklistItem', { name: 'beta step', taskId: beta.id });
  return { ...env, alpha: alpha.id, beta: beta.id };
}

describe('std-project-manager task checklist', () => {
  it('lists only the open task\'s steps', async () => {
    const { send, alpha, beta } = await twoTasksWithSteps();
    await send('TaskChecklist', 'INIT');
    expect(checklist(await send('TaskDetail', 'INIT', { id: alpha }))).toEqual(['alpha step']);
    expect(checklist(await send('TaskDetail', 'INIT', { id: beta }))).toEqual(['beta step']);
  }, 120_000);

  it('stays on the open task when a new step reloads the list', async () => {
    const { send, alpha } = await twoTasksWithSteps();
    await send('TaskChecklist', 'INIT');
    await send('TaskDetail', 'INIT', { id: alpha });
    const added = await send('TaskChecklistPersistor', 'DO_CREATE', { data: { name: 'second alpha step', taskId: alpha } });
    expect(checklist(added)).toEqual(['alpha step', 'second alpha step']);
  }, 120_000);

  it('control: before a task is open the checklist lists no task\'s steps', async () => {
    const { send } = await twoTasksWithSteps();
    expect(checklist(await send('TaskChecklist', 'INIT'))).toEqual([]);
  }, 120_000);
});
