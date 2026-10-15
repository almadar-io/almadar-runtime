// The real `@almadar/kernel` driver behind the host's transport: skipped without a built kernel (ALMADAR_KERNEL_DIR).
// The driver's decisions (credentials, OAuth, pagination, framing) are orbital-core's; this proves the host answers its asks.
import { describe, it, expect } from 'vitest';
import { createHttpPorts, createHttpSecrets, runHttpCall, type HttpCall } from '../src/kernel/http-exchange.js';
import { loadHttpKernel } from '../src/kernel/load-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import type { FakeFetch } from './helpers/fake-http-kernel.js';

describe.skipIf(KERNEL_DIR === undefined)('http effect on the real kernel driver', () => {
  const ports = async (secrets: Record<string, string>, fetchImpl: FakeFetch) => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const store = createHttpSecrets();
    for (const [name, value] of Object.entries(secrets)) await store.set(name, value, 60_000);
    return createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com'],
      secrets: store,
      fetch: async (url, init, address) => fetchImpl(url.href, init, address),
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
    });
  };
  const call: HttpCall = { method: 'GET', origin: 'https://api.example.com', path: '/search', request: { query: { q: 'a b' }, auth: { scheme: 'bearer', credential: 'KEY' } } };

  it('builds the encoded URL and bearer header, and shapes the reply', async () => {
    const sent: Array<{ url: string; auth: string | undefined }> = [];
    const p = await ports({ KEY: 'tok' }, (url, init) => {
      sent.push({ url, auth: init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] });
      return new Response('ok', { status: 404 });
    });
    expect(await runHttpCall(p, call)).toMatchObject({ ok: { status: 404, body: 'ok' } });
    expect(sent).toEqual([{ url: 'https://api.example.com/search?q=a%20b', auth: 'Bearer tok' }]);
  });

  it('refuses a missing credential and an origin outside egress without sending', async () => {
    let sends = 0;
    const p = await ports({}, () => { sends += 1; return new Response('x'); });
    expect(await runHttpCall(p, call)).toMatchObject({ error: { kind: 'refused' } });
    expect(await runHttpCall(p, { ...call, origin: 'https://evil.example.com' })).toMatchObject({ error: { kind: 'refused' } });
    expect(sends).toBe(0);
  });

  it('paginates by link header through the driver', async () => {
    const p = await ports({}, (url) => (url.endsWith('/p2')
      ? new Response('b', { status: 200 })
      : new Response('a', { status: 200, headers: { Link: '<https://api.example.com/p2>; rel="next"' } })));
    const paged: HttpCall = { ...call, request: { paginate: { style: 'link-header', collect: ['list', '@response.body'], max: 5 } } };
    expect(await runHttpCall(p, paged)).toMatchObject({ ok: { pages: 2, items: ['a', 'b'] } });
  });
});
