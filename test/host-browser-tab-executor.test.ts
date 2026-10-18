// @vitest-environment jsdom
/**
 * The content-script half of the browser-tab port: a generic executor over one document. It reads elements by
 * selector, reports new ones as the page changes, applies the styles and label the kernel hands it and performs
 * interactions. It knows no site and decides no treatment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TabApply, TabField } from '@almadar/core/kernel-wire';
import { createPageExecutor, PageCommandError, type PageExecutor, type TabElement } from '../src/host/chrome/tabs/executor.js';

const ITEM = (id: string, title: string) =>
  `<article class="item" data-key="${id}"><a class="link" href="/watch/${id}"><h3 class="title">${title}</h3></a><span class="by">Ann</span></article>`;

/** The fields of a read, in declared order. */
const reads = (specs: Record<string, Omit<TabField, 'name'>>): TabField[] => Object.entries(specs).map(([name, spec]) => ({ name, ...spec }));

let exec: PageExecutor;

beforeEach(() => {
  document.body.innerHTML = `<main id="list">${ITEM('a', 'First')}${ITEM('b', 'Second')}</main><input id="q" />`;
  exec = createPageExecutor(document);
});

const fields = reads({ title: { selector: '.title' }, key: { attr: 'data-key' }, href: { selector: '.link', attr: 'href' }, by: { selector: '.by' } });
const titleOnly = reads({ title: { selector: '.title' } });

describe('query', () => {
  it('reads the requested fields of every match', () => {
    const els = exec.query('.item', fields);
    expect(els.map((e) => e.fields)).toEqual([
      { title: 'First', key: 'a', href: '/watch/a', by: 'Ann' },
      { title: 'Second', key: 'b', href: '/watch/b', by: 'Ann' },
    ]);
  });

  it('gives an element the same id every time it is read', () => {
    const first = exec.query('.item', fields).map((e) => e.elementId);
    const again = exec.query('.item', fields).map((e) => e.elementId);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(2);
  });

  it('a field marked resolve reads its attribute as a URL resolved against the page', () => {
    const [el] = exec.query('.item', reads({ href: { selector: '.link', attr: 'href', resolve: true } }));
    expect(el.fields.href).toBe(new URL('/watch/a', document.baseURI).toString());
  });

  it('control: without resolve the attribute comes back as written', () => {
    expect(exec.query('.item', reads({ href: { selector: '.link', attr: 'href' } }))[0].fields.href).toBe('/watch/a');
  });

  it('edge: resolve on an empty attribute stays empty', () => {
    expect(exec.query('.item', reads({ gone: { attr: 'data-absent', resolve: true } }))[0].fields.gone).toBe('');
  });

  it('honors limit', () => {
    expect(exec.query('.item', fields, 1)).toHaveLength(1);
  });

  it('edge: a missing descendant or attribute reads as an empty string', () => {
    const [el] = exec.query('.item', reads({ nope: { selector: '.absent' }, gone: { attr: 'data-absent' } }));
    expect(el.fields).toEqual({ nope: '', gone: '' });
  });

  it('control: a selector that matches nothing returns no elements', () => {
    expect(exec.query('.absent', fields)).toEqual([]);
  });
});

describe('queryWhenPresent', () => {
  it('waits for the first match to appear, then reads every match', async () => {
    const pending = exec.queryWhenPresent('.late', titleOnly, undefined, 1000);
    setTimeout(() => {
      const el = document.createElement('article');
      el.className = 'late';
      el.innerHTML = '<h3 class="title">Arrived</h3>';
      document.body.append(el);
    }, 20);
    expect((await pending).map((e) => e.fields.title)).toEqual(['Arrived']);
  });

  it('control: matches already present come back at once', async () => {
    const started = Date.now();
    expect(await exec.queryWhenPresent('.item', fields, undefined, 5000)).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('edge: nothing appearing within the wait returns no elements, not an error', async () => {
    expect(await exec.queryWhenPresent('.never', fields, undefined, 30)).toEqual([]);
  });
});

describe('watch', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reports existing matches, then each new one once', async () => {
    const seen: TabElement[] = [];
    exec.watch('w1', '.item', titleOnly, (el) => seen.push(el));
    expect(seen.map((e) => e.fields.title)).toEqual(['First', 'Second']);
    document.getElementById('list')?.insertAdjacentHTML('beforeend', ITEM('c', 'Third'));
    await flush();
    document.getElementById('list')?.insertAdjacentHTML('beforeend', '<div class="noise"></div>');
    await flush();
    expect(seen.map((e) => e.fields.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('stops after unwatch', async () => {
    const seen: TabElement[] = [];
    exec.watch('w2', '.item', fields, (el) => seen.push(el));
    expect(exec.unwatch('w2')).toBe(true);
    document.getElementById('list')?.insertAdjacentHTML('beforeend', ITEM('d', 'Fourth'));
    await flush();
    expect(seen).toHaveLength(2);
  });

  it('the same watch attached again (a restarted worker re-attaching it) reports nothing it already reported', async () => {
    const seen: TabElement[] = [];
    exec.watch('w-1', '.item', titleOnly, (el) => seen.push(el));
    exec.watch('w-1', '.item', titleOnly, (el) => seen.push(el));
    document.getElementById('list')?.insertAdjacentHTML('beforeend', ITEM('c', 'Third'));
    await flush();
    expect(seen.map((e) => e.fields.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('edge: after an unwatch, watching again under the same id still reports only new elements', async () => {
    const seen: TabElement[] = [];
    exec.watch('w-1', '.item', titleOnly, (el) => seen.push(el));
    exec.unwatch('w-1');
    exec.watch('w-1', '.item', titleOnly, (el) => seen.push(el));
    expect(seen).toHaveLength(2);
  });

  it('control: a different watch over the same elements reports each of them to its own listener', () => {
    const first: TabElement[] = [];
    const second: TabElement[] = [];
    exec.watch('w-1', '.item', titleOnly, (el) => first.push(el));
    exec.watch('w-2', '.item', titleOnly, (el) => second.push(el));
    expect([first.length, second.length]).toEqual([2, 2]);
  });

  it('control: unwatching an unknown watch reports false', () => {
    expect(exec.unwatch('never')).toBe(false);
  });
});


describe('applyMany', () => {
  const hide: TabApply['styles'] = [{ property: 'display', value: 'none' }];
  const blur: TabApply['styles'] = [{ property: 'filter', value: 'blur(8px)' }];

  it('applies every treatment it can, and lists the elements that have left the page', () => {
    const [a, b] = exec.query('.item', fields).map((e) => e.elementId);
    document.querySelectorAll('.item')[1]?.remove();
    const result = exec.applyMany([
      { elementId: a, styles: hide },
      { elementId: b, styles: blur },
      { elementId: 'el-999', styles: blur },
    ]);
    expect(result).toEqual({ applied: [a], missing: [b, 'el-999'] });
    expect(document.querySelector<HTMLElement>('.item')?.style.display).toBe('none');
  });

  it('control: when every element is present nothing is missing, and an empty treatment undoes the previous one', () => {
    const [a] = exec.query('.item', fields).map((e) => e.elementId);
    exec.applyMany([{ elementId: a, styles: blur, label: 'Not now' }]);
    expect(exec.applyMany([{ elementId: a, styles: [] }])).toEqual({ applied: [a], missing: [] });
    expect(document.querySelector<HTMLElement>('.item')?.style.filter).toBe('');
  });

  it('edge: an element that cannot be styled fails the batch instead of being called missing', () => {
    document.body.insertAdjacentHTML('beforeend', '<svg><circle class="dot"></circle></svg>');
    const [dot] = exec.query('.dot', []).map((e) => e.elementId);
    expect(() => exec.applyMany([{ elementId: dot, styles: hide }])).toThrowError(PageCommandError);
  });
});

describe('apply', () => {
  const firstItem = () => document.querySelector<HTMLElement>('.item');

  it('sets the styles it is handed and restores the element keeping its own styles', () => {
    const el = firstItem();
    el?.style.setProperty('display', 'grid');
    const [{ elementId }] = exec.query('.item', fields);
    exec.apply({ elementId, styles: [{ property: 'display', value: 'none' }] });
    expect(el?.style.display).toBe('none');
    exec.apply({ elementId, styles: [] });
    expect(el?.style.display).toBe('grid');
  });

  it('a new treatment replaces the previous one', () => {
    const [{ elementId }] = exec.query('.item', fields);
    exec.apply({ elementId, styles: [{ property: 'display', value: 'none' }] });
    exec.apply({ elementId, styles: [{ property: 'filter', value: 'blur(8px)' }] });
    expect(firstItem()?.style.display).toBe('');
    expect(firstItem()?.style.filter).toContain('blur');
  });

  it('a label shows its text and the next apply removes it', () => {
    const [{ elementId }] = exec.query('.item', fields);
    exec.apply({ elementId, styles: [], label: 'Not now: conflict news' });
    expect(firstItem()?.querySelector('[data-almadar-page-label]')?.textContent).toBe('Not now: conflict news');
    exec.apply({ elementId, styles: [] });
    expect(firstItem()?.querySelector('[data-almadar-page-label]')).toBeNull();
  });

  it('an empty label is still shown, as the kernel asks for it', () => {
    const [{ elementId }] = exec.query('.item', fields);
    exec.apply({ elementId, styles: [], label: '' });
    expect(firstItem()?.querySelector('[data-almadar-page-label]')).not.toBeNull();
  });

  it('an element id it never issued is not-found', () => {
    expect(() => exec.apply({ elementId: 'el-404', styles: [] })).toThrowError(PageCommandError);
    try {
      exec.apply({ elementId: 'el-404', styles: [] });
    } catch (err) {
      expect(err instanceof PageCommandError && err.kind).toBe('not-found');
    }
  });
});

describe('act', () => {
  it('types into an input and fires input and change', () => {
    const events: string[] = [];
    const input = document.getElementById('q');
    input?.addEventListener('input', () => events.push('input'));
    input?.addEventListener('change', () => events.push('change'));
    const [{ elementId }] = exec.query('#q', []);
    exec.act(elementId, 'type', 'calm piano');
    expect(input instanceof HTMLInputElement && input.value).toBe('calm piano');
    expect(events).toEqual(['input', 'change']);
  });

  it('clicks an element', () => {
    let clicks = 0;
    document.querySelector('.link')?.addEventListener('click', (e) => {
      e.preventDefault();
      clicks += 1;
    });
    const [{ elementId }] = exec.query('.link', []);
    exec.act(elementId, 'click');
    expect(clicks).toBe(1);
  });

  it('edge: typing requires text, and only an input takes it', () => {
    const [{ elementId }] = exec.query('#q', []);
    expect(() => exec.act(elementId, 'type')).toThrowError(PageCommandError);
    const [link] = exec.query('.link', []);
    expect(() => exec.act(link.elementId, 'type', 'x')).toThrowError(PageCommandError);
  });
});

describe('the executor is generic substrate', () => {
  it('names no site, platform or domain noun', () => {
    const src = readFileSync(resolve(__dirname, '../src/host/chrome/tabs/executor.ts'), 'utf8').toLowerCase();
    for (const word of ['youtube', 'tiktok', 'feed', 'video', 'tile', 'channel']) expect(src, word).not.toContain(word);
  });

  it('decides no treatment: it names none of the kernel\'s treatment words or styles', () => {
    const src = readFileSync(resolve(__dirname, '../src/host/chrome/tabs/executor.ts'), 'utf8');
    for (const word of ['blur(', "'hide'", "'highlight'", "'restore'", 'currentColor']) expect(src, word).not.toContain(word);
  });
});
