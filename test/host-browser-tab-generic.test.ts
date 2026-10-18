/**
 * The browser-tab port is generic access to the user's tabs: sites, selectors and URLs are always
 * parameters. The rule is deterministic: every host its code names (in a URL or a match
 * pattern) is a reserved example domain (RFC 2606). Real sites live in io realization data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function hostsIn(text: string): string[] {
  return [...text.matchAll(/(?:https?|\*|file|ftp):\/\/(?:\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1].toLowerCase());
}

const RESERVED = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid|localhost))$/;
const unreserved = (text: string) => hostsIn(text).filter((h) => !RESERVED.test(h));

const src = resolve(__dirname, '../src');
const chrome = join(src, 'host/chrome');
const tabFiles = [...readdirSync(join(chrome, 'tabs')).map((f) => join(chrome, 'tabs', f)), join(chrome, 'index.ts'), join(chrome, 'content.ts')];

describe('the browser-tab port names no real site', () => {
  it.each(tabFiles)('%s names only reserved example hosts', (file) => {
    expect(unreserved(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('control: a real site in a URL or match pattern is caught', () => {
    expect(unreserved('"https://www.youtube.com/results" "*://*.tiktok.com/*" "https://shop.test/"')).toEqual(['www.youtube.com', 'tiktok.com']);
  });
});
