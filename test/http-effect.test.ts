// The `http` effect on the server runtime: the kernel builds the request, the host moves the bytes, the
// outcome routes to emit.success / failure / cancelled.
import { describe, it, expect } from 'vitest';
import type { CallServiceEmitConfig, HttpEffect, SExpr } from '@almadar/core';
import { fakeHttpKernel } from './helpers/fake-http-kernel.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

const ORIGIN = 'https://api.example.com';
const ALL = { success: 'OK', failure: 'ERR', cancelled: 'CANCELLED' };

const http = (request: SExpr, options: CallServiceEmitConfig = { emit: ALL }, origin = ORIGIN): HttpEffect => ['http', 'GET', origin, '/search', request, options];

describe('http effect (server runtime)', () => {
    function schema(): OrbitalSchema {
        return {
            name: 'http-app', version: '1.0.0', egress: [ORIGIN],
            orbitals: [{
                name: 'Ask', pages: [],
                entity: { name: 'Turn', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
                traits: [{
                    name: 'Asker', scope: 'instance', linkedEntity: 'Turn',
                    stateMachine: {
                        states: [{ name: 'idle', isInitial: true }],
                        events: [{ key: 'ASK', name: 'Ask' }, { key: 'ERR', name: 'Err' }, { key: 'OK', name: 'Ok' }],
                        transitions: [{ from: 'idle', to: 'idle', event: 'ASK', effects: [http({}, { emit: ALL })] }],
                    },
                }],
            }],
        };
    }
    it('lists the http effect and the emit of its failure route among the effect results when the transport has no network', async () => {
        const runtime = new OrbitalServerRuntime({
            persistence: new InMemoryPersistence(), debug: false, mode: 'mock',
            http: { kernel: async () => fakeHttpKernel, fetch: () => { throw new Error('verify has no network'); }, resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }) },
        });
        await runtime.register(schema());
        const res = await runtime.processOrbitalEvent('Ask', { event: 'ASK', targetTrait: 'Asker' });
        expect(res.effectResults?.filter((e) => e.effect === 'http' || e.effect === 'emit')).toEqual([
            { effect: 'http', success: false, target: `GET ${ORIGIN}/search`, error: 'verify has no network', routed: 'ERR' },
            { effect: 'emit', success: true, target: 'ERR' },
        ]);
    });
});
