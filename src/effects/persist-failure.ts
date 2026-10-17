import type { ServerEffectResult } from '@almadar/core';

/** The coded reason a persist failed (`ServerEffectCode` from the generated kernel wire, the one source). */
export type PersistFailureCode = NonNullable<ServerEffectResult['code']>;

/** A persist refused with a declared code; the stage records `code` on its `ServerEffectResult`. */
export class PersistFailure extends Error {
  constructor(message: string, readonly code: PersistFailureCode) {
    super(message);
    this.name = 'PersistFailure';
  }
}

export function noRowKeyFailure(action: string, entityType: string): PersistFailure {
  return new PersistFailure(
    `persist ${action} ${entityType} resolved no row key — the id was neither `
    + `on the row being written nor on the request. Bind it before the `
    + `write, e.g. (set @entity.id ?row.id) on the transition that selects it.`,
    'no-row-key',
  );
}

export function notFoundFailure(entityType: string, id: string): PersistFailure {
  return new PersistFailure(`${entityType} ${id} not found`, 'not-found');
}

export function duplicateIdFailure(entityType: string, id: string): PersistFailure {
  return new PersistFailure(`${entityType} ${id} already exists`, 'duplicate-id');
}

/** The `code` field to spread onto a failed persist result: the thrown failure's, else none. */
export function codeOf(error: unknown): { code: PersistFailureCode } | Record<string, never> {
  return error instanceof PersistFailure ? { code: error.code } : {};
}
