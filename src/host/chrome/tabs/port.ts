/**
 * The browser-tab port over Chrome: the worker side (tabs, messages to and from content scripts) and the
 * content-script side (one executor over the page). Each takes the slice of the Chrome API it uses as a parameter,
 * so the extension passes `chrome.*` and tests pass fakes. Neither side decides anything: the kernel validates the
 * requests and shapes the results, this performs one raw tab or page operation per ask.
 */
import { TabHostFailure, type BrowserTabPort, type JsonValue, type TabAskContext, type TabUrlMatcher } from '@almadar/core';
import type { TabAsk, TabCommand, TabField } from '@almadar/core/kernel-wire';
import type { ChromeRuntimeApi, ChromeTabsApi } from './messages.js';

interface Watch {
  match: string;
  selector: string;
  fields: TabField[];
  deliver: TabAskContext['deliver'];
}

/** The worker side: tabs and messages to and from the content scripts, performing the kernel's raw asks. */
export function chromeTabPort(tabs: ChromeTabsApi, runtime: ChromeRuntimeApi, matches: TabUrlMatcher): BrowserTabPort {
  const watches = new Map<string, Watch>();
  /** Who is waiting on the next report from a tab's page script. */
  const readyWaiters = new Map<number, Array<() => void>>();

  async function send(tab: number, command: TabCommand): Promise<JsonValue> {
    // Chrome rejects a message to a tab whose page script is not running (not loaded yet, or a page outside the
    // extension's access); an undefined reply means the same.
    const reply = await tabs.sendMessage(tab, { almadarPage: 'command', command }).catch(() => undefined);
    if (reply === undefined) throw new TabHostFailure('not-ready', `Tab ${tab} has no page script`);
    if ('error' in reply) throw new TabHostFailure(reply.error.kind, reply.error.message);
    return reply.result;
  }

  /** Attach `watch` to a tab; a tab whose page script is not running yet is attached when it reports in. */
  async function attach(tab: number, watchId: string, watch: Watch): Promise<void> {
    try {
      await send(tab, { kind: 'watch', watchId, selector: watch.selector, fields: watch.fields });
    } catch (error) {
      if (!(error instanceof TabHostFailure) || error.kind !== 'not-ready') throw error;
    }
  }

  runtime.onMessage.addListener((message, sender) => {
    const tab = sender.tab?.id;
    if (tab === undefined) return;
    if (message.almadarPage === 'ready') {
      const waiting = readyWaiters.get(tab) ?? [];
      readyWaiters.delete(tab);
      for (const wake of waiting) wake();
      for (const [watchId, watch] of watches) {
        if (matches(watch.match, message.url)) void attach(tab, watchId, watch).catch(() => undefined);
      }
    } else if (message.almadarPage === 'element') {
      watches.get(message.watchId)?.deliver({ tab, elementId: message.element.elementId, url: message.url, fields: message.element.fields });
    }
  });

  async function awaitReady(tab: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<JsonValue> {
    const started = Date.now();
    const ready = await new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        readyWaiters.set(tab, (readyWaiters.get(tab) ?? []).filter((w) => w !== waiter));
        resolve(false);
      }, timeoutMs);
      readyWaiters.set(tab, [...(readyWaiters.get(tab) ?? []), waiter]);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        readyWaiters.set(tab, (readyWaiters.get(tab) ?? []).filter((w) => w !== waiter));
        resolve(false);
      });
    });
    return { ready, waitedMs: Date.now() - started };
  }

  return {
    async perform(ask: TabAsk, context: TabAskContext): Promise<JsonValue> {
      switch (ask.kind) {
        case 'list':
          return (await tabs.query({})).flatMap((t) =>
            t.id === undefined ? [] : [{ tab: t.id, url: t.url ?? '', title: t.title ?? '', active: t.active === true }],
          );
        case 'open': {
          const opened = await tabs.create({ url: ask.url, active: ask.active });
          if (opened.id === undefined) throw new TabHostFailure('failed', `Chrome did not open ${ask.url}`);
          return opened.id;
        }
        case 'close':
          await tabs.remove(ask.tab);
          return null;
        case 'navigate':
          await tabs.update(ask.tab, { url: ask.url });
          return null;
        case 'command':
          return send(ask.tab, ask.command);
        case 'awaitReady':
          return awaitReady(ask.tab, ask.timeoutMs, context.signal);
        case 'watch': {
          const known = watches.has(ask.watchId);
          const watch: Watch = { match: ask.match, selector: ask.selector, fields: ask.fields, deliver: context.deliver };
          watches.set(ask.watchId, watch);
          if (known) return null;
          for (const t of await tabs.query({})) {
            if (t.id !== undefined && matches(watch.match, t.url ?? '')) await attach(t.id, ask.watchId, watch);
          }
          return null;
        }
        case 'unwatch': {
          const stopped = watches.delete(ask.watchId);
          if (stopped) {
            for (const t of await tabs.query({})) {
              if (t.id !== undefined) await send(t.id, { kind: 'unwatch', watchId: ask.watchId }).catch(() => undefined);
            }
          }
          return stopped;
        }
      }
    },
  };
}
