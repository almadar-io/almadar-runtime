/**
 * `call-service` reaches a real provider on the runtime path, and its outcome
 * picks the declared route: a provider failure fires `emit.failure` (the stage
 * used to swallow the error and emit SUCCESS), and with no host handler in
 * real mode the call goes to @almadar/integrations configured from the env,
 * so a missing key is a named failure, never a silent success.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const sendTrait: Trait = {
  name: 'Send',
  scope: 'instance',
  linkedEntity: 'Mail',
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }],
    events: [{ key: 'GO', name: 'GO' }],
    transitions: [{
      from: 'idle', to: 'idle', event: 'GO',
      effects: [['call-service', 'knowledge', 'status', {},
        { emit: { success: 'SENT', failure: 'SEND_FAILED' } }]],
    }],
  },
};

const schema = (): OrbitalSchema => ({
  name: 'svc',
  version: '1.0.0',
  orbitals: [{
    name: 'Mailer',
    pages: [],
    entity: { name: 'Mail', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [sendTrait],
  }],
});

async function fire(runtime: OrbitalServerRuntime) {
  await runtime.register(schema());
  const res = await runtime.processOrbitalEvent('Mailer', { event: 'GO', payload: {}, targetTrait: 'Send' });
  runtime.unregisterAll();
  return res.emittedEvents;
}

const KEY_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT_PATH'];
const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('call-service on the runtime path', () => {
  it('a provider failure fires the declared failure route, not success', async () => {
    const runtime = new OrbitalServerRuntime({
      mode: 'real',
      debug: false,
      effectHandlers: { callService: async () => { throw new Error('provider down'); } },
    });
    const events = (await fire(runtime)).map((e) => e.event);
    expect(events).toContain('SEND_FAILED');
    expect(events).not.toContain('SENT');
  });

  it('with no host handler, real mode calls @almadar/integrations; a missing key is a named failure', async () => {
    for (const k of KEY_VARS) delete process.env[k];
    const runtime = new OrbitalServerRuntime({ mode: 'real', debug: false });
    const events = await fire(runtime);
    const failed = events.find((e) => e.event === 'SEND_FAILED');
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed?.payload)).toContain('Integration not configured: knowledge');
    expect(events.map((e) => e.event)).not.toContain('SENT');
  });

  it('control: a host handler result is the success payload', async () => {
    const runtime = new OrbitalServerRuntime({
      mode: 'real',
      debug: false,
      effectHandlers: { callService: async () => ({ id: 'msg-1' }) },
    });
    const sent = (await fire(runtime)).find((e) => e.event === 'SENT');
    expect(sent?.payload).toMatchObject({ id: 'msg-1' });
  });

  it('control: mock mode keeps mocked services (verification walks never send for real)', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    expect((await fire(runtime)).map((e) => e.event)).toContain('SENT');
  });
});
