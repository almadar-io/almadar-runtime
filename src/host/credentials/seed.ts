import { isJsonObject, type JsonValue } from '@almadar/core';
import type { CredentialStore } from './store.js';

/** One credential the app declares: the service group it belongs to and the env var / credential name. */
export interface DeclaredCredential {
  readonly service: string;
  readonly envVar: string;
}

/** The kernel export that decides a seed (`credential_admin::seed_plan`): the rows to copy, never a value. */
export interface CredentialSeedKernel {
  credentialSeedPlan(declaredJson: string, heldJson: string, presentJson: string): string;
}

function planRows(json: string): DeclaredCredential[] {
  const rows: JsonValue = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error('the kernel seed plan is not a list');
  return rows.map((row) => {
    if (!isJsonObject(row) || typeof row.service !== 'string' || typeof row.envVar !== 'string') {
      throw new Error('the kernel seed plan holds a row that is not { service, envVar }');
    }
    return { service: row.service, envVar: row.envVar };
  });
}

/**
 * The boot of `ALMADAR_CREDENTIALS_SOURCE=store`: the kernel plans which declared credentials the store lacks and the env
 * holds, and this copies each into the store, so the env stays the way to hand a deployment its first keys. A name
 * declared twice seeds once, a held row is never overwritten. Returns the count.
 */
export async function seedCredentialStore(
  store: CredentialStore,
  declared: readonly DeclaredCredential[],
  env: Record<string, string | undefined>,
  kernel: CredentialSeedKernel,
): Promise<number> {
  if (!store.enabled) return 0;
  const names = [...new Set(declared.map((d) => d.envVar))];
  const held = names.filter((name) => store.resolve(name) !== undefined);
  const present = names.filter((name) => (env[name] ?? '') !== '');
  const plan = planRows(kernel.credentialSeedPlan(JSON.stringify(declared), JSON.stringify(held), JSON.stringify(present)));
  for (const { service, envVar } of plan) {
    const value = env[envVar];
    if (value === undefined) throw new Error(`the kernel seeded ${envVar}, which the env does not hold`);
    await store.set(service, envVar, value);
  }
  return plan.length;
}
