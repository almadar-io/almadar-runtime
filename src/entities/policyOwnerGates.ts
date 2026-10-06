import type { OrbitalSchema, UserContext } from '@almadar/core';
import { personaFromIdentityRow } from '@almadar/core';
import { entityAccessPoliciesByStoreKey } from '@almadar/core/mock';
import type { MockPersistenceAdapter } from '@almadar/db/mock';
import { applyRowAccess, checkMutationAccess } from './entityAccess.js';

/**
 * Install the schema's access policies as the seeder's owner gates — the one
 * installation both the runtime (`OrbitalServerRuntime`) and the compiled apps'
 * `MockDataService` use. `@create` decides who may author a row (`viewer()` is
 * read at evaluation time, so one installation covers every persona switch);
 * `@read` decides a column it scopes by ownership (see `setOwnerReadGate`).
 */
export function installPolicyOwnerGates(
  adapter: MockPersistenceAdapter,
  schema: OrbitalSchema,
  viewer: () => UserContext | undefined,
): void {
  const policiesByStore = entityAccessPoliciesByStoreKey(schema);
  adapter.setOwnerGate((storeKey, candidateRow) => {
    const user = viewer();
    if (!user) return true;
    return checkMutationAccess(candidateRow, policiesByStore.get(storeKey)?.create, { user });
  });
  // A row without a usable identity id fails closed rather than evaluating as anonymous.
  adapter.setOwnerCandidateGate((storeKey, candidateRow, candidateIdentityRow) => {
    const persona = personaFromIdentityRow(candidateIdentityRow);
    if (!persona) return false;
    return checkMutationAccess(candidateRow, policiesByStore.get(storeKey)?.create, { user: persona });
  });
  adapter.setOwnerReadGate((storeKey, candidateRow, candidateIdentityRow) => {
    const read = policiesByStore.get(storeKey)?.read;
    const persona = personaFromIdentityRow(candidateIdentityRow);
    if (read === undefined || !persona) return false;
    return applyRowAccess([candidateRow], read, undefined, { user: persona }).length === 1;
  });
}
