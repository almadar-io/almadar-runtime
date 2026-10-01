// A `call-service` provider gets the running app lent as the caller: the declared
// inputs, the input channel and a `@read`-filtered read, bound to the requesting
// user and the calling trait. Exercised with the real `llm call-tools` loop and a
// scripted model.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import { runToolLoop } from '@almadar/integrations';
import type { EventPayload, OrbitalSchema, ServiceHostPorts, SExpr, UserContext } from '@almadar/core';

const OWN_ROWS: SExpr = ['=', '@entity.ownerId', '@user.id'];
const MEMBERS_ONLY: SExpr = ['=', '@user.role', 'member'];
const ALICE: UserContext = { id: 'alice', role: 'member' };
const VIC: UserContext = { id: 'vic', role: 'viewer' };

function schema(): OrbitalSchema {
  return {
    name: 'ports-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'TaskOrbital',
        pages: [],
        entity: {
          name: 'Task',
          persistence: 'persistent',
          read_policy: OWN_ROWS,
          create_policy: MEMBERS_ONLY,
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'title', type: 'string' },
            { name: 'ownerId', type: 'string' },
          ],
        },
        traits: [
          {
            name: 'TaskPersistor',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'DO_CREATE', name: 'Do create', external: true, description: 'Create a task', payloadSchema: [{ name: 'title', type: 'string', required: true }] },
              ],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'DO_CREATE',
                  effects: [['persist', 'create', 'Task', { title: '@payload.title', ownerId: '@user.id' }]],
                },
              ],
            },
          },
          {
            name: 'Assistant',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'thinking' }],
              events: [
                { key: 'ASK', name: 'Ask', payloadSchema: [{ name: 'message', type: 'string', required: true }] },
                { key: 'ANSWERED', name: 'Answered' },
                { key: 'FAILED', name: 'Failed' },
              ],
              transitions: [
                {
                  from: 'idle', to: 'thinking', event: 'ASK',
                  effects: [[
                    'call-service', 'llm', 'call-tools',
                    { messages: [{ role: 'user', content: '@payload.message' }], tools: [{ event: 'TaskPersistor.DO_CREATE' }, { read: 'Task' }] },
                    { emit: { success: 'ANSWERED', failure: 'FAILED' } },
                  ]],
                },
                { from: 'thinking', to: 'idle', event: 'ANSWERED' },
                { from: 'thinking', to: 'idle', event: 'FAILED' },
              ],
            },
          },
        ],
      },
    ],
  };
}

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
interface ScriptedTurn {
  message: Message;
}

/** Replays `turns` in order and records each request (the `@almadar/llm` double, inlined: no llm dependency here). */
function createScriptedToolClient(turns: ScriptedTurn[]) {
  const requests: Array<{ messages: Message[] }> = [];
  return {
    requests,
    async callWithTools(options: { messages: ReadonlyArray<Message> }) {
      const turn = turns[requests.length];
      requests.push({ messages: [...options.messages] });
      if (turn === undefined) throw new Error(`no scripted turn ${requests.length}`);
      return { message: turn.message, finishReason: 'stop', usage: null };
    },
  };
}

const create = (title: string): ScriptedTurn => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'TaskPersistor__DO_CREATE', arguments: JSON.stringify({ title }) } }] },
});
const readTasks: ScriptedTurn = {
  message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read__Task', arguments: '{}' } }] },
};
const reply = (text: string): ScriptedTurn => ({ message: { role: 'assistant', content: text } });

async function setup(turns: ScriptedTurn[]) {
  const seen: { host?: ServiceHostPorts } = {};
  const client = createScriptedToolClient(turns);
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    effectHandlers: {
      callService: async (_service, _action, _params, context): Promise<EventPayload> => {
        if (!context?.host) throw new Error('no host ports lent');
        seen.host = context.host;
        const result = await runToolLoop(client, context.host, {
          messages: [{ role: 'user', content: 'request' }],
          tools: [{ event: 'TaskPersistor.DO_CREATE' }, { read: 'Task' }],
        });
        return { reply: result.reply, steps: result.steps.length };
      },
    },
  });
  await runtime.register(schema());
  return { runtime, seen, client };
}

const ask = (runtime: OrbitalServerRuntime, user: UserContext, message: string) =>
  runtime.processOrbitalEvent('TaskOrbital', { event: 'ASK', targetTrait: 'Assistant', payload: { message }, user });

describe('call-service host ports', () => {
  it('lends the caller position and fires the input as the signed-in user', async () => {
    const { runtime, seen } = await setup([create('Ship notes'), reply('Created.')]);
    const res = await ask(runtime, ALICE, 'create "Ship notes"');
    expect(res.emittedEvents.map((e) => e.event)).toContain('ANSWERED');
    expect(seen.host?.caller).toEqual({ orbital: 'TaskOrbital', trait: 'Assistant' });
    const rows = await runtime.persistence.list('Task');
    expect(rows.map((r) => [r.title, r.ownerId])).toEqual([['Ship notes', 'alice']]);
  });

  it('the entity policy applies to the agent exactly as to the user', async () => {
    const { runtime, client } = await setup([create('Nope'), reply('Not allowed.')]);
    await ask(runtime, VIC, 'create "Nope"');
    expect(await runtime.persistence.list('Task')).toEqual([]);
    const toolResult = client.requests[1].messages.at(-1);
    expect(toolResult?.role).toBe('tool');
    expect(toolResult?.content).toContain('denied');
  });

  it('a read returns only the rows the caller may read', async () => {
    const { runtime, client } = await setup([readTasks, reply('You have one task.')]);
    await runtime.persistence.create('Task', { id: 't1', title: 'Mine', ownerId: 'alice' });
    await runtime.persistence.create('Task', { id: 't2', title: 'Theirs', ownerId: 'bob' });
    await ask(runtime, ALICE, 'what are my tasks?');
    expect(client.requests[1].messages.at(-1)?.content).toBe('{"rows":[{"id":"t1","title":"Mine","ownerId":"alice"}]}');
  });

  it('control: the inputs listed are the declared ones only', async () => {
    const { runtime, seen } = await setup([reply('Hi.')]);
    await ask(runtime, ALICE, 'hi');
    expect(seen.host?.inputs().map((i) => `${i.trait}.${i.event}`)).toEqual(['TaskPersistor.DO_CREATE']);
  });
});
