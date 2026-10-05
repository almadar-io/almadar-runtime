/**
 * An EventTransport over a message channel, for a program hosted in another browser context (an
 * extension's service worker, a web worker, an iframe). The view half plays events and receives
 * pushes; the host half serves any EventTransport on the channel and pushes to its views. The
 * channel is two functions, so any postMessage-style port fits behind it.
 */
import type { EmittedEvent, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import type { EventTransport, HostDispatchListener, PushTarget } from './EventTransport.js';

export type ChannelMessage =
  | { almadarChannel: 'register'; id: number; schemaName: string }
  | { almadarChannel: 'registered'; id: number; held: boolean }
  | { almadarChannel: 'send'; id: number; orbitalName: string; request: OrbitalEventRequest }
  | { almadarChannel: 'reply'; id: number; response: OrbitalEventResponse }
  | { almadarChannel: 'push'; emitted: EmittedEvent; target: PushTarget }
  | { almadarChannel: 'dispatched'; orbitalName: string; request: OrbitalEventRequest; response: OrbitalEventResponse };

export interface TransportChannel {
  post(message: ChannelMessage): void;
  onMessage(listener: (message: ChannelMessage) => void): () => void;
  /** The other end went away for good (a stopped extension worker's port); absent for channels that cannot close. */
  onClose?(listener: () => void): () => void;
}

const CLOSED = 'The host closed the channel before answering';

export interface ChannelTransportOptions {
  /** The host on the other end keeps the program's browser-stored entities (see `EventTransport.hostsBrowserStore`). */
  hostsBrowserStore?: boolean;
}

/** The view half: an EventTransport whose program lives on the other end of the channel. */
export function createChannelTransport(channel: TransportChannel, options: ChannelTransportOptions = {}): EventTransport {
  let next = 1;
  const pending = new Map<number, (message: ChannelMessage) => void>();
  channel.onMessage((message) => {
    if (message.almadarChannel !== 'registered' && message.almadarChannel !== 'reply') return;
    const settle = pending.get(message.id);
    if (!settle) return;
    pending.delete(message.id);
    settle(message);
  });

  let closed = false;
  const closedReply = (id: number): ChannelMessage => ({
    almadarChannel: 'reply',
    id,
    response: { success: false, transitioned: false, states: {}, emittedEvents: [], error: CLOSED },
  });
  channel.onClose?.(() => {
    closed = true;
    for (const [id, settle] of pending) settle(closedReply(id));
    pending.clear();
  });

  const request = (build: (id: number) => ChannelMessage) =>
    new Promise<ChannelMessage>((resolve) => {
      const id = next++;
      if (closed) {
        resolve(closedReply(id));
        return;
      }
      pending.set(id, resolve);
      channel.post(build(id));
    });

  return {
    hostsBrowserStore: options.hostsBrowserStore === true,
    async register(schema: OrbitalSchema) {
      const reply = await request((id) => ({ almadarChannel: 'register', id, schemaName: schema.name }));
      const held = reply.almadarChannel === 'registered' && reply.held;
      return { success: held, carriesCircuitState: false };
    },
    async unregister() {
      pending.clear();
    },
    async send(orbitalName, req) {
      const reply = await request((id) => ({ almadarChannel: 'send', id, orbitalName, request: req }));
      if (reply.almadarChannel !== 'reply') {
        return { success: false, transitioned: false, states: {}, emittedEvents: [], error: 'The host answered out of protocol' };
      }
      return reply.response;
    },
    subscribe(onPush) {
      return channel.onMessage((message) => {
        if (message.almadarChannel === 'push') onPush(message.emitted, message.target);
      });
    },
    subscribeHostDispatches(onDispatch: HostDispatchListener) {
      return channel.onMessage((message) => {
        if (message.almadarChannel === 'dispatched') onDispatch(message.orbitalName, message.request, message.response);
      });
    },
  };
}

export interface ServedChannel {
  /** Push a host-side event to the view (e.g. one a declared input caused while no view was asking). */
  push(emitted: EmittedEvent, target: PushTarget): void;
  /** Send the view the result of a dispatch the host ran on its own. */
  pushDispatch(orbitalName: string, request: OrbitalEventRequest, response: OrbitalEventResponse): void;
  stop(): void;
}

/** The host half: serve `transport` on `channel` for the program named `schemaName`. */
export function serveChannel(channel: TransportChannel, transport: EventTransport, options: { schemaName: string }): ServedChannel {
  const stop = channel.onMessage((message) => {
    if (message.almadarChannel === 'register') {
      channel.post({ almadarChannel: 'registered', id: message.id, held: message.schemaName === options.schemaName });
      return;
    }
    if (message.almadarChannel !== 'send') return;
    transport.send(message.orbitalName, message.request).then(
      (response) => channel.post({ almadarChannel: 'reply', id: message.id, response }),
      (err: Error) =>
        channel.post({
          almadarChannel: 'reply',
          id: message.id,
          response: { success: false, transitioned: false, states: {}, emittedEvents: [], error: err.message },
        }),
    );
  });
  return {
    push: (emitted, target) => channel.post({ almadarChannel: 'push', emitted, target }),
    pushDispatch: (orbitalName, request, response) => channel.post({ almadarChannel: 'dispatched', orbitalName, request, response }),
    stop,
  };
}

/**
 * A channel that listens from the moment it is wrapped and keeps what arrives until something
 * subscribes, then hands it over in order: a host that is still starting (an extension worker
 * waking up) serves the channel late without losing the view's first messages.
 */
export function holdUntilServed(channel: TransportChannel): TransportChannel {
  let held: ChannelMessage[] | undefined = [];
  const listeners: Array<(message: ChannelMessage) => void> = [];
  channel.onMessage((message) => {
    if (held !== undefined) held.push(message);
    else listeners.forEach((l) => l(message));
  });
  return {
    post: (message) => channel.post(message),
    onMessage(listener) {
      listeners.push(listener);
      if (held !== undefined) {
        const early = held;
        held = undefined;
        early.forEach((m) => listeners.forEach((l) => l(m)));
      }
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    ...(channel.onClose !== undefined ? { onClose: channel.onClose.bind(channel) } : {}),
  };
}
