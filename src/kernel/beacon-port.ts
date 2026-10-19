/** The keepalive fetch a beacon falls back to: always the same method, mode and `text/plain` header. */
export interface BeaconFetchInit {
  method: 'POST';
  body: string;
  keepalive: true;
  mode: 'cors';
  headers: { 'Content-Type': 'text/plain' };
}

/** What a host offers a beacon: a queue that may accept the text (true) or decline, and a status-only fetch. */
export interface BeaconDeliveryPorts {
  queue?: (url: string, text: string) => boolean;
  fetch: (url: string, init: BeaconFetchInit) => Promise<{ status: number }>;
}

/** How a beacon was taken: the queue accepted it, or one fetch answered `status` (null when the fetch threw). */
export type BeaconDelivery = { via: 'queue' } | { via: 'fetch'; status: number | null };

/**
 * The queue-first, fetch-fallback decision, once. text/plain keeps the request CORS "simple": no preflight,
 * adblocker-friendly when proxied. A declined, throwing or absent queue falls back; the fetch body is never read.
 */
export async function deliverBeacon(url: string, text: string, ports: BeaconDeliveryPorts): Promise<BeaconDelivery> {
  try {
    if (ports.queue !== undefined && ports.queue(url, text)) return { via: 'queue' };
  } catch {
    // The queue threw — fall through to fetch.
  }
  try {
    const { status } = await ports.fetch(url, {
      method: 'POST',
      body: text,
      keepalive: true,
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain' },
    });
    return { via: 'fetch', status };
  } catch {
    return { via: 'fetch', status: null };
  }
}
