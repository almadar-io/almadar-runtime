/**
 * std-realtime-chat "sending does nothing" (stateless): the composer's input
 * is an inline render trait whose props come from `@config.*`. Rendered by
 * the client role (a local INIT, nothing to post), it came out as a bare
 * `{ type: 'input-group' }` — no placeholder, no SEND action, no onChange —
 * because the client effect runner bound no `@config` at all, while the
 * server stage merges declared defaults < call-site config and forwards
 * `@user.*`. The same trait must render the same props on both paths.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalId, OrbitalSchema } from '@almadar/core';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import {
  buildTraitIndex,
  createIndexStageRunner,
  createMemoryCircuitStore,
  dispatchWithServerLeg,
  evaluateOrbitalEvent,
  StateMachineManager,
} from '../src/index.js';

const VIEWER = { id: 'viewer-1', name: 'Dev Viewer' };

function schema(): OrbitalSchema {
  return {
    name: 'render-config',
    version: '1.0.0',
    orbitals: [{
      name: 'ChatOrbital',
      id: 'orb_chat' as OrbitalId,
      pages: [],
      entity: { name: 'Message', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'draft', type: 'string', default: '' }] },
      traits: [{
        name: 'Input',
        linkedEntity: 'Message',
        scope: 'instance',
        local: true,
        config: {
          placeholder: { type: 'string', default: 'Type here' },
          action: { type: 'string', default: 'SUBMIT' },
          greeting: { type: 'string', default: '@user.name' },
          value: { type: 'string', default: '@entity.draft' },
        },
        stateMachine: {
          states: [{ name: 'ready', isInitial: true }],
          events: [],
          transitions: [{
            from: 'ready', to: 'ready', event: 'INIT',
            effects: [['render-ui', 'main', {
              type: 'input-group',
              placeholder: '@config.placeholder',
              action: '@config.action',
              label: '@config.greeting',
              value: '@config.value',
            }]],
          }],
        },
      }],
    }],
  } as OrbitalSchema;
}

/** The call-site config the composing organism passes (overrides a default). */
const CALL_SITE = { placeholder: 'Write a message…', action: 'SEND' };

function renderProps(effects: ReadonlyArray<readonly unknown[]> | undefined): Record<string, unknown> | undefined {
  const render = (effects ?? []).find((e) => e[0] === 'render-ui');
  const pattern = render?.[2];
  return pattern !== null && typeof pattern === 'object' && !Array.isArray(pattern) ? (pattern as Record<string, unknown>) : undefined;
}

async function clientRender(): Promise<Record<string, unknown> | undefined> {
  const s = schema();
  const traitIndex = buildTraitIndex(s.orbitals, { Input: CALL_SITE });
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const d = await dispatchWithServerLeg(
    { orbitalName: 'ChatOrbital', traitIndex, store, carriesCircuitState: true, user: VIEWER },
    { event: 'INIT', targetTrait: 'Input' },
  );
  expect(d.serverLeg).toBeUndefined();
  return renderProps(d.response.clientEffects);
}

async function serverRender(): Promise<Record<string, unknown> | undefined> {
  const s = schema();
  const traitIndex = buildTraitIndex(s.orbitals, { Input: CALL_SITE });
  const persistence = new InMemoryPersistence();
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const frames = new Map<string, EntityRow>();
  const r = await evaluateOrbitalEvent(
    { traitIndex, manager, persistence, frames, user: VIEWER, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) },
    { event: 'INIT', targetTrait: 'Input' },
  );
  return renderProps(r.clientEffects);
}

describe('render-ui @config props on the client role', () => {
  it('a call-site override wins over the declared default', async () => {
    const props = await clientRender();
    expect(props?.['placeholder']).toBe('Write a message…');
    expect(props?.['action']).toBe('SEND');
  });

  it('a declared default applies when no call site overrides it; a @user forward resolves', async () => {
    const props = await clientRender();
    expect(props?.['label']).toBe('Dev Viewer');
  });

  it('client and server render the same props', async () => {
    const [client, server] = await Promise.all([clientRender(), serverRender()]);
    expect(server?.['placeholder']).toBe('Write a message…');
    for (const key of ['type', 'placeholder', 'action', 'label']) {
      expect([key, client?.[key]]).toEqual([key, server?.[key]]);
    }
  });
});
