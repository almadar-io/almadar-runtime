// @vitest-environment jsdom
/**
 * The browser-tab port over Chrome: the worker answers each raw ask the kernel makes (list, open, close, navigate,
 * a page command, wait for a page, watch, unwatch), and the content script answers the worker's commands through
 * the executor. Each is exercised against a fake of the Chrome surface it uses, so the real wiring is what runs.
 */
import { describe, it, expect } from 'vitest';
import { TabHostFailure, type EventPayload } from '@almadar/core';
import type { TabAsk, TabCommand, TabDelivery } from '@almadar/core/kernel-wire';
import { chromeTabPort, runPageContentScript, type ChromeRuntimeApi, type ChromeTabsApi, type PageMessage, type PageReply } from '../src/host/chrome/index.js';

type Listener = (message: PageMessage, sender: { tab?: { id?: number; url?: string } }, respond: (r: PageReply) => void) => boolean | void;

const DELIVER: TabDelivery = { orbital: 'Feed', trait: 'Watch', event: 'ITEM_SEEN' };

/** A match pattern as a pattern-string prefix test: enough for the fake; the kernel owns the real rule. */
const matches = (pattern: string, url: string): boolean => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url);

function fakeChrome(open: Array<{ id?: number; url: string; title?: string; active?: boolean }> = [{ id: 1, url: 'https://example.com/a', title: 'A', active: true }]) {
  const runtimeListeners: Listener[] = [];
  const sentToTabs: Array<{ tab: number; message: PageMessage }> = [];
  const sentToRuntime: PageMessage[] = [];
  const created: Array<{ url: string; active: boolean }> = [];
  const removed: number[] = [];
  const updated: Array<{ tab: number; url?: string; active?: boolean }> = [];
  const captured: Array<{ windowId: number; options: { format: 'png' | 'jpeg'; quality?: number } }> = [];
  const state = { reply: { result: true } as PageReply | undefined, createdId: 42 as number | undefined, failSend: false, windowId: 7 as number | undefined, refuseCapture: false };
  const tabs: ChromeTabsApi = {
    query: async () => open,
    create: async (props) => {
      created.push(props);
      return { ...(state.createdId !== undefined ? { id: state.createdId } : {}), url: props.url, active: props.active };
    },
    remove: async (tab) => {
      removed.push(tab);
    },
    update: async (tab, props) => {
      updated.push({ tab, ...props });
      return { id: tab, ...(state.windowId !== undefined ? { windowId: state.windowId } : {}) };
    },
    captureVisibleTab: async (windowId, options) => {
      captured.push({ windowId, options });
      if (state.refuseCapture) throw new Error('Cannot access contents of url "chrome://settings/".');
      return `data:image/${options.format};base64,AAAA`;
    },
    sendMessage: async (tab, message) => {
      sentToTabs.push({ tab, message });
      if (state.failSend) throw new Error('Could not establish connection. Receiving end does not exist.');
      return state.reply;
    },
  };
  const runtime: ChromeRuntimeApi = {
    sendMessage: async (message) => {
      sentToRuntime.push(message);
      return undefined;
    },
    onMessage: { addListener: (l) => runtimeListeners.push(l) },
  };
  const fromTab = (tab: number, url: string, message: PageMessage) => runtimeListeners.forEach((l) => l(message, { tab: { id: tab, url } }, () => undefined));
  return { tabs, runtime, sentToTabs, sentToRuntime, created, removed, updated, captured, state, runtimeListeners, fromTab };
}

function port(c = fakeChrome()) {
  const delivered: EventPayload[] = [];
  const context = { deliver: (payload: EventPayload) => void delivered.push(payload) };
  return { c, delivered, context, port: chromeTabPort(c.tabs, c.runtime, matches) };
}

const watchAsk = (id = 'w-1', match = 'https://example.com/*'): TabAsk => ({ kind: 'watch', watchId: id, match, selector: '.item', fields: [{ name: 'title', selector: 'h2' }], deliver: DELIVER });
const sentWatches = (c: ReturnType<typeof fakeChrome>) => c.sentToTabs.filter((s) => s.message.almadarPage === 'command' && s.message.command.kind === 'watch');

describe('chromeTabPort answers the raw tab asks', () => {
  it('list: every tab Chrome reports, with its url, title and focus, and none without an id', async () => {
    const t = port(fakeChrome([{ id: 1, url: 'https://example.com/a', title: 'A', active: true }, { url: 'https://nowhere.test/' }, { id: 3, url: 'https://b.test/' }]));
    expect(await t.port.perform({ kind: 'list' }, t.context)).toEqual([
      { tab: 1, url: 'https://example.com/a', title: 'A', active: true },
      { tab: 3, url: 'https://b.test/', title: '', active: false },
    ]);
  });

  it('open: creates the tab as asked and answers its number', async () => {
    const t = port();
    expect(await t.port.perform({ kind: 'open', url: 'https://example.com/r?q=a', active: false }, t.context)).toBe(42);
    expect(t.c.created).toEqual([{ url: 'https://example.com/r?q=a', active: false }]);
  });

  it('open: a tab Chrome gave no id is a failure, not a number', async () => {
    const t = port();
    t.c.state.createdId = undefined;
    await expect(t.port.perform({ kind: 'open', url: 'https://example.com/', active: true }, t.context)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('close and navigate: do it and answer nothing', async () => {
    const t = port();
    expect(await t.port.perform({ kind: 'close', tab: 7 }, t.context)).toBeNull();
    expect(await t.port.perform({ kind: 'navigate', tab: 7, url: 'https://example.com/next' }, t.context)).toBeNull();
    expect(t.c.removed).toEqual([7]);
    expect(t.c.updated).toEqual([{ tab: 7, url: 'https://example.com/next' }]);
  });

  it('capture: brings the tab to the front of its window and answers that window as a data URL', async () => {
    const t = port();
    expect(await t.port.perform({ kind: 'capture', tab: 3, format: 'jpeg', quality: 60 }, t.context)).toBe('data:image/jpeg;base64,AAAA');
    expect(t.c.updated).toEqual([{ tab: 3, active: true }]);
    expect(t.c.captured).toEqual([{ windowId: 7, options: { format: 'jpeg', quality: 60 } }]);
    await t.port.perform({ kind: 'capture', tab: 3, format: 'png' }, t.context);
    expect(t.c.captured[1]).toEqual({ windowId: 7, options: { format: 'png' } });
  });

  it('control: a page Chrome will not capture is not-ready, and a tab in no window is a failure', async () => {
    const refused = port();
    refused.c.state.refuseCapture = true;
    await expect(refused.port.perform({ kind: 'capture', tab: 3, format: 'png' }, refused.context)).rejects.toMatchObject({ kind: 'not-ready' });
    const lost = port();
    lost.c.state.windowId = undefined;
    await expect(lost.port.perform({ kind: 'capture', tab: 3, format: 'png' }, lost.context)).rejects.toMatchObject({ kind: 'failed' });
    expect(lost.c.captured).toEqual([]);
  });

  it('a Chrome error on a tab propagates for the host to report as a failure', async () => {
    const t = port();
    t.c.tabs.remove = async () => {
      throw new Error('No tab with id: 404');
    };
    await expect(t.port.perform({ kind: 'close', tab: 404 }, t.context)).rejects.toThrow('No tab with id: 404');
  });

  it('command: forwards it to the tab content script and answers its result', async () => {
    const t = port();
    const command: TabCommand = { kind: 'unwatch', watchId: 'w-1' };
    expect(await t.port.perform({ kind: 'command', tab: 1, command }, t.context)).toBe(true);
    expect(t.c.sentToTabs).toEqual([{ tab: 1, message: { almadarPage: 'command', command } }]);
  });

  it('command: a tab Chrome cannot message (no page script yet) is not-ready', async () => {
    const t = port();
    t.c.state.failSend = true;
    await expect(t.port.perform({ kind: 'command', tab: 3, command: { kind: 'unwatch', watchId: 'w-1' } }, t.context)).rejects.toMatchObject({ kind: 'not-ready' });
  });

  it('command: an empty reply is not-ready too', async () => {
    const t = port();
    t.c.state.reply = undefined;
    await expect(t.port.perform({ kind: 'command', tab: 3, command: { kind: 'unwatch', watchId: 'w-1' } }, t.context)).rejects.toBeInstanceOf(TabHostFailure);
  });

  it('control: an error from the page keeps the kind the page gave it', async () => {
    const t = port();
    t.c.state.reply = { error: { kind: 'not-found', message: 'No page element el-9' } };
    await expect(t.port.perform({ kind: 'command', tab: 3, command: { kind: 'unwatch', watchId: 'w-1' } }, t.context)).rejects.toMatchObject({ kind: 'not-found', message: 'No page element el-9' });
  });
});

describe('awaitReady', () => {
  it('answers ready and how long it waited when the tab page script reports in', async () => {
    const t = port();
    const pending = t.port.perform({ kind: 'awaitReady', tab: 4, timeoutMs: 1000 }, t.context);
    setTimeout(() => t.c.fromTab(4, 'https://example.com/results', { almadarPage: 'ready', url: 'https://example.com/results' }), 20);
    expect(await pending).toEqual({ ready: true, waitedMs: expect.any(Number) });
  });

  it('edge: a page that never reports in is not ready after the timeout', async () => {
    const t = port();
    expect(await t.port.perform({ kind: 'awaitReady', tab: 4, timeoutMs: 30 }, t.context)).toMatchObject({ ready: false });
  });

  it('control: another tab reporting in does not wake the wait', async () => {
    const t = port();
    const pending = t.port.perform({ kind: 'awaitReady', tab: 4, timeoutMs: 60 }, t.context);
    t.c.fromTab(5, 'https://example.com/x', { almadarPage: 'ready', url: 'https://example.com/x' });
    expect(await pending).toMatchObject({ ready: false });
  });

  it('an aborted ask stops waiting at once', async () => {
    const t = port();
    const abort = new AbortController();
    const pending = t.port.perform({ kind: 'awaitReady', tab: 4, timeoutMs: 5000 }, { ...t.context, signal: abort.signal });
    abort.abort();
    expect(await pending).toMatchObject({ ready: false });
  });
});

describe('watch and unwatch', () => {
  it('attaches to the matching open tabs now and to matching tabs that load later', async () => {
    const t = port(fakeChrome([{ id: 1, url: 'https://example.com/home' }, { id: 2, url: 'https://other.test/' }]));
    expect(await t.port.perform(watchAsk(), t.context)).toBeNull();
    expect(sentWatches(t.c).map((s) => s.tab)).toEqual([1]);
    t.c.fromTab(3, 'https://example.com/later', { almadarPage: 'ready', url: 'https://example.com/later' });
    t.c.fromTab(4, 'https://other.test/x', { almadarPage: 'ready', url: 'https://other.test/x' });
    await Promise.resolve();
    expect(sentWatches(t.c).map((s) => s.tab)).toEqual([1, 3]);
    expect(sentWatches(t.c)[0].message).toEqual({
      almadarPage: 'command',
      command: { kind: 'watch', watchId: 'w-1', selector: '.item', fields: [{ name: 'title', selector: 'h2' }] },
    });
  });

  it('a reported element is delivered with the sending tab to the program', async () => {
    const t = port(fakeChrome([]));
    await t.port.perform(watchAsk(), t.context);
    t.c.fromTab(1, 'https://example.com/home', { almadarPage: 'element', watchId: 'w-1', element: { elementId: 'el-5', fields: { title: 'Hello' } }, url: 'https://example.com/home' });
    expect(t.delivered).toEqual([{ tab: 1, elementId: 'el-5', url: 'https://example.com/home', fields: { title: 'Hello' } }]);
  });

  it('control: an element reported for a watch nobody kept is dropped', async () => {
    const t = port(fakeChrome([]));
    t.c.fromTab(1, 'https://example.com/home', { almadarPage: 'element', watchId: 'w-9', element: { elementId: 'el-5', fields: {} }, url: 'https://example.com/home' });
    expect(t.delivered).toEqual([]);
  });

  it('asking for the same watch again attaches nothing twice and delivers to the latest asker', async () => {
    const t = port(fakeChrome([{ id: 1, url: 'https://example.com/home' }]));
    await t.port.perform(watchAsk(), t.context);
    const later: EventPayload[] = [];
    await t.port.perform(watchAsk(), { deliver: (payload) => void later.push(payload) });
    expect(sentWatches(t.c)).toHaveLength(1);
    t.c.fromTab(1, 'https://example.com/home', { almadarPage: 'element', watchId: 'w-1', element: { elementId: 'el-1', fields: {} }, url: 'https://example.com/home' });
    expect(t.delivered).toEqual([]);
    expect(later).toHaveLength(1);
  });

  it('a matching tab with no page script yet does not fail the watch: it attaches when the script reports in', async () => {
    const t = port(fakeChrome([{ id: 1, url: 'https://example.com/home' }]));
    t.c.state.failSend = true;
    await expect(t.port.perform(watchAsk(), t.context)).resolves.toBeNull();
    t.c.state.failSend = false;
    t.c.fromTab(1, 'https://example.com/home', { almadarPage: 'ready', url: 'https://example.com/home' });
    await Promise.resolve();
    expect(sentWatches(t.c)).toHaveLength(2);
  });

  it('unwatch: answers whether the watch was kept, tells the tabs, and stops reports and attachments', async () => {
    const t = port(fakeChrome([{ id: 1, url: 'https://example.com/home' }]));
    await t.port.perform(watchAsk(), t.context);
    expect(await t.port.perform({ kind: 'unwatch', watchId: 'w-1' }, t.context)).toBe(true);
    expect(t.c.sentToTabs.some((s) => s.message.almadarPage === 'command' && s.message.command.kind === 'unwatch')).toBe(true);
    t.c.fromTab(5, 'https://example.com/x', { almadarPage: 'ready', url: 'https://example.com/x' });
    t.c.fromTab(5, 'https://example.com/x', { almadarPage: 'element', watchId: 'w-1', element: { elementId: 'el-1', fields: {} }, url: 'https://example.com/x' });
    await Promise.resolve();
    expect(t.delivered).toEqual([]);
    expect(sentWatches(t.c)).toHaveLength(1);
  });

  it('control: unwatching a watch nobody kept answers false and sends nothing', async () => {
    const t = port();
    expect(await t.port.perform({ kind: 'unwatch', watchId: 'never' }, t.context)).toBe(false);
    expect(t.c.sentToTabs).toEqual([]);
  });

  it('control: messages that are not page messages from a tab are ignored', async () => {
    const t = port(fakeChrome([]));
    await t.port.perform(watchAsk(), t.context);
    t.c.runtimeListeners.forEach((l) => l({ almadarPage: 'element', watchId: 'w-1', element: { elementId: 'el-1', fields: {} }, url: 'x' }, {}, () => undefined));
    expect(t.delivered).toEqual([]);
  });
});

describe('runPageContentScript', () => {
  it('announces the page, answers commands through the executor, and reports watched elements', async () => {
    document.body.innerHTML = '<ul><li class="i">One</li></ul>';
    const c = fakeChrome();
    runPageContentScript(c.runtime, document, 'https://example.com/list');
    expect(c.sentToRuntime[0]).toEqual({ almadarPage: 'ready', url: 'https://example.com/list' });

    const answers: PageReply[] = [];
    const deliver = (message: PageMessage) => c.runtimeListeners.forEach((l) => l(message, {}, (r) => answers.push(r)));
    deliver({ almadarPage: 'command', command: { kind: 'query', selector: '.i', fields: [{ name: 't' }] } });
    await Promise.resolve();
    expect(answers[0]).toEqual({ result: [{ elementId: 'el-1', fields: { t: 'One' } }] });

    deliver({ almadarPage: 'command', command: { kind: 'watch', watchId: 'w-1', selector: '.i', fields: [{ name: 't' }] } });
    await Promise.resolve();
    expect(answers[1]).toEqual({ result: null });
    expect(c.sentToRuntime).toContainEqual({ almadarPage: 'element', watchId: 'w-1', element: { elementId: 'el-1', fields: { t: 'One' } }, url: 'https://example.com/list' });

    deliver({ almadarPage: 'command', command: { kind: 'unwatch', watchId: 'w-1' } });
    await Promise.resolve();
    expect(answers[2]).toEqual({ result: true });
  });

  it('a query that may wait keeps the channel open and answers once a match appears', async () => {
    document.body.innerHTML = '';
    const c = fakeChrome();
    runPageContentScript(c.runtime, document, 'https://example.com/results');
    const answers: PageReply[] = [];
    const kept = c.runtimeListeners.map((l) =>
      l({ almadarPage: 'command', command: { kind: 'query', selector: '.r', fields: [{ name: 't' }], waitMs: 1000 } }, {}, (r) => answers.push(r)));
    expect(kept).toEqual([true]);
    setTimeout(() => {
      document.body.innerHTML = '<p class="r">Late result</p>';
    }, 20);
    await new Promise((r) => setTimeout(r, 80));
    expect(answers).toEqual([{ result: [{ elementId: 'el-1', fields: { t: 'Late result' } }] }]);
  });

  it('answers applyMany with what was applied and what is missing, and act with true', async () => {
    document.body.innerHTML = '<p class="r">x</p><input id="q" />';
    const c = fakeChrome();
    runPageContentScript(c.runtime, document, 'https://example.com/');
    const answers: PageReply[] = [];
    const deliver = (command: TabCommand) => c.runtimeListeners.forEach((l) => l({ almadarPage: 'command', command }, {}, (r) => answers.push(r)));
    deliver({ kind: 'query', selector: '.r', fields: [] });
    deliver({ kind: 'query', selector: '#q', fields: [] });
    await Promise.resolve();
    deliver({ kind: 'applyMany', items: [{ elementId: 'el-1', styles: [{ property: 'display', value: 'none' }] }, { elementId: 'el-99', styles: [] }] });
    deliver({ kind: 'act', elementId: 'el-2', action: 'type', text: 'hello' });
    await Promise.resolve();
    expect(answers[2]).toEqual({ result: { applied: ['el-1'], missing: ['el-99'] } });
    expect(answers[3]).toEqual({ result: true });
    expect(document.querySelector<HTMLElement>('.r')?.style.display).toBe('none');
  });

  it('answers an executor failure with its kind instead of throwing in the page', async () => {
    document.body.innerHTML = '';
    const c = fakeChrome();
    runPageContentScript(c.runtime, document, 'https://example.com/');
    const answers: PageReply[] = [];
    c.runtimeListeners.forEach((l) => l({ almadarPage: 'command', command: { kind: 'apply', elementId: 'el-404', styles: [] } }, {}, (r) => answers.push(r)));
    await Promise.resolve();
    expect(answers[0]).toEqual({ error: { kind: 'not-found', message: 'No page element el-404' } });
  });

  it('control: a worker message that is not a command is not answered', () => {
    const c = fakeChrome();
    runPageContentScript(c.runtime, document, 'https://example.com/');
    expect(c.runtimeListeners.map((l) => l({ almadarPage: 'ready', url: 'x' }, {}, () => undefined))).toEqual([undefined]);
  });
});
