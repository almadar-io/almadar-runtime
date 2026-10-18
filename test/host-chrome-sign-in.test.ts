// The browser host's sign-in steps: the consent window of `oauth-authorize` over `chrome.identity`, and the Firebase step of a Google connection. Each runs against
// a fake of the Chrome surface it uses. The signInWithIdp request/response shape is from Google's public Identity Toolkit
// documentation (accounts:signInWithIdp), not a recording of a real sign-in.
import { describe, expect, it } from 'vitest';
import {
  firebaseKeyedFetch,
  googleSignIn,
  type ChromeIdentityApi,
} from '../src/host/chrome/index.js';

function identity(returns: string | undefined | Error): ChromeIdentityApi & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    getRedirectURL: () => 'https://abc.chromiumapp.org/',
    async launchWebAuthFlow({ url }) {
      urls.push(url);
      if (returns instanceof Error) throw returns;
      return returns;
    },
  };
}

describe('googleSignIn', () => {
  const calls: Array<{ url: string; body: Record<string, string | boolean> }> = [];
  const respond = (status: number, body: Record<string, string>): typeof fetch =>
    (async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const signIn = (window: ChromeIdentityApi, fetchImpl: typeof fetch) =>
    googleSignIn({ apiKey: 'web key', clientId: 'web-client.apps.googleusercontent.com', credential: 'KNOWLEDGE_REFRESH_TOKEN', identity: window, fetch: fetchImpl, now: () => 1234 })();

  it('opens Google\'s secret-less implicit flow and exchanges the id_token for a Firebase session labelled with the email', async () => {
    calls.length = 0;
    const window = identity('https://abc.chromiumapp.org/#id_token=GOOGLE.ID.TOKEN&authuser=0');
    const kept = await signIn(window, respond(200, { idToken: 'ID', refreshToken: 'FIREBASE-RT', expiresIn: '3600', email: 'ada@example.com', localId: 'uid' }));
    expect(kept).toEqual({ name: 'KNOWLEDGE_REFRESH_TOKEN', value: 'FIREBASE-RT', label: 'ada@example.com' });
    const opened = new URL(window.urls[0]);
    expect(Object.fromEntries(opened.searchParams)).toEqual({
      client_id: 'web-client.apps.googleusercontent.com',
      response_type: 'id_token',
      redirect_uri: 'https://abc.chromiumapp.org/',
      scope: 'openid email',
      nonce: '1234',
    });
    expect(calls).toEqual([
      {
        url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=web%20key',
        body: { postBody: 'id_token=GOOGLE.ID.TOKEN&providerId=google.com', requestUri: 'https://abc.chromiumapp.org/', returnSecureToken: true },
      },
    ]);
    expect(window.urls.join(' ')).not.toMatch(/secret/i);
  });

  it('control: a closed window or a callback without an id_token is no sign-in and asks Firebase nothing; a rejected exchange throws', async () => {
    calls.length = 0;
    expect(await signIn(identity(new Error('The user did not approve access.')), respond(200, {}))).toBeNull();
    expect(await signIn(identity(undefined), respond(200, {}))).toBeNull();
    expect(await signIn(identity('https://abc.chromiumapp.org/#error=access_denied'), respond(200, {}))).toBeNull();
    expect(calls).toEqual([]);
    await expect(signIn(identity('https://abc.chromiumapp.org/#id_token=T'), respond(400, { error: 'INVALID_IDP_RESPONSE' }))).rejects.toThrow('Sign-in failed (400)');
    await expect(signIn(identity('https://abc.chromiumapp.org/#id_token=T'), respond(200, { idToken: 'ID' }))).rejects.toThrow('no session');
  });
});

describe('firebaseKeyedFetch', () => {
  const seen: string[] = [];
  const send = (async (input) => {
    seen.push(String(input));
    return new Response('{}');
  }) as typeof fetch;
  const keyed = firebaseKeyedFetch('WEB-KEY', send);

  it('adds the project key to a Firebase token or identity request that has none, and leaves every other request alone', async () => {
    seen.length = 0;
    await keyed('https://securetoken.googleapis.com/v1/token', { method: 'POST' });
    await keyed(new URL('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?alt=json'));
    await keyed('https://kflow.academy/api/user/jump-back-in?limit=3');
    await keyed('https://oauth2.googleapis.com/token');
    expect(seen).toEqual([
      'https://securetoken.googleapis.com/v1/token?key=WEB-KEY',
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?alt=json&key=WEB-KEY',
      'https://kflow.academy/api/user/jump-back-in?limit=3',
      'https://oauth2.googleapis.com/token',
    ]);
  });

  it('control: a request that already names a key keeps it', async () => {
    seen.length = 0;
    await keyed('https://securetoken.googleapis.com/v1/token?key=OTHER');
    expect(seen).toEqual(['https://securetoken.googleapis.com/v1/token?key=OTHER']);
  });
});
