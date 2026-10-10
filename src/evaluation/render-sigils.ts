/**
 * The render sigils `@pages` and `@currentTheme`, assembled one way for every effect
 * stage (the server's and the index runner's). Mirrors the compiler's resolver.
 *
 * @packageDocumentation
 */
import { isPageReference, themeDataKey, type NavItem, type OrbitalDefinition, type Page, type PageRef } from '@almadar/core';

/** The baseline theme `@currentTheme` falls back to when no orbital or app theme is declared. Mirrors the compiler's `DEFAULT_THEME_KEY`. */
export const DEFAULT_THEME_KEY = 'minimalist-light';

/**
 * Map an orbital's inline pages to the `NavItem[]` the `@pages` sigil yields: one
 * entry per root page that declares `@label` (`href = page.path`, its `@icon` and
 * `@roles`). References (resolved before any stage runs) and `:param` pages are
 * skipped — the Rust resolver's filter.
 */
export function inlineNavItems(pages: readonly PageRef[]): NavItem[] {
  const items: NavItem[] = [];
  for (const page of pages) {
    if (isPageReference(page)) continue;
    const p: Page = page;
    if (typeof p.label !== 'string' || p.path.includes(':')) continue;
    const item: NavItem = { href: p.path, label: p.label };
    if (typeof p.icon === 'string') item.icon = p.icon;
    if (p.roles !== undefined) item.roles = [...p.roles];
    items.push(item);
  }
  return items;
}

/** `@pages` is app-wide: the root pages of every orbital, deduped by path, in orbital order. */
export function appNavItems(orbitals: Iterable<Pick<OrbitalDefinition, 'pages'>>): NavItem[] {
  const items: NavItem[] = [];
  const seen = new Set<string>();
  for (const orbital of orbitals) {
    for (const item of inlineNavItems(orbital.pages ?? [])) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      items.push(item);
    }
  }
  return items;
}

/** `@currentTheme`: the orbital's declared theme, else the app's theme key, else the baseline. */
export function sigilThemeKey(orbitalTheme: OrbitalDefinition['theme'], appThemeKey?: string): string {
  return themeDataKey(orbitalTheme) || appThemeKey || DEFAULT_THEME_KEY;
}
