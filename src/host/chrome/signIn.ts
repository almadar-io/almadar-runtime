/**
 * The extension-native Google sign-in of a browser host: Chrome's web-auth window with Google's secret-less implicit flow
 * (an `id_token` for a web client), then the Firebase session for that
 * Google credential. No client secret is involved anywhere, so none ships in an extension bundle.
 */
import { ChromePortError } from './errors.js';

/** The slice of `chrome.identity` a sign-in uses. */
export interface ChromeIdentityApi {
  getRedirectURL(): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
}

/** A credential the host keeps because a sign-in succeeded: `label` is the non-secret account name. */
export interface KeptCredential {
  name: string;
  value: string;
  label: string;
}

export interface GoogleSignInOptions {
  /** Web API key of the Firebase project. */
  apiKey: string;
  /** The Google OAuth web client id allowed for the extension's redirect URL. */
  clientId: string;
  /** The credential name the Firebase refresh token is kept under. */
  credential: string;
  identity: ChromeIdentityApi;
  fetch: typeof fetch;
  now?: () => number;
}

/** Firebase's session for a Google credential (`accounts:signInWithIdp`): the refresh token and the account's email. */
async function firebaseSession(options: GoogleSignInOptions, postBody: string): Promise<{ refreshToken: string; email: string }> {
  const response = await options.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(options.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postBody, requestUri: options.identity.getRedirectURL(), returnSecureToken: true }),
  });
  if (!response.ok) throw new ChromePortError(`Sign-in failed (${response.status})`, 'AUTH_ERROR');
  const signed: Record<string, string> = await response.json();
  if (typeof signed.refreshToken !== 'string' || signed.refreshToken === '') throw new ChromePortError('Sign-in returned no session', 'AUTH_ERROR');
  return { refreshToken: signed.refreshToken, email: typeof signed.email === 'string' ? signed.email : '' };
}

/**
 * Signs the person in with Google (secret-less implicit flow in Chrome's web-auth window) and exchanges the Google
 * `id_token` for a Firebase session. A closed window or a callback without an `id_token` is no sign-in (`null`); a rejected
 * exchange throws. The kernel's own authorization URL is not used: this host's consent is Chrome's, not a code exchange.
 */
export function googleSignIn(options: GoogleSignInOptions): () => Promise<KeptCredential | null> {
  const now = options.now ?? Date.now;
  return async () => {
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'id_token',
      redirect_uri: options.identity.getRedirectURL(),
      scope: 'openid email',
      nonce: String(now()),
    }).toString();
    let returned: string | undefined;
    try {
      returned = await options.identity.launchWebAuthFlow({ url: auth.toString(), interactive: true });
    } catch {
      return null;
    }
    const idToken = returned === undefined ? null : new URLSearchParams(new URL(returned).hash.slice(1)).get('id_token');
    if (idToken === null || idToken === '') return null;
    const session = await firebaseSession(options, `id_token=${encodeURIComponent(idToken)}&providerId=google.com`);
    return { name: options.credential, value: session.refreshToken, label: session.email };
  };
}

const FIREBASE_KEYED_ORIGINS: readonly string[] = ['https://securetoken.googleapis.com', 'https://identitytoolkit.googleapis.com'];

/**
 * The host's `fetch` for a Firebase project: a request to Firebase's token or identity endpoint that carries no `key` gets the
 * project's web API key as its `key` query parameter, so a program names only the bare endpoint and the key never appears in
 * a program. Any other request, and a request that already names a key, is sent as it is.
 */
export function firebaseKeyedFetch(apiKey: string, send: typeof fetch): typeof fetch {
  return (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(target);
    if (!FIREBASE_KEYED_ORIGINS.includes(url.origin) || url.searchParams.has('key')) return send(input, init);
    url.searchParams.set('key', apiKey);
    return send(url.href, init);
  };
}
