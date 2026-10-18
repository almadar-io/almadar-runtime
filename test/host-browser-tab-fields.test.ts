// @vitest-environment jsdom
/**
 * The two field options beyond reading a selector/attribute: `template` composes a value from other fields of the
 * same element, and `required` holds an element back until that field reads non-empty (pages that insert empty
 * placeholders and fill them later). The kernel validates the field specs; the executor only reads them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TabField } from '@almadar/core/kernel-wire';
import { createPageExecutor, type PageExecutor, type TabElement } from '../src/host/chrome/tabs/executor.js';

const CARD = (author: string, id: string, caption: string) =>
  `<article class="card"><a class="author" href="/@${author}">${author}</a><button class="menu" data-item-id="${id}"></button><p class="caption">${caption}</p></article>`;
const PLACEHOLDER = '<article class="card"></article>';

const reads = (specs: Record<string, Omit<TabField, 'name'>>): TabField[] => Object.entries(specs).map(([name, spec]) => ({ name, ...spec }));

const linkFields = reads({
  author: { selector: '.author', attr: 'href' },
  itemId: { selector: '.menu', attr: 'data-item-id' },
  link: { template: '{author}/item/{itemId}', resolve: true, required: true },
});

let exec: PageExecutor;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = `<main id="list">${CARD('ann', '101', 'First')}</main>`;
  exec = createPageExecutor(document);
});

describe('template', () => {
  it('composes a value from other fields of the element, resolved as a URL when asked', () => {
    const [el] = exec.query('.card', linkFields);
    expect(el.fields).toEqual({ author: '/@ann', itemId: '101', link: new URL('/@ann/item/101', document.baseURI).toString() });
  });

  it('control: without resolve the composed value comes back as written', () => {
    const [el] = exec.query('.card', reads({ author: { selector: '.author', attr: 'href' }, itemId: { selector: '.menu', attr: 'data-item-id' }, link: { template: '{author}/item/{itemId}' } }));
    expect(el.fields.link).toBe('/@ann/item/101');
  });

  it('edge: a template whose referenced field is empty reads as empty, not a partial value', () => {
    document.body.innerHTML = '<article class="card"><a class="author" href="/@ann">ann</a></article>';
    const [el] = exec.query('.card', reads({ author: { selector: '.author', attr: 'href' }, itemId: { selector: '.menu', attr: 'data-item-id' }, link: { template: '{author}/item/{itemId}', resolve: true } }));
    expect(el.fields.link).toBe('');
  });

  it('edge: literal text without placeholders is kept as is', () => {
    expect(exec.query('.card', reads({ kind: { template: 'video' } }))[0].fields.kind).toBe('video');
  });
});

describe('required', () => {
  const placeholderLast = () => document.getElementById('list')?.insertAdjacentHTML('beforeend', PLACEHOLDER);

  it('query leaves out elements whose required field is empty', () => {
    placeholderLast();
    expect(exec.query('.card', linkFields).map((e) => e.fields.itemId)).toEqual(['101']);
  });

  it('control: without required the placeholder comes back with empty fields', () => {
    placeholderLast();
    const els = exec.query('.card', reads({ author: { selector: '.author', attr: 'href' }, itemId: { selector: '.menu', attr: 'data-item-id' }, link: { template: '{author}/item/{itemId}' } }));
    expect(els.map((e) => e.fields.itemId)).toEqual(['101', '']);
  });

  it('a required plain field holds the element back too', () => {
    placeholderLast();
    expect(exec.query('.card', reads({ caption: { selector: '.caption', required: true } }))).toHaveLength(1);
  });

  it('queryWhenPresent waits for a match that is ready, not merely present', async () => {
    document.body.innerHTML = `<main id="list">${PLACEHOLDER}</main>`;
    const pending = exec.queryWhenPresent('.card', linkFields, undefined, 1000);
    setTimeout(() => {
      const card = document.querySelector('.card');
      if (card) card.innerHTML = '<a class="author" href="/@bob">bob</a><button class="menu" data-item-id="202"></button>';
    }, 20);
    expect((await pending).map((e) => e.fields.itemId)).toEqual(['202']);
  });

  it('watch reports a placeholder once it fills in, and only once', async () => {
    document.body.innerHTML = `<main id="list">${PLACEHOLDER}</main>`;
    const seen: TabElement[] = [];
    exec.watch('w', '.card', linkFields, (el) => seen.push(el));
    expect(seen).toEqual([]);
    const card = document.querySelector('.card');
    if (card) card.innerHTML = '<a class="author" href="/@bob">bob</a><button class="menu" data-item-id="202"></button>';
    await flush();
    card?.insertAdjacentHTML('beforeend', '<p class="caption">late caption</p>');
    await flush();
    expect(seen.map((e) => e.fields.itemId)).toEqual(['202']);
  });

  it('watch notices a required attribute set after the element was inserted', async () => {
    document.body.innerHTML = '<main id="list"><article class="card"><a class="author" href="/@cy">cy</a><button class="menu"></button></article></main>';
    const seen: TabElement[] = [];
    exec.watch('w', '.card', linkFields, (el) => seen.push(el));
    expect(seen).toEqual([]);
    document.querySelector('.menu')?.setAttribute('data-item-id', '303');
    await flush();
    expect(seen.map((e) => e.fields.itemId)).toEqual(['303']);
  });

  it('control: without required watch reports the placeholder at once, empty', () => {
    document.body.innerHTML = `<main id="list">${PLACEHOLDER}</main>`;
    const seen: TabElement[] = [];
    exec.watch('w', '.card', reads({ itemId: { selector: '.menu', attr: 'data-item-id' } }), (el) => seen.push(el));
    expect(seen.map((e) => e.fields.itemId)).toEqual(['']);
  });
});
