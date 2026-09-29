/**
 * Request bodies are never compressed by browsers, so registering a large app re-sent its whole
 * resolved schema raw on every preview mount (project-friday: 19.9 MB). A transport created with
 * `compressRequests` gzips large JSON bodies (`Content-Encoding: gzip`) for servers that inflate
 * them.
 */
import { gunzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { createHttpTransport } from '../src/server/EventTransport.js';

interface Sent {
  url: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

function recordingFetch(sent: Sent[]): typeof fetch {
  return async (url, init) => {
    const body = init?.body;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url: String(url), headers, bytes });
    const response = String(url).endsWith('/register')
      ? { success: true, topology: 'stateless' }
      : { success: true, transitioned: true, states: {}, emittedEvents: [] };
    return new Response(JSON.stringify(response));
  };
}

const largeSchema: OrbitalSchema = {
  name: 'big-app',
  version: '1.0.0',
  description: Array.from({ length: 20_000 }, (_, i) => `trait ${i % 50} renders a list of rows`).join(' '),
  orbitals: [],
};
const smallSchema: OrbitalSchema = { name: 'small-app', version: '1.0.0', orbitals: [] };

const decoded = (s: Sent): string => new TextDecoder().decode(s.headers['content-encoding'] === 'gzip' ? gunzipSync(s.bytes) : s.bytes);

describe('createHttpTransport — compressed request bodies', () => {
  it('gzips a large register body to a fraction of its size, and it decodes to the same JSON', async () => {
    const sent: Sent[] = [];
    const transport = createHttpTransport({ serverUrl: 'http://x/api/orbitals', fetch: recordingFetch(sent), compressRequests: true });
    await transport.register(largeSchema);
    const raw = JSON.stringify({ schema: largeSchema });
    expect(sent[0].headers['content-encoding']).toBe('gzip');
    expect(sent[0].headers['content-type']).toBe('application/json');
    expect(sent[0].bytes.byteLength).toBeLessThan(raw.length / 4);
    expect(decoded(sent[0])).toBe(raw);
  });

  it('a large event body is compressed the same way', async () => {
    const sent: Sent[] = [];
    const transport = createHttpTransport({ serverUrl: 'http://x/api/orbitals', fetch: recordingFetch(sent), compressRequests: true });
    await transport.send('BigOrbital', { event: 'SAVE', payload: { text: largeSchema.description ?? '' } });
    expect(sent[0].headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(decoded(sent[0])).payload.text).toBe(largeSchema.description);
  });

  it('control: without compressRequests the body is plain JSON with no encoding', async () => {
    const sent: Sent[] = [];
    const transport = createHttpTransport({ serverUrl: 'http://x/api/orbitals', fetch: recordingFetch(sent) });
    await transport.register(largeSchema);
    expect(sent[0].headers['content-encoding']).toBeUndefined();
    expect(decoded(sent[0])).toBe(JSON.stringify({ schema: largeSchema }));
  });

  it('edge: a small body stays uncompressed even with compressRequests', async () => {
    const sent: Sent[] = [];
    const transport = createHttpTransport({ serverUrl: 'http://x/api/orbitals', fetch: recordingFetch(sent), compressRequests: true });
    await transport.register(smallSchema);
    expect(sent[0].headers['content-encoding']).toBeUndefined();
    expect(decoded(sent[0])).toBe(JSON.stringify({ schema: smallSchema }));
  });
});
