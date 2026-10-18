import { describe, it, expect } from 'vitest';
import type { IoRequestWire } from '@almadar/core/kernel-wire';
import type { JsonValue } from '@almadar/core';
import { decodeRequest } from '../src/kernel/decode.js';

const site = { trait: 'T', followOn: false, emit: { success: 'OK', failure: 'BAD' } };
const request = { method: 'GET', url: 'https://api.example.com/x', headers: [['a', 'b']] as Array<[string, string]>, body: { kind: 'empty' as const } };
const ref = { instance: 'i', orbital: 'O', trait: 'T' };

/** One sample per wire kind; keyed by the generated union, so a kind the wire gains cannot go unsampled. */
const SAMPLES: { readonly [K in IoRequestWire['kind']]: Extract<IoRequestWire, { kind: K }> } = {
  readRow: { kind: 'readRow', entityType: 'E', id: '1' },
  listRows: { kind: 'listRows', entityType: 'E' },
  queryRows: { kind: 'queryRows', entityType: 'E', query: {}, project: 'rows' },
  writeRows: { kind: 'writeRows', batch: { ops: [], onFailure: 'atomic' } },
  createRow: { kind: 'createRow', entityType: 'E', data: { a: 1 } },
  writeRow: { kind: 'writeRow', entityType: 'E', id: '1', data: { a: 1 } },
  deleteRow: { kind: 'deleteRow', entityType: 'E', id: '1' },
  callService: { kind: 'callService', service: 's', method: 'm', args: {}, key: 'k', site },
  cancelCall: { kind: 'cancelCall', key: 'k' },
  substrate: { kind: 'substrate', op: 'program/eval', args: [] },
  http: { kind: 'http', request, key: 'k', delayMs: 5, site },
  httpStream: { kind: 'httpStream', request, key: 'k', framing: 'sse', site },
  httpBeacon: { kind: 'httpBeacon', request, key: 'k', site },
  pageFacts: { kind: 'pageFacts', fields: ['hostname', 'screenWidth'] },
  prompt: { kind: 'prompt', text: 't', schema: 's', key: 'k' },
  embed: { kind: 'embed', texts: ['a'], key: 'k' },
  tab: { kind: 'tab', ask: { kind: 'navigate', tab: 7, url: 'https://example.com/a' }, key: 'k' },
  secret: { kind: 'secret', name: 'n', principal: 'p' },
  secretSet: { kind: 'secretSet', name: 'n', value: 'v', ttlMs: 5, principal: 'p' },
  secretRotate: { kind: 'secretRotate', name: 'n', value: 'v', principal: 'p' },
  oauth: { kind: 'oauth', ask: { ask: 'connectionAvailable' }, principal: 'p' },
  deliver: { kind: 'deliver', envelope: { id: 'e', from: ref, to: ref, event: 'EV', payload: { a: 1 }, causalId: 'c', hop: 1 }, key: 'k', site },
  random: { kind: 'random', bytes: 4 },
  os: { kind: 'os', op: 'os/recv', args: [1, 2], key: 'k', site },
  credentialStatus: { kind: 'credentialStatus', name: 'n', principal: 'p' },
  credentialForget: { kind: 'credentialForget', name: 'n', principal: 'p' },
  clock: { kind: 'clock' },
  credentialStoreList: { kind: 'credentialStoreList' },
  credentialStoreRead: { kind: 'credentialStoreRead', name: 'n' },
  credentialStoreWrite: { kind: 'credentialStoreWrite', service: 's', name: 'n', value: 'v' },
  credentialStoreRemove: { kind: 'credentialStoreRemove', name: 'n' },
  credentialStoreRotate: { kind: 'credentialStoreRotate' },
  credentialModeRead: { kind: 'credentialModeRead' },
  credentialModeWrite: { kind: 'credentialModeWrite', mode: 'mock' },
};

function wire(sample: IoRequestWire): JsonValue {
  return JSON.parse(JSON.stringify(sample));
}

describe('decodeRequest', () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    it(`round-trips a ${kind} request`, () => {
      expect(decodeRequest(wire(sample))).toEqual(sample);
    });
  }

  it('refuses a kind the wire does not have', () => {
    expect(() => decodeRequest({ kind: 'nope' })).toThrow('unknown request kind "nope"');
  });
});
