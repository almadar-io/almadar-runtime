// One dispatcher for declared external inputs, shared by the server runtime and the in-process host
// (the browser extension's worker): undeclared inputs are refused with the same response everywhere,
// declared ones become an ordinary event request addressed to their trait.
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { dispatchDeclaredInput } from '../src/evaluation/declared-input-dispatch.js';

const schema: OrbitalSchema = {
  name: 'inputs',
  version: '1.0.0',
  orbitals: [
    {
      name: 'FeedOrbital',
      pages: [],
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
      traits: [
        {
          name: 'Watcher',
          scope: 'instance',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              { key: 'ITEM_SEEN', name: 'Item seen', external: true, payloadSchema: [{ name: 'elementId', type: 'string', required: true }] },
              { key: 'CLEAR', name: 'Clear' },
            ],
            transitions: [
              { from: 'idle', to: 'idle', event: 'ITEM_SEEN', effects: [] },
              { from: 'idle', to: 'idle', event: 'CLEAR', effects: [] },
            ],
          },
        },
      ],
    },
  ],
};

const OK: OrbitalEventResponse = { success: true, transitioned: true, states: { Watcher: 'idle' }, emittedEvents: [] };

function recorder() {
  const sent: Array<{ orbital: string; request: OrbitalEventRequest }> = [];
  const send = async (orbital: string, request: OrbitalEventRequest) => {
    sent.push({ orbital, request });
    return OK;
  };
  return { sent, send };
}

describe('dispatchDeclaredInput', () => {
  it('sends a declared input to its trait with payload, user and entity', async () => {
    const { sent, send } = recorder();
    const res = await dispatchDeclaredInput(schema, 'FeedOrbital', { targetTrait: 'Watcher', event: 'ITEM_SEEN', payload: { elementId: 'el-1' }, user: { uid: 'u1' }, entityId: 'i1' }, send);
    expect(res).toBe(OK);
    expect(sent).toEqual([
      { orbital: 'FeedOrbital', request: { event: 'ITEM_SEEN', payload: { elementId: 'el-1' }, targetTrait: 'Watcher', user: { uid: 'u1' }, entityId: 'i1' } },
    ]);
  });

  it('refuses an event the trait does not declare as an external input, without sending it', async () => {
    const { sent, send } = recorder();
    const res = await dispatchDeclaredInput(schema, 'FeedOrbital', { targetTrait: 'Watcher', event: 'CLEAR' }, send);
    expect(res).toEqual({
      success: false,
      transitioned: false,
      states: {},
      emittedEvents: [],
      error: "'CLEAR' is not an external input of FeedOrbital.Watcher",
      rejections: [{ code: 'not-an-external-input', trait: 'Watcher', event: 'CLEAR' }],
    });
    expect(sent).toEqual([]);
  });

  it('edge: with no registered schema, every input is refused', async () => {
    const { sent, send } = recorder();
    const res = await dispatchDeclaredInput(undefined, 'FeedOrbital', { targetTrait: 'Watcher', event: 'ITEM_SEEN' }, send);
    expect(res.success).toBe(false);
    expect(sent).toEqual([]);
  });

  it('control: a missing payload is sent as an empty payload', async () => {
    const { sent, send } = recorder();
    await dispatchDeclaredInput(schema, 'FeedOrbital', { targetTrait: 'Watcher', event: 'ITEM_SEEN' }, send);
    expect(sent[0].request.payload).toEqual({});
  });
});
