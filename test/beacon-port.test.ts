import { expect, test } from 'vitest';
import { deliverBeacon, type BeaconDeliveryPorts, type BeaconFetchInit } from '../src/kernel/beacon-port.js';

interface Log {
  queued: Array<{ url: string; text: string }>;
  fetched: Array<{ url: string; init: BeaconFetchInit }>;
}

function ports(queue: 'accept' | 'decline' | 'throw' | 'absent', fetchStatus: number | 'reject'): { log: Log; ports: BeaconDeliveryPorts } {
  const log: Log = { queued: [], fetched: [] };
  return {
    log,
    ports: {
      ...(queue === 'absent'
        ? {}
        : {
            queue(url: string, text: string): boolean {
              if (queue === 'throw') throw new Error('blocked');
              log.queued.push({ url, text });
              return queue === 'accept';
            },
          }),
      fetch(url: string, init: BeaconFetchInit): Promise<{ status: number }> {
        log.fetched.push({ url, init });
        return fetchStatus === 'reject' ? Promise.reject(new Error('offline')) : Promise.resolve({ status: fetchStatus });
      },
    },
  };
}

test('an accepted queue is delivered via queue with no fetch', async () => {
  const { log, ports: p } = ports('accept', 200);
  await expect(deliverBeacon('https://c.example/e', 'body', p)).resolves.toEqual({ via: 'queue' });
  expect(log.queued).toEqual([{ url: 'https://c.example/e', text: 'body' }]);
  expect(log.fetched).toEqual([]);
});

test('a declined, throwing or absent queue falls back to exactly one keepalive cors fetch of the same body', async () => {
  for (const queue of ['decline', 'throw', 'absent'] as const) {
    const { log, ports: p } = ports(queue, 204);
    await expect(deliverBeacon('https://c.example/e', 'body', p)).resolves.toEqual({ via: 'fetch', status: 204 });
    expect(log.fetched).toEqual([
      { url: 'https://c.example/e', init: { method: 'POST', body: 'body', keepalive: true, mode: 'cors', headers: { 'Content-Type': 'text/plain' } } },
    ]);
  }
});

test('the fetch outcome is its status only and a network throw is a null status', async () => {
  for (const status of [200, 202, 300, 400, 500]) {
    await expect(deliverBeacon('https://c.example/e', 'b', ports('decline', status).ports)).resolves.toEqual({ via: 'fetch', status });
  }
  await expect(deliverBeacon('https://c.example/e', 'b', ports('decline', 'reject').ports)).resolves.toEqual({ via: 'fetch', status: null });
});
