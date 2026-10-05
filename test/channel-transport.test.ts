// An EventTransport over a message channel: a view (popup, side panel, iframe, worker client) plays
// events into a program hosted in another context, and receives that host's pushes. The host half
// serves any EventTransport (here an in-process one) on the channel.
import { describe, it, expect } from 'vitest';
import type { EmittedEvent, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { createChannelTransport, holdUntilServed, serveChannel, type ChannelMessage, type TransportChannel } from '../src/server/channel-transport.js';
import { createInProcessTransport, type PushTarget } from '../src/server/EventTransport.js';

function pair(): [TransportChannel, TransportChannel] {
  const a: Array<(m: ChannelMessage) => void> = [];
  const b: Array<(m: ChannelMessage) => void> = [];
  const make = (mine: typeof a, theirs: typeof a): TransportChannel => ({
    post: (m) => queueMicrotask(() => theirs.forEach((l) => l(structuredClone(m)))),
    onMessage: (l) => {
      mine.push(l);
      return () => mine.splice(mine.indexOf(l), 1);
    },
  });
  return [make(a, b), make(b, a)];
}

const schema: OrbitalSchema = { name: 'app', version: '1.0.0', orbitals: [] };

function host(handle: (orbital: string, req: OrbitalEventRequest) => Promise<OrbitalEventResponse>) {
  const [viewEnd, hostEnd] = pair();
  const served = serveChannel(hostEnd, createInProcessTransport(handle), { schemaName: 'app' });
  return { view: createChannelTransport(viewEnd), served };
}

const ok = (event: string): OrbitalEventResponse => ({ success: true, transitioned: true, states: { T: event }, emittedEvents: [] });

describe('channel transport', () => {
  it('register confirms the host holds the program and owns its state', async () => {
    const { view } = host(async () => ok('x'));
    expect(await view.register(schema)).toEqual({ success: true, carriesCircuitState: false });
  });

  it('control: registering a program the host does not hold fails', async () => {
    const { view } = host(async () => ok('x'));
    expect((await view.register({ ...schema, name: 'other' })).success).toBe(false);
  });

  it('send plays the event on the host and returns its response; concurrent sends never cross', async () => {
    const { view } = host(async (_o, req) => ok(req.event));
    const [a, b] = await Promise.all([view.send('O', { event: 'A', payload: {} }), view.send('O', { event: 'B', payload: {} })]);
    expect(a.states).toEqual({ T: 'A' });
    expect(b.states).toEqual({ T: 'B' });
  });

  it('a host failure comes back as a failure response, not a hang', async () => {
    const { view } = host(async () => {
      throw new Error('boom');
    });
    const res = await view.send('O', { event: 'A', payload: {} });
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom');
  });

  it('host pushes reach every subscribed view until it unsubscribes', async () => {
    const { view, served } = host(async () => ok('x'));
    const got: Array<{ emitted: EmittedEvent; target: PushTarget }> = [];
    const stop = view.subscribe?.((emitted, target) => got.push({ emitted, target }));
    served.push({ event: 'ITEM_SEEN', payload: { id: 1 } }, 'peers');
    await new Promise((r) => setTimeout(r, 0));
    stop?.();
    served.push({ event: 'ITEM_SEEN', payload: { id: 2 } }, 'peers');
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([{ emitted: { event: 'ITEM_SEEN', payload: { id: 1 } }, target: 'peers' }]);
  });
});

describe('channel transport: a host that runs the whole program', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('a view hears the results of dispatches the host ran on its own, until it unsubscribes', async () => {
    const { view, served } = host(async () => ok('x'));
    const heard: Array<{ orbital: string; event: string; states: Record<string, string> }> = [];
    const stop = view.subscribeHostDispatches?.((orbital, request, response) => heard.push({ orbital, event: request.event, states: response.states }));
    served.pushDispatch('Feed', { event: 'ITEM_SEEN', targetTrait: 'Watch', payload: {} }, ok('seen'));
    await flush();
    expect(heard).toEqual([{ orbital: 'Feed', event: 'ITEM_SEEN', states: { T: 'seen' } }]);
    stop?.();
    served.pushDispatch('Feed', { event: 'ITEM_SEEN', targetTrait: 'Watch', payload: {} }, ok('again'));
    await flush();
    expect(heard).toHaveLength(1);
  });

  it('control: an event push is not a host dispatch, and a host dispatch is not an event push', async () => {
    const { view, served } = host(async () => ok('x'));
    const dispatches: string[] = [];
    const pushes: string[] = [];
    view.subscribeHostDispatches?.((_o, request) => dispatches.push(request.event));
    view.subscribe?.((emitted) => pushes.push(emitted.event));
    served.push({ event: 'PUSHED', payload: {} }, 'peers');
    served.pushDispatch('Feed', { event: 'RAN', payload: {} }, ok('x'));
    await flush();
    expect(dispatches).toEqual(['RAN']);
    expect(pushes).toEqual(['PUSHED']);
  });

  it('a view says whether its host keeps the browser store, as its creator declared', () => {
    const [viewEnd] = pair();
    expect(createChannelTransport(viewEnd, { hostsBrowserStore: true }).hostsBrowserStore).toBe(true);
    expect(createChannelTransport(viewEnd).hostsBrowserStore).toBe(false);
  });
});

describe('channel transport: the host goes away', () => {
  function closable() {
    const closeListeners: Array<() => void> = [];
    const posted: ChannelMessage[] = [];
    const channel: TransportChannel = {
      post: (m) => { posted.push(m); },
      onMessage: () => () => undefined,
      onClose: (l) => {
        closeListeners.push(l);
        return () => closeListeners.splice(closeListeners.indexOf(l), 1);
      },
    };
    return { channel, posted, close: () => closeListeners.forEach((l) => l()) };
  }

  it('a send in flight when the channel closes fails, instead of waiting for a reply that cannot come', async () => {
    const { channel, close } = closable();
    const view = createChannelTransport(channel);
    const reply = view.send('O', { event: 'A', payload: {} });
    close();
    expect(await reply).toMatchObject({ success: false, transitioned: false, error: 'The host closed the channel before answering' });
  });

  it('a send after the channel closed fails at once, without posting', async () => {
    const { channel, posted, close } = closable();
    const view = createChannelTransport(channel);
    close();
    expect(await view.send('O', { event: 'B', payload: {} })).toMatchObject({ success: false, error: 'The host closed the channel before answering' });
    expect(posted).toEqual([]);
  });

  it('control: a channel that never reports closing behaves as before', async () => {
    const { view } = host(async (_o, req) => ok(req.event));
    expect((await view.send('O', { event: 'C', payload: {} })).states).toEqual({ T: 'C' });
  });
});

describe('channel transport: a host that is still starting', () => {
  it('messages that arrive before the host serves the channel are kept and served once it does, in order', async () => {
    const [viewEnd, hostEnd] = pair();
    const held = holdUntilServed(hostEnd);
    const view = createChannelTransport(viewEnd);
    const registered = view.register(schema);
    const sent = view.send('O', { event: 'EARLY', payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    serveChannel(held, createInProcessTransport(async (_o, req) => ok(req.event)), { schemaName: 'app' });
    expect((await registered).success).toBe(true);
    expect((await sent).states).toEqual({ T: 'EARLY' });
  });

  it('control: once served, later messages pass straight through', async () => {
    const [viewEnd, hostEnd] = pair();
    serveChannel(holdUntilServed(hostEnd), createInProcessTransport(async (_o, req) => ok(req.event)), { schemaName: 'app' });
    expect((await createChannelTransport(viewEnd).send('O', { event: 'LATE', payload: {} })).states).toEqual({ T: 'LATE' });
  });
});
