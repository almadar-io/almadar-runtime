/**
 * Regression for R-PAYLOAD-VALIDATION-SCOPE-UNION
 * (`docs/Almadar_Runtime_Gaps.md`).
 *
 * `processOrbitalEvent`'s API-boundary payload check used to validate a
 * dispatched event's payload against EVERY trait in the orbital declaring
 * that event key in `stateMachine.events`, ignoring `targetTrait` entirely
 * — reproduced on `std-realtime-chat.lolo`, where the Send BUTTON dispatches
 * `SEND {}` (handled by `ChatComposer`, whose `SEND.value` is optional) but
 * the InputGroup's inline render trait also declares a `SEND` listener with
 * `value` marked `required: true`, so the interpreter rejected a payload
 * that trait was never going to receive. The compiled path validates
 * per-handler (`OirEvent.payload_required_fields`) and sent fine — the two
 * paths diverged.
 *
 * Fixed by scoping validation to the same trait set `sendEvent` actually
 * dispatches to: `targetTrait` when given, else whichever traits'
 * CURRENT state has a transition for the event
 * (`StateMachineManager.canHandleEvent`).
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import { asOrbitalId, asEntityId, asTraitId } from '@almadar/core';
import type { OrbitalSchema, Trait } from '@almadar/core';

const ORB = asOrbitalId('orb_01HCCPAYLOADSCOPEAAAAAAAA');
const ENT = asEntityId('ent_01HCCPAYLOADSCOPEAAAAAAAA');
const TID_COMPOSER = asTraitId('trt_01HCCCOMPOSERCOMPOSERCOMP');
const TID_INLINE = asTraitId('trt_01HCCINLINEINLINEINLINEIN');

/**
 * Two traits shaped like `ChatComposer` (owns the `SEND` transition, `value`
 * optional) and an inline render trait (also declares `SEND` in its own
 * `stateMachine.events`, `value` required, but has NO transition for it —
 * exactly `InlineInputGroupRender14`'s shape on `std-realtime-chat`).
 */
function buildSchema(): OrbitalSchema {
  const composer: Trait = {
    id: TID_COMPOSER,
    name: 'ChatComposer',
    scope: 'instance',
    linkedEntity: 'Message',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'SEND', name: 'Send', payloadSchema: [{ name: 'value', type: 'string', required: false }] },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'SEND', effects: [['emit', 'SENT', {}]] },
      ],
    },
    emits: [{ event: 'SENT', scope: 'internal' }],
  };

  // Declares the same event key with a required field, but its own state
  // machine never transitions on SEND — a render-only listener, matching
  // the inline InputGroup trait's shape.
  const inline: Trait = {
    id: TID_INLINE,
    name: 'InlineInputGroupRender',
    scope: 'instance',
    linkedEntity: 'Message',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'SEND', name: 'Send', payloadSchema: [{ name: 'value', type: 'string', required: true }] },
      ],
      transitions: [],
    },
  };

  return {
    name: 'ChatApp',
    schemaVersion: 4,
    orbitals: [
      {
        id: ORB,
        name: 'ChatOrbital',
        entity: { name: 'Message', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [composer, inline],
        pages: [],
      },
    ],
  };
}

describe('processOrbitalEvent payload validation is scoped to the dispatch target, not every trait sharing the event key', () => {
  it('a Button-shaped SEND {} targeted at the optional-value trait succeeds despite a sibling requiring the field', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildSchema());

    const response = await runtime.processOrbitalEvent('ChatOrbital', {
      event: 'SEND',
      payload: {},
      targetTrait: 'ChatComposer',
    });

    expect(response.success).toBe(true);
  });

  it('the same dispatch targeted at the required-value trait is still rejected when value is missing', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildSchema());

    const response = await runtime.processOrbitalEvent('ChatOrbital', {
      event: 'SEND',
      payload: {},
      targetTrait: 'InlineInputGroupRender',
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('value');
  });

  it('an untargeted dispatch validates only against traits whose current state handles the event', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildSchema());

    // No targetTrait: ChatComposer's idle state has a SEND transition,
    // InlineInputGroupRender's does not — only ChatComposer's (optional)
    // schema should gate this dispatch.
    const response = await runtime.processOrbitalEvent('ChatOrbital', {
      event: 'SEND',
      payload: {},
    });

    expect(response.success).toBe(true);
  });
});
