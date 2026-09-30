import { describe, it, expect } from 'vitest';
import { inlineNavItems } from '../src/server/OrbitalServerRuntime';

describe('@pages nav labels', () => {
  it('uses the declared @label', () => {
    expect(inlineNavItems([{ name: 'ContactsPage', path: '/contacts', label: 'جهات الاتصال' }])[0].label).toBe('جهات الاتصال');
  });

  it('control: without a label it shows the page name as written (no Page-suffix stripping)', () => {
    expect(inlineNavItems([{ name: 'ContactsPage', path: '/contacts' }])[0].label).toBe('ContactsPage');
  });
});
