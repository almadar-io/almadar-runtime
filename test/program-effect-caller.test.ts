// A program effect runs as the requesting viewer, as `call-service` does: the
// program host opens that caller's workspace and refuses another user's.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';
import type { ProgramCallContext } from '@almadar/integrations/program';

function schema(): OrbitalSchema {
  return {
    name: 'program-caller-app',
    version: '1.0.0',
    orbitals: [{
      name: 'Studio',
      pages: [],
      entity: { name: 'Draft', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
      traits: [{
        name: 'Builder',
        scope: 'instance',
        linkedEntity: 'Draft',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'BUILD', name: 'Build' }, { key: 'BUILT', name: 'Built' }, { key: 'FAILED', name: 'Failed' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'BUILD', effects: [['program/eval', { name: 'App', orbitals: [] }, { workspace: 'app-1' }, { emit: { success: 'BUILT', failure: 'FAILED' } }]] },
            { from: 'idle', to: 'idle', event: 'BUILT' },
            { from: 'idle', to: 'idle', event: 'FAILED' },
          ],
        },
      }],
    }],
  };
}

async function callerOf(user: { id: string; role: string } | undefined): Promise<Array<ProgramCallContext | undefined>> {
  const seen: Array<ProgramCallContext | undefined> = [];
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    defaultUser: { id: 'host-default', role: 'member' },
    effectHandlers: {
      programEffect: async (_op, _args, context) => {
        seen.push(context);
        return { ok: true, result: 'done' };
      },
    },
  });
  await runtime.register(schema());
  await runtime.processOrbitalEvent('Studio', { event: 'BUILD', targetTrait: 'Builder', ...(user !== undefined ? { user } : {}) });
  return seen;
}

describe('program effects run as the requesting viewer', () => {
  it('the host receives the viewer as principal and role', async () => {
    expect(await callerOf({ id: 'alice', role: 'member' })).toEqual([{ principal: 'alice', role: 'member' }]);
  });

  it('control: a request with no user runs as the runtime\'s default user, as call-service does', async () => {
    expect(await callerOf(undefined)).toEqual([{ principal: 'host-default', role: 'member' }]);
  });
});
