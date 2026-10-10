import { describe, it, expect } from 'vitest';
import { inlineNavItems } from '../src/server/OrbitalServerRuntime';
import { appNavItems } from '../src/evaluation/render-sigils';

describe('@pages nav entries', () => {
  it('uses the declared @label', () => {
    expect(inlineNavItems([{ name: 'ContactsPage', path: '/contacts', label: 'جهات الاتصال' }])[0].label).toBe('جهات الاتصال');
  });

  it('control: a page without @label is not a nav entry', () => {
    expect(inlineNavItems([{ name: 'ContactsPage', path: '/contacts' }])).toEqual([]);
  });

  it('carries @icon and @roles', () => {
    expect(
      inlineNavItems([{ name: 'StaffPage', path: '/staff', label: 'Staff', icon: 'users', roles: ['manager'] }]),
    ).toEqual([{ href: '/staff', label: 'Staff', icon: 'users', roles: ['manager'] }]);
  });

  it('edge: a :param route is never a nav entry, even with a label', () => {
    expect(inlineNavItems([{ name: 'ItemPage', path: '/items/:id', label: 'Item' }])).toEqual([]);
  });

  it('is app-wide in declaration order, deduped by path', () => {
    const items = appNavItems([
      { pages: [{ name: 'Home', path: '/', label: 'Home' }, { name: 'Hidden', path: '/hidden' }] },
      { pages: [{ name: 'Staff', path: '/staff', label: 'Staff', roles: ['manager'] }, { name: 'Again', path: '/', label: 'Again' }] },
    ]);
    expect(items.map((i) => i.href)).toEqual(['/', '/staff']);
    expect(items[0].label).toBe('Home');
  });
});
