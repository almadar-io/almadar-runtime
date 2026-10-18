/**
 * The content-script half of the browser-tab port: a generic executor over one document. Elements are addressed by
 * ids it issues. It performs the raw commands the kernel sends (read, watch, style, interact) and decides nothing:
 * which styles a treatment comes to, which fields to read and which interactions exist are the kernel's. It never
 * evaluates code and knows no site.
 */
import type { TabAction, TabApply, TabField, TabFailureKind } from '@almadar/core/kernel-wire';
import { fillTemplate } from './template.js';

/** One element the page reports: the id this executor issued and the fields read from it. */
export type TabElement = { elementId: string; fields: Record<string, string> };

/** A command the page could not perform, with the kernel's closed reason. */
export class PageCommandError extends Error {
  constructor(
    readonly kind: TabFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'PageCommandError';
  }
}

export interface PageExecutor {
  query(selector: string, fields: readonly TabField[], limit?: number): TabElement[];
  /** `query`, once a first ready match is present or `waitMs` has passed (then whatever matches, possibly none). */
  queryWhenPresent(selector: string, fields: readonly TabField[], limit: number | undefined, waitMs: number): Promise<TabElement[]>;
  watch(watchId: string, selector: string, fields: readonly TabField[], onElement: (element: TabElement) => void): void;
  unwatch(watchId: string): boolean;
  /** Replace the element's previous treatment with these styles and label; neither restores it. */
  apply(treatment: TabApply): void;
  /** `apply` for each item; an element that has left the page is listed in `missing` instead of failing the rest. */
  applyMany(items: readonly TabApply[]): { applied: string[]; missing: string[] };
  act(elementId: string, action: TabAction, text?: string): void;
}

const LABEL_ATTR = 'data-almadar-page-label';

/** New matches arrive as children; a placeholder awaiting a required field may fill in by text or attributes too. */
function observed(fields: readonly TabField[]): MutationObserverInit {
  const awaits = fields.some((f) => f.required === true);
  return { childList: true, subtree: true, characterData: awaits, attributes: awaits };
}

interface Applied {
  styles: Array<{ property: string; value: string; priority: string }>;
  label: HTMLElement | null;
}

function windowOf(doc: Document): Window & typeof globalThis {
  const view = doc.defaultView;
  if (!view) throw new PageCommandError('invalid', 'The page executor needs a document attached to a window');
  return view;
}

export function createPageExecutor(doc: Document): PageExecutor {
  const view = windowOf(doc);
  const ids = new WeakMap<Element, string>();
  const byId = new Map<string, WeakRef<Element>>();
  const applied = new WeakMap<Element, Applied>();
  const watches = new Map<string, { observer: MutationObserver; seen: WeakSet<Element> }>();
  // What each watch has reported, kept across unwatch/re-watch: the page outlives a restarted worker,
  // and a watch id names the same watch every time it is attached.
  const reported = new Map<string, WeakSet<Element>>();
  let nextId = 1;

  function idOf(el: Element): string {
    const known = ids.get(el);
    if (known !== undefined) return known;
    const id = `el-${nextId++}`;
    ids.set(el, id);
    byId.set(id, new WeakRef(el));
    return id;
  }

  function elementOf(elementId: string): Element {
    const el = byId.get(elementId)?.deref();
    if (!el || !el.isConnected) throw new PageCommandError('not-found', `No page element ${elementId}`);
    return el;
  }

  function read(el: Element, fields: readonly TabField[]): TabElement {
    const out: Record<string, string> = {};
    const asUrl = (spec: TabField, value: string) => (spec.resolve === true && value !== '' ? new URL(value, doc.baseURI).toString() : value);
    for (const spec of fields) {
      if (spec.template != null) continue;
      const target = spec.selector != null ? el.querySelector(spec.selector) : el;
      if (!target) out[spec.name] = '';
      else if (spec.attr != null) out[spec.name] = asUrl(spec, target.getAttribute(spec.attr) ?? '');
      else out[spec.name] = asUrl(spec, (target.textContent ?? '').trim());
    }
    const readValues = { ...out };
    for (const spec of fields) {
      if (spec.template != null) out[spec.name] = asUrl(spec, fillTemplate(spec.template, readValues));
    }
    return { elementId: idOf(el), fields: out };
  }

  function ready(element: TabElement, fields: readonly TabField[]): boolean {
    return fields.every((spec) => spec.required !== true || element.fields[spec.name] !== '');
  }

  function readReady(el: Element, fields: readonly TabField[]): TabElement | undefined {
    const element = read(el, fields);
    return ready(element, fields) ? element : undefined;
  }

  function styled(el: Element): HTMLElement {
    if (!(el instanceof view.HTMLElement)) {
      throw new PageCommandError('invalid', `Page element ${idOf(el)} cannot be styled`);
    }
    return el;
  }

  function restore(el: HTMLElement): void {
    const prev = applied.get(el);
    if (!prev) return;
    for (const { property, value, priority } of prev.styles) el.style.setProperty(property, value, priority);
    prev.label?.remove();
    applied.delete(el);
  }

  return {
    query(selector, fields, limit) {
      const all = Array.from(doc.querySelectorAll(selector)).flatMap((el) => readReady(el, fields) ?? []);
      return limit !== undefined ? all.slice(0, limit) : all;
    },

    queryWhenPresent(selector, fields, limit, waitMs) {
      const readAll = () => this.query(selector, fields, limit);
      const present = () => readAll().length > 0;
      if (present()) return Promise.resolve(readAll());
      return new Promise((resolve) => {
        const done = () => {
          observer.disconnect();
          view.clearTimeout(timer);
          resolve(readAll());
        };
        const observer = new view.MutationObserver(() => {
          if (present()) done();
        });
        observer.observe(doc.body, observed(fields));
        const timer = view.setTimeout(done, waitMs);
      });
    },

    watch(watchId, selector, fields, onElement) {
      this.unwatch(watchId);
      const seen = reported.get(watchId) ?? new WeakSet<Element>();
      reported.set(watchId, seen);
      const report = () => {
        for (const el of Array.from(doc.querySelectorAll(selector))) {
          if (seen.has(el)) continue;
          const element = readReady(el, fields);
          if (element === undefined) continue;
          seen.add(el);
          onElement(element);
        }
      };
      const observer = new view.MutationObserver(report);
      observer.observe(doc.body, observed(fields));
      watches.set(watchId, { observer, seen });
      report();
    },

    unwatch(watchId) {
      const w = watches.get(watchId);
      if (!w) return false;
      w.observer.disconnect();
      watches.delete(watchId);
      return true;
    },

    apply({ elementId, styles, label }) {
      const el = styled(elementOf(elementId));
      restore(el);
      if (styles.length === 0 && label == null) return;
      const prev: Applied = {
        styles: styles.map(({ property }) => ({ property, value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) })),
        label: null,
      };
      for (const { property, value } of styles) el.style.setProperty(property, value);
      if (label != null) {
        const tag = doc.createElement('div');
        tag.setAttribute(LABEL_ATTR, '');
        tag.textContent = label;
        el.prepend(tag);
        prev.label = tag;
      }
      applied.set(el, prev);
    },

    applyMany(items) {
      const done: string[] = [];
      const missing: string[] = [];
      for (const item of items) {
        try {
          this.apply(item);
          done.push(item.elementId);
        } catch (err) {
          if (!(err instanceof PageCommandError) || err.kind !== 'not-found') throw err;
          missing.push(item.elementId);
        }
      }
      return { applied: done, missing };
    },

    act(elementId, action, text) {
      const el = elementOf(elementId);
      if (action === 'click') {
        if (el instanceof view.HTMLElement) el.click();
        else el.dispatchEvent(new view.MouseEvent('click', { bubbles: true }));
        return;
      }
      if (action === 'focus') {
        styled(el).focus();
        return;
      }
      if (text === undefined) throw new PageCommandError('invalid', 'act "type" needs text');
      if (!(el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement)) {
        throw new PageCommandError('invalid', `Page element ${elementId} does not accept text`);
      }
      // Set through the prototype setter so frameworks that track the native value see the change.
      const proto = el instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
      el.dispatchEvent(new view.Event('input', { bubbles: true }));
      el.dispatchEvent(new view.Event('change', { bubbles: true }));
    },
  };
}
