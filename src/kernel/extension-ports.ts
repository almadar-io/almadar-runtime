/**
 * The `http` ports of a browser-extension host that holds credentials: the browser's own `fetch` for the bytes, and the
 * profile's credential store (the server host's encrypted rows, kept in `chrome.storage`) for every secret the kernel
 * asks. A program names a credential and the kernel resolves it here; no value is ever answered to the program.
 */
import type { CredentialStore } from '../host/credentials/store.js';
import { createBrowserHttpPorts, createHttpSecrets, type BrowserHttpPortsOptions, type HttpPorts } from './http-exchange.js';
import { createOAuthPort } from './oauth-port.js';

/** A credential the host keeps because a sign-in succeeded: the value stays with the host, `label` is the non-secret account name. */
export interface SignedInCredential {
  name: string;
  value: string;
  label: string;
}

export interface ExtensionHttpPortsOptions extends BrowserHttpPortsOptions {
  /** The warmed credential store of this browser profile. */
  credentials: Promise<CredentialStore>;
  /** Credentials the build supplies (an OAuth client id), read when the store holds none and only for the app-wide credential. */
  provisioned?: Readonly<Record<string, string>>;
  /**
   * The host's own sign-in, run when a real `oauth-authorize` asks for the person's consent: the host signs them in natively
   * (no code exchange, no client secret) and answers the credential to keep, or `null` when they did not sign in. The
   * credential is stored app-wide beside its label; the consent answer is always no code, so the program learns the outcome
   * only through `credential-status`.
   */
  signIn?: () => Promise<SignedInCredential | null>;
}

export function createExtensionHttpPorts(options: ExtensionHttpPortsOptions): HttpPorts {
  const provisioned = new Map(Object.entries(options.provisioned ?? {}));
  const secrets = createHttpSecrets(Date.now, {
    store: () => options.credentials,
    async resolve(name, principal) {
      const held = (await options.credentials).resolve(name, principal);
      return held ?? (principal === undefined ? provisioned.get(name) : undefined);
    },
  });
  const signIn = options.signIn;
  return {
    ...createBrowserHttpPorts(options),
    secrets,
    oauth: createOAuthPort({
      secrets,
      ...(signIn !== undefined
        ? {
            consent: async () => {
              const kept = await signIn();
              if (kept !== null) await secrets.persist?.(kept.name, kept.value, undefined, kept.label === '' ? undefined : kept.label);
              return null;
            },
          }
        : {}),
    }),
  };
}
