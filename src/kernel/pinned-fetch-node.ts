/** Node-only: the `http` effect's default fetch, pinned to the address the egress check resolved. */
import { Agent, fetch as undiciFetch } from 'undici';
import type { PinnedFetch } from './http-exchange.js';

export const pinnedFetchNode: PinnedFetch = async (url, init, address) => {
  const dispatcher = new Agent({
    ...(init.signal !== undefined ? { headersTimeout: 0, bodyTimeout: 0 } : {}),
    connect: {
      lookup: (_host, options, callback) => {
        const family = address.includes(':') ? 6 : 4;
        if (options.all === true) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    },
  });
  try {
    return await undiciFetch(url, { ...init, dispatcher });
  } finally {
    void dispatcher.close();
  }
};
