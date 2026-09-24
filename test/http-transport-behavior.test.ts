/**
 * G-RUNTIME-041: the hosted stateless route resolves which catalog behavior an
 * event belongs to from `request.behavior`. Orbital names are not unique
 * across the catalog (project-friday's `GlobalSearchOrbital` vs
 * std-global-search's own), so without it the route guessed — and ran
 * project-friday's search against the wrong bundle. The transport knows the
 * registered schema and stamps its name on every send.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { createHttpTransport } from '../src/server/EventTransport.js';

describe('createHttpTransport — behavior addressing', () => {
  it('stamps the registered schema name on every posted event', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/register')) return new Response(JSON.stringify({ success: true, topology: 'stateless' }));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true, transitioned: true, states: {}, emittedEvents: [] }));
    }) as typeof fetch;
    const transport = createHttpTransport({ serverUrl: 'http://x/api/orbitals', fetch: fetchStub });
    await transport.register({ name: 'project-friday', orbitals: [] } as OrbitalSchema);
    await transport.send('GlobalSearchOrbital', { event: 'SEARCH', targetTrait: 'GlobalSearchAll' });
    expect(bodies[0]?.['behavior']).toBe('project-friday');
  });
});
