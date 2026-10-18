import * as asyncHooks from 'node:async_hooks';
import type { CredentialStore } from './store.js';

/** Whether integrations answer with mock data or call their real backends. */
export type CredentialMode = 'mock' | 'real';

/** The mode an env asks for: `ALMADAR_INTEGRATIONS_MODE=mock` or `USE_MOCK_DATA=true` mean mock. */
export function credentialModeFromEnv(env: Record<string, string | undefined>): CredentialMode {
  return env.ALMADAR_INTEGRATIONS_MODE === 'mock' || env.USE_MOCK_DATA === 'true' ? 'mock' : 'real';
}

/** The host's live mode switch, reachable from the kernel's `credential-mode` asks. */
export interface CredentialModeControl {
  readonly mode: CredentialMode;
  setMode(mode: CredentialMode): void;
}

let installedStore: CredentialStore | null = null;
let modeControl: CredentialModeControl | null = null;

/** A browser bundle maps `node:async_hooks` to an empty module (a dev server throws on reading it): tenant scopes then do not exist there. */
function tenantScopeStorage(): asyncHooks.AsyncLocalStorage<CredentialStore> | undefined {
  try {
    return typeof asyncHooks.AsyncLocalStorage === 'function' ? new asyncHooks.AsyncLocalStorage<CredentialStore>() : undefined;
  } catch {
    return undefined;
  }
}

const tenantScope = tenantScopeStorage();

/**
 * Run `fn` as one tenant of a multi-tenant host: every credential reference resolved inside it
 * (across awaits) comes from `store` alone, never from the host's env or installed store.
 */
export function runWithCredentialScope<T>(store: CredentialStore, fn: () => T): T {
  if (tenantScope === undefined) throw new Error('runWithCredentialScope needs a Node host (AsyncLocalStorage)');
  return tenantScope.run(store, fn);
}

/** The host's mode switch, installed beside its credential store. */
export function installModeControl(control: CredentialModeControl): void {
  modeControl = control;
}

export function getModeControl(): CredentialModeControl | null {
  return modeControl;
}

/**
 * Install the host's credential store as the process-wide resolution source.
 * Called once at boot (playground / generated server) after the store is
 * constructed over the host's persistence adapter.
 */
export function installCredentialStore(store: CredentialStore): void {
  installedStore = store;
}

/** The installed store, for the credentials admin service. */
export function getInstalledCredentialStore(): CredentialStore | null {
  return installedStore;
}

export function getEffectiveCredentialStore(): CredentialStore | null {
  return tenantScope?.getStore() ?? installedStore;
}

/** Testing/reset hook. */
export function uninstallCredentialStore(): void {
  installedStore = null;
}

/** The env var selecting store-only resolution (the kernel rule `credential_admin::SOURCE_VAR`). */
export const CREDENTIALS_SOURCE_ENV = 'ALMADAR_CREDENTIALS_SOURCE';

/** The host settings the kernel reads through the credential ask; they stay on the env under store-only resolution (`HOST_SETTING_VARS`). */
const HOST_SETTING_VARS: ReadonlySet<string> = new Set(['ALMADAR_CREDENTIAL_ADMIN_ROLES', CREDENTIALS_SOURCE_ENV, 'ALMADAR_INTEGRATIONS_MODE', 'USE_MOCK_DATA']);

/** Whether `env` selects store-only resolution: exactly `ALMADAR_CREDENTIALS_SOURCE=store`. */
export function credentialsFromStoreOnly(env: Record<string, string | undefined>): boolean {
  return env[CREDENTIALS_SOURCE_ENV] === 'store';
}

/**
 * The one credential-reference resolver: store, then env, then undefined; inside a tenant's
 * credential scope, that tenant's store only. With `ALMADAR_CREDENTIALS_SOURCE=store` every
 * name but a host setting answers from the store alone, never from the env. `ref` is an env-var name.
 */
export function resolveCredentialRef(
  ref: string,
  env: Record<string, string | undefined> = process.env,
  principal?: string,
): string | undefined {
  const tenant = tenantScope?.getStore();
  if (tenant) return tenant.resolve(ref, principal);
  if (principal !== undefined) return installedStore?.resolve(ref, principal);
  const stored = installedStore?.resolve(ref);
  if (stored !== undefined) return stored;
  if (credentialsFromStoreOnly(env) && !HOST_SETTING_VARS.has(ref)) return undefined;
  return env[ref];
}
