/**
 * The one seed rule for browser-stored entities (`[persistent: x, local]`):
 * an EMPTY store gets the entity's written-out rows for the viewer's locale
 * (`instancesForLocale`), or — when it
 * declares `mock` — the shared mock seeder's rows. Rows the user already has
 * are never overwritten. Used by the browser store and by headless verify's
 * in-memory store alike.
 */
import type { OrbitalEntity } from '@almadar/core';
import { instancesForLocale } from '@almadar/core';
import type { EntityRow } from '../types.js';
import type { PersistenceAdapter } from '@almadar/core';
import { MockPersistenceAdapter, entitySchemaOf } from '@almadar/db/mock';

function seedRows(entity: OrbitalEntity, locale: string | undefined): EntityRow[] {
  const written = instancesForLocale(entity, locale);
  if (written.length > 0) return written;
  if (!entity.seedMock) return [];
  const mock = new MockPersistenceAdapter();
  mock.registerEntity(entitySchemaOf(entity));
  return mock.rowsOf(entity.name);
}

async function isEmpty(store: PersistenceAdapter, entityType: string): Promise<boolean> {
  return store.countRows ? (await store.countRows(entityType)) === 0 : (await store.list(entityType)).length === 0;
}

export async function seedBrowserStore(store: PersistenceAdapter, entities: readonly OrbitalEntity[], locale?: string): Promise<void> {
  for (const entity of entities) {
    if (entity.local !== true || !(await isEmpty(store, entity.name))) continue;
    for (const row of seedRows(entity, locale)) {
      await store.create(entity.name, row);
    }
  }
}
