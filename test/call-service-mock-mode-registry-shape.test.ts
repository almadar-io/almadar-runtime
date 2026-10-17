// Mock mode answers a call-service through the integrations registry's response
// shapes (`mockValueForDescriptor`), not a fixed stub; live mode is untouched.
import { describe, it, expect, vi } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

vi.mock('@almadar/core/mock', async (importOriginal) => {
    const { withTestService } = await import('./helpers/test-service-mock.js');
    return withTestService(await importOriginal<typeof import('@almadar/core/mock')>());
});

function schema(): OrbitalSchema {
  return {
    name: 'mock-mode-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'AskOrbital',
        pages: [],
        entity: { name: 'Turn', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
        traits: [
          {
            name: 'Asker',
            scope: 'instance',
            linkedEntity: 'Turn',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'ASK', name: 'Ask' }],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'ASK',
                  effects: [['call-service', 'test-svc', 'run', { url: 'https://example.com/hook', event: 'ASKED' }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function ask(mode: 'mock' | 'real', callService?: () => Promise<{ status: number }>) {
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    mode,
    ...(callService !== undefined ? { effectHandlers: { callService } } : {}),
  });
  await runtime.register(schema());
  const res = await runtime.processOrbitalEvent('AskOrbital', { event: 'ASK', targetTrait: 'Asker' });
  return res.effectResults?.find((e) => e.effect === 'call-service')?.data;
}

describe('call-service in mock mode', () => {
  it('answers with the registry-shaped result, not the fixed stub', async () => {
    const data = await ask('mock');
    expect(data).toMatchObject({ ok: true, status: 42, durationMs: 42 });
    expect(data).not.toHaveProperty('clientSecret');
    expect(data).not.toHaveProperty('status', 'succeeded');
  });

  it('control: live mode with an injected provider answers with the provider', async () => {
    const data = await ask('real', async () => ({ status: 202 }));
    expect(data).toMatchObject({ status: 202 });
  });
});
