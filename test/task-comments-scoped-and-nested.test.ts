/**
 * std-task-manager's task page: a task is created from its own form fields (the
 * comment thread must not leak ThreadPost's required fields into the task), the
 * comment thread lists only the open task's comments, and a reply to a comment
 * nests under it inside the same task's thread.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, EventPayload, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { IO_ROOT, STD_ROOT } from './helpers/behavior-packages.js';

const ORBITAL = 'TaskListOrbital';
const USER = { id: 'member-1', role: 'manager', name: 'Mia' };

async function taskRuntime() {
  const raw = JSON.parse(readFileSync(join(IO_ROOT, 'behaviors/registry/app/organisms/std-task-manager.orb'), 'utf-8')) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, { basePath: IO_ROOT, stdLibPath: STD_ROOT, allowOutsideBasePath: true });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  const persistence = new MockPersistenceAdapter();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
  await runtime.register(resolved.data.schema);
  const send = (targetTrait: string, event: string, payload: EventPayload = {}) =>
    runtime.processOrbitalEvent(ORBITAL, { event, targetTrait, payload, user: USER });
  return { runtime, persistence, send };
}

/** The rows of the last ThreadPostLoaded the comment thread emitted. */
function thread(response: OrbitalEventResponse): EntityRow[] {
  const loaded = response.emittedEvents.filter((e) => e.event === 'ThreadPostLoaded' && e.source?.trait === 'TaskComments').at(-1);
  const rows = loaded?.payload?.['data'];
  return Array.isArray(rows) ? rows.filter((r): r is EntityRow => r !== null && typeof r === 'object' && !Array.isArray(r)) : [];
}

const contents = (rows: EntityRow[]) => rows.map((r) => r['content']);

async function comment(send: Awaited<ReturnType<typeof taskRuntime>>['send'], taskId: string, text: string) {
  await send('TaskDetail', 'INIT', { id: taskId });
  await send('TaskComments', 'EDIT_REPLY', { value: text });
  return send('TaskComments', 'SUBMIT_REPLY');
}

async function createTask(send: Awaited<ReturnType<typeof taskRuntime>>['send'], title: string): Promise<string> {
  const response = await send('ListTaskRules', 'DO_CREATE', { data: { title } });
  const created = response.emittedEvents.find((e) => e.event === 'TASK_CREATED');
  const id = created?.payload?.['id'];
  if (typeof id !== 'string') throw new Error(`task "${title}" was not created: ${JSON.stringify(response.effectResults)}`);
  return id;
}

describe('std-task-manager task comments', () => {
  it('a task is created from its title alone', async () => {
    const { persistence, send } = await taskRuntime();
    const id = await createTask(send, 'Ship release notes');
    expect((await persistence.getById('TaskRow', id))?.['title']).toBe('Ship release notes');
    expect((await persistence.list('TaskRow')).filter((r) => r['content'] !== undefined && r['title'] === undefined)).toEqual([]);
  }, 120_000);

  it('each task lists only its own comments', async () => {
    const { send } = await taskRuntime();
    const alpha = await createTask(send, 'Alpha');
    const beta = await createTask(send, 'Beta');
    await comment(send, alpha, 'on alpha');
    const afterBeta = await comment(send, beta, 'on beta');
    expect(contents(thread(afterBeta))).toEqual(['on beta']);
    const backToAlpha = await send('TaskDetail', 'INIT', { id: alpha });
    expect(contents(thread(backToAlpha))).toEqual(['on alpha']);
  }, 120_000);

  it('a reply nests under its comment and stays in the task thread', async () => {
    const { persistence, send } = await taskRuntime();
    const alpha = await createTask(send, 'Alpha');
    const posted = await comment(send, alpha, 'top comment');
    const top = thread(posted).find((r) => r['content'] === 'top comment');
    expect(top).toBeDefined();
    const replied = await send('TaskComments', 'REPLY', { parentNodeId: top?.['id'], content: 'a reply' });
    const rows = thread(replied);
    expect(contents(rows)).toEqual(['top comment']);
    const replies = rows[0]?.['replies'];
    expect(Array.isArray(replies) ? replies.map((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date) ? r['content'] : r)) : replies).toEqual(['a reply']);
    const reply = (await persistence.list('ThreadPost')).find((r) => r['content'] === 'a reply');
    expect(reply?.['threadRootId']).toBe(alpha);
    expect(reply?.['parentId']).toBe(top?.['id']);
    const reopened = await send('TaskDetail', 'INIT', { id: alpha });
    expect(contents(thread(reopened))).toEqual(['top comment']);
  }, 120_000);
});
