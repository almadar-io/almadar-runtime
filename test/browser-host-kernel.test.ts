// The browser host on the kernel engine (an extension's service worker, `engine: 'kernel'`): the wasm kernel decides every
// step and the host answers its raw asks. The browser tabs are answered by the real `chromeTabPort` over a fake of the
// Chrome API, so `browser/tab-open|list|query|watch` run end to end. Skipped without a built kernel (ALMADAR_KERNEL_DIR).
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EventPayload, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { chromeTabPort, type ChromeRuntimeApi, type ChromeTabsApi, type PageMessage, type PageReply } from '@almadar/integrations/browser';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { tickEventKey } from '../src/traits/StateMachineCore';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';
import type { KernelModule } from '../src/kernel/index.js';
import { KERNEL_DIR, loadKernel } from './helpers/kernel-module.js';

type Listener = (message: PageMessage, sender: { tab?: { id?: number; url?: string } }, respond: (reply: PageReply) => void) => boolean | void;

const routes = { emit: { success: 'OK', failure: 'BAD' } };

function program(): OrbitalSchema {
  return {
    name: 'Pages',
    orbitals: [{
      name: 'Pages',
      entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{
        name: 'Pager',
        linkedEntity: 'Job',
        category: 'interaction',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [
            { key: 'OPEN', name: 'Open' }, { key: 'LIST', name: 'List' }, { key: 'READ', name: 'Read' }, { key: 'WATCH', name: 'Watch' },
            { key: 'OK', name: 'Ok' }, { key: 'BAD', name: 'Bad' },
            { key: 'ITEM_SEEN', name: 'Item seen', external: true },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'OPEN', effects: [['browser/tab-open', { url: '@payload.url', active: true }, routes]] },
            { from: 'idle', to: 'idle', event: 'LIST', effects: [['browser/tab-list', { match: 'https://example.com/*' }, routes]] },
            { from: 'idle', to: 'idle', event: 'READ', effects: [['browser/tab-query', { tab: 1, selector: '.item', fields: { title: { selector: 'h2' } } }, routes]] },
            { from: 'idle', to: 'idle', event: 'WATCH', effects: [['browser/tab-watch', { match: 'https://example.com/*', selector: '.item', fields: { title: { selector: 'h2' } }, event: 'ITEM_SEEN' }, routes]] },
            { from: 'idle', to: 'idle', event: 'OK', effects: [] },
            { from: 'idle', to: 'idle', event: 'BAD', effects: [] },
            { from: 'idle', to: 'idle', event: 'ITEM_SEEN', effects: [] },
          ],
        },
      }],
      pages: [],
    }],
  };
}

interface FakeChrome {
  tabs: ChromeTabsApi;
  runtime: ChromeRuntimeApi;
  created: Array<{ url: string; active: boolean }>;
  commands: Array<{ tab: number; kind: string }>;
  report(message: PageMessage, tab: number): void;
}

function fakeChrome(pageAnswer: (kind: string) => PageReply | undefined): FakeChrome {
  const listeners: Listener[] = [];
  const created: Array<{ url: string; active: boolean }> = [];
  const commands: Array<{ tab: number; kind: string }> = [];
  return {
    created,
    commands,
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/a', title: 'A', active: true }, { id: 2, url: 'https://other.test/', title: 'B', active: false }],
      create: async (props) => {
        created.push(props);
        return { id: 42, url: props.url, active: props.active };
      },
      remove: async () => undefined,
      update: async (tab) => ({ id: tab }),
      sendMessage: async (tab, message) => {
        if (message.almadarPage !== 'command') return undefined;
        commands.push({ tab, kind: message.command.kind });
        return pageAnswer(message.command.kind);
      },
    },
    runtime: {
      sendMessage: async () => undefined,
      onMessage: { addListener: (listener) => { listeners.push(listener); } },
    },
    report(message, tab) {
      for (const listener of listeners) listener(message, { tab: { id: tab, url: 'https://example.com/a' } }, () => undefined);
    },
  };
}

const answer = (kind: string): PageReply | undefined =>
  kind === 'query' ? { result: [{ elementId: 'el-1', fields: { title: 'Hello' } }] } : { result: null };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const emitted = (response: OrbitalEventResponse, event: string): EventPayload | undefined =>
  response.emittedEvents.find((e) => e.event === event)?.payload;

describe.skipIf(KERNEL_DIR === undefined)('browser host on the kernel engine', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });

  const open = (chrome: FakeChrome, extra: Partial<Parameters<typeof openBrowserHost>[0]> = {}): Promise<BrowserHost> =>
    openBrowserHost({
      databaseName: `kernel-${Math.random()}`,
      schema: program(),
      callService: async () => null,
      engine: 'kernel',
      kernel,
      tabs: chromeTabPort(chrome.tabs, chrome.runtime, (pattern, url) => kernel.tabUrlMatches(pattern, url)),
      ...extra,
    });

  it('browser/tab-open creates the tab through the Chrome API and emits the tab it opened', async () => {
    const chrome = fakeChrome(answer);
    const host = await open(chrome);
    const response = await host.send('Pages', { event: 'OPEN', targetTrait: 'Pager', payload: { url: 'https://example.com/results' } });
    expect(chrome.created).toEqual([{ url: 'https://example.com/results', active: true }]);
    expect(emitted(response, 'OK')).toMatchObject({ tab: 42 });
    expect(emitted(response, 'BAD')).toBeUndefined();
    host.close();
  });

  it('browser/tab-list keeps the tabs the match pattern keeps', async () => {
    const chrome = fakeChrome(answer);
    const host = await open(chrome);
    const response = await host.send('Pages', { event: 'LIST', targetTrait: 'Pager' });
    expect(emitted(response, 'OK')).toMatchObject({ tabs: [{ tab: 1, url: 'https://example.com/a', title: 'A', active: true }] });
    host.close();
  });

  it('browser/tab-query reads the page elements through the page script', async () => {
    const chrome = fakeChrome(answer);
    const host = await open(chrome);
    const response = await host.send('Pages', { event: 'READ', targetTrait: 'Pager' });
    expect(chrome.commands).toEqual([{ tab: 1, kind: 'query' }]);
    expect(emitted(response, 'OK')).toMatchObject({ tab: 1, elements: [{ elementId: 'el-1', fields: { title: 'Hello' } }] });
    host.close();
  });

  it('browser/tab-watch attaches to the matching tab and each reported element is dispatched as the declared input', async () => {
    const chrome = fakeChrome(answer);
    const host = await open(chrome);
    const dispatched: Array<{ request: OrbitalEventRequest; response: OrbitalEventResponse }> = [];
    host.onInputDispatched((_orbital, request, response) => dispatched.push({ request, response }));
    const response = await host.send('Pages', { event: 'WATCH', targetTrait: 'Pager' });
    const watchId = emitted(response, 'OK')?.['watchId'];
    expect(typeof watchId).toBe('string');
    expect(chrome.commands).toEqual([{ tab: 1, kind: 'watch' }]);
    chrome.report({ almadarPage: 'element', watchId: String(watchId), url: 'https://example.com/a', element: { elementId: 'el-5', fields: { title: 'Hi' } } }, 1);
    await flush();
    expect(dispatched.map((d) => ({ event: d.request.event, payload: d.request.payload }))).toEqual([
      { event: 'ITEM_SEEN', payload: { tab: 1, elementId: 'el-5', url: 'https://example.com/a', fields: { title: 'Hi' } } },
    ]);
    expect(dispatched[0]?.response.success).toBe(true);
    host.close();
  });

  it('a page script that is not there fails the ask with its kind', async () => {
    const chrome = fakeChrome(() => undefined);
    const host = await open(chrome);
    const response = await host.send('Pages', { event: 'READ', targetTrait: 'Pager' });
    expect(emitted(response, 'BAD')).toMatchObject({ kind: 'not-ready' });
    expect(emitted(response, 'OK')).toBeUndefined();
    host.close();
  });

  it('control: a kernel host given no tabs answers every tab ask unavailable', async () => {
    const chrome = fakeChrome(answer);
    const host = await open(chrome, { tabs: undefined });
    const response = await host.send('Pages', { event: 'OPEN', targetTrait: 'Pager', payload: { url: 'https://example.com/' } });
    expect(emitted(response, 'BAD')).toMatchObject({ kind: 'unavailable' });
    expect(chrome.created).toEqual([]);
    host.close();
  });

  it('keeps a browser-stored entity in the browser database and a runtime entity in memory, both through the kernel', async () => {
    const stored: OrbitalSchema = {
      name: 'Mixed',
      orbitals: [
        {
          name: 'Notes',
          entity: { name: 'Note', persistence: 'persistent', local: true, fields: [{ name: 'id', type: 'string', required: true }, { name: 'title', type: 'string' }] },
          traits: [{
            name: 'Saver', linkedEntity: 'Note', category: 'interaction', scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'SAVE', name: 'Save' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'SAVE', effects: [['persist', 'create', 'Note', { id: 'n1', title: 'kept' }]] }],
            },
          }],
          pages: [],
        },
        {
          name: 'Clocks',
          entity: { name: 'Tally', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }, { name: 'n', type: 'number', default: 0 }] },
          traits: [{
            name: 'Counter', linkedEntity: 'Tally', category: 'interaction', scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'BUMP', name: 'Bump' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'BUMP', effects: [['set', '@entity.n', ['+', '@entity.n', 1]]] }],
            },
          }],
          pages: [],
        },
      ],
    };
    const databaseName = `kernel-mixed-${Math.random()}`;
    const host = await openBrowserHost({ databaseName, schema: stored, callService: async () => null, engine: 'kernel', kernel });
    expect((await host.send('Notes', { event: 'SAVE', targetTrait: 'Saver' })).success).toBe(true);
    expect((await host.send('Clocks', { event: 'BUMP', targetTrait: 'Counter' })).success).toBe(true);
    const reopened = await IndexedDbPersistence.open({ databaseName, entityTypes: ['Note'] });
    expect(await reopened.list('Note')).toMatchObject([{ id: 'n1', title: 'kept' }]);
    host.close();
  });

  it('a tick over a runtime entity with no rows runs once on the singleton frame, and the host passes no entity id', async () => {
    const ticking: OrbitalSchema = {
      name: 'Ticking',
      orbitals: [{
        name: 'Clock',
        entity: { name: 'Beat', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [{
          name: 'Pulse', linkedEntity: 'Beat', category: 'lifecycle', scope: 'instance',
          stateMachine: {
            states: [{ name: 'running', isInitial: true }],
            events: [{ key: 'INIT', name: 'Init' }, { key: 'PULSED', name: 'Pulsed' }],
            transitions: [{ from: 'running', to: 'running', event: 'INIT', effects: [] }, { from: 'running', to: 'running', event: 'PULSED', effects: [] }],
          },
          ticks: [{ name: 'beat', interval: 5000, effects: [['emit', 'PULSED']] }],
          emits: [{ event: 'PULSED' }],
        }],
        pages: [],
      }],
    };
    const host = await openBrowserHost({ databaseName: `kernel-tick-${Math.random()}`, schema: ticking, callService: async () => null, engine: 'kernel', kernel });
    const response = await host.send('Clock', { event: tickEventKey('beat'), runTick: { trait: 'Pulse', tick: 'beat' }, targetTrait: 'Pulse' });
    expect(response.emittedEvents.map((e) => e.event)).toEqual(['PULSED']);
    host.close();
  });

  const painter = (effects: Array<{ event: string; effects: unknown[][] }>): OrbitalSchema => ({
    name: 'Painter',
    orbitals: [{
      name: 'Board',
      entity: { name: 'Cell', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{
        name: 'Painter', linkedEntity: 'Cell', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }, { key: 'GO', name: 'Go' }],
          transitions: effects.map((arm) => ({ from: 'idle', to: 'idle', event: arm.event, effects: arm.effects })),
        },
        emits: [{ event: 'OUT' }],
      }],
      pages: [],
    }],
  });

  it('a step that does not fire repaints what the slot holds, not the render of the first arm that enters the state', async () => {
    const say = (content: string): unknown[] => ['render-ui', 'main', { type: 'typography', content }];
    const host = await openBrowserHost({
      databaseName: `kernel-paint-${Math.random()}`,
      schema: painter([{ event: 'INIT', effects: [say('first')] }, { event: 'GO', effects: [say('second')] }]),
      callService: async () => null,
      engine: 'kernel',
      kernel,
    });
    await host.send('Board', { event: 'INIT', targetTrait: 'Painter' });
    await host.send('Board', { event: 'GO', targetTrait: 'Painter' });
    const unfired = await host.send('Board', { event: 'NOPE', targetTrait: 'Painter' });
    expect(unfired.transitioned).toBe(false);
    expect(unfired.clientEffects).toEqual([say('second')]);
    host.close();
  });

  it('a list equals the empty list only when it is empty', async () => {
    const compare = (operator: string, left: unknown[]): unknown[] => ['emit', 'OUT', { v: [operator, left, ['list']] }];
    const host = await openBrowserHost({
      databaseName: `kernel-lists-${Math.random()}`,
      schema: painter([
        { event: 'INIT', effects: [compare('!=', ['list', 1, 2])] },
        { event: 'GO', effects: [compare('=', ['list'])] },
      ]),
      callService: async () => null,
      engine: 'kernel',
      kernel,
    });
    const nonEmpty = await host.send('Board', { event: 'INIT', targetTrait: 'Painter' });
    expect(nonEmpty.emittedEvents.find((e) => e.event === 'OUT')?.payload).toEqual({ v: true });
    const empty = await host.send('Board', { event: 'GO', targetTrait: 'Painter' });
    expect(empty.emittedEvents.find((e) => e.event === 'OUT')?.payload).toEqual({ v: true });
    host.close();
  });

  it('the kernel engine needs the kernel module', async () => {
    await expect(openBrowserHost({ databaseName: 'x', schema: program(), callService: async () => null, engine: 'kernel' })).rejects.toThrow(/kernel/);
  });
});
