export {
  CredentialStore,
  CREDENTIAL_ENTITY_TYPE,
  CREDENTIAL_MASTER_KEY_ENV,
  CREDENTIAL_PREVIOUS_MASTER_KEY_ENV,
  DERIVED_ENTITY_TYPE,
  type CredentialPersistence,
  type DerivedPersistence,
  type CredentialEntry,
} from './store.js';
export {
  installCredentialStore,
  getInstalledCredentialStore,
  getEffectiveCredentialStore,
  uninstallCredentialStore,
  resolveCredentialRef,
  runWithCredentialScope,
  installModeControl,
  credentialModeFromEnv,
  credentialsFromStoreOnly,
  CREDENTIALS_SOURCE_ENV,
  getModeControl,
  type CredentialMode,
  type CredentialModeControl,
} from './scope.js';
export { allCredentialEnvVars, STORE_BOOTSTRAP_ENV_VARS } from './env-vars.js';
export { seedCredentialStore, type DeclaredCredential } from './seed.js';
