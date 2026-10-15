// The HTTP transport's resolve route: POSTs the reference to `<serverUrl>/resolve-rows` as the signed-in viewer.
import { describe, expect, it, vi } from 'vitest';
import type { RowSetRef } from '@almadar/core';
import { createHttpTransport, createInProcessTransport } from '../src/server/EventTransport.js';

const reference: RowSetRef = { entityType: 'Note', ids: ['a1', 'a2'], total: 3, query: {} };
const json = (body: object, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createHttpTransport().resolveRows', () => {
  it('posts the reference with the viewer\'s token and returns the page', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ rows: [{ id: 'a1' }], total: 2 }));
    const transport = createHttpTransport({ serverUrl: '/api/orbitals', fetch: fetchFn, getAccessToken: async () => 'tok' });
    const page = await transport.resolveRows?.(reference);
    expect(page).toEqual({ rows: [{ id: 'a1' }], total: 2 });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/orbitals/resolve-rows');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: reference });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('a refused resolve rejects instead of answering an empty page', async () => {
    const transport = createHttpTransport({ serverUrl: '/api/orbitals', fetch: (async () => json({ error: 'no' }, 500)) as typeof fetch });
    await expect(transport.resolveRows?.(reference)).rejects.toThrow(/500/);
  });

  it('control: an in-process transport has no resolve route', () => {
    expect(createInProcessTransport(async () => { throw new Error('unused'); }).resolveRows).toBeUndefined();
  });
});
