// An EventTransport over a message channel: a view (popup, side panel, iframe, worker client) plays
// events into a program hosted in another context, and receives that host's pushes. The host half
// serves any EventTransport (here an in-process one) on the channel.
import { describe, it, expect } from 'vitest';
import type { EmittedEvent, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { createChannelTransport, serveChannel, type ChannelMessage, type TransportChannel } from '../src/server/channel-transport.js';
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
