/**
 * Whose job it is to resolve a render's `@entity` leaves: the client's, for
 * rows the client holds. Browser-stored rows (`[persistent: x, local]`) live
 * in the browser store, so a board over them re-reads `@entity.boards` on
 * every render instead of freezing the value it had when it first painted.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEntity } from '@almadar/core';
import { clientResolvesRenderBindings } from '../src/index.js';

const entity = (extra: Partial<OrbitalEntity>): OrbitalEntity => ({ name: 'Task', fields: [{ name: 'id', type: 'string' }], ...extra });

describe('clientResolvesRenderBindings', () => {
  it('browser-stored rows are the client\'s to resolve', () => {
    expect(clientResolvesRenderBindings(entity({ persistence: 'persistent', collection: 'tasks', local: true }))).toBe(true);
  });

  it('control: server-stored rows stay server-resolved', () => {
    expect(clientResolvesRenderBindings(entity({ persistence: 'persistent', collection: 'tasks' }))).toBe(false);
  });

  it('control: runtime, shared and unbound stay client-resolved', () => {
    expect(clientResolvesRenderBindings(entity({ persistence: 'runtime' }))).toBe(true);
    expect(clientResolvesRenderBindings(entity({ persistence: 'persistent', shared: true }))).toBe(true);
    expect(clientResolvesRenderBindings(undefined)).toBe(true);
  });
});
