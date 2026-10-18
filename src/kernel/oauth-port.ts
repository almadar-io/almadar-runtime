/**
 * The one JS answerer of the kernel's OAuth asks, for the interpreter and the kernel host alike, and the twin of
 * orbital-core `oauth/store.rs`. A pending grant is a minted credential under the authorizing principal
 * (`oauth:grant:<state>`, consumed once through `HttpSecrets.take`); a connection is a durable credential of its
 * signed-in owner (`oauth:connection:<provider>`, tokens included, never read back whole). Only the subject
 * index, discovered metadata and the mock token table stay process-local. Nothing here sends a request or reads a
 * token back to a program; it persists what the driver hands it.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '@almadar/core';
import type { OAuthAsk, OAuthConnectionRow, OAuthPendingGrant, OAuthProvider, OAuthReply } from '@almadar/core/kernel-wire';
import type { HttpSecrets, OAuthPort } from './http-exchange.js';

/** What the person's consent page is opened with. */
export interface OAuthConsentRequest {
  authUrl: string;
  state: string;
  redirectUri: string;
}

export interface OAuthPortOptions {
  /** The host's credentials (read per ask when a function: a host installs them at boot). */
  secrets: HttpSecrets | (() => HttpSecrets);
  /** The host clock in epoch milliseconds. */
  now?: () => number;
  /** Opens the consent page for the person and answers the authorization code it returned, `null` when they declined; absent, the host asks no one. */
  consent?: (request: OAuthConsentRequest) => Promise<string | null>;
}

/**
 * The port's clock decides expiry (`expiresAt >= now` is live, the inclusive boundary of the native store); the
 * credential only garbage-collects, so it is given a grace beyond the TTL and an expired state answers `expired`,
 * not `missing`.
 */
export const PENDING_GRACE_MS = 60 * 60 * 1000;

const NO_CALLER = 'a provider connection needs a signed-in caller';
const NO_CONNECTIONS = 'no OAuth connection store is installed on this host';
const NO_TAKE = 'this host keeps no derived secrets to take';
const UNREADABLE = 'a held OAuth credential is unreadable';

const pendingName = (state: string): string => `oauth:grant:${state}`;
const connectionName = (provider: OAuthProvider): string => `oauth:connection:${provider}`;

function parseObject(text: string): JsonObject {
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(UNREADABLE);
  }
  if (!isJsonObject(value)) throw new Error(UNREADABLE);
  return value;
}

function textOf(object: JsonObject, name: string): string {
  const value = object[name];
  if (typeof value !== 'string') throw new Error(UNREADABLE);
  return value;
}

function textOrNull(object: JsonObject, name: string): string | null {
  const value = object[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(UNREADABLE);
  return value;
}

function textList(object: JsonObject, name: string): string[] {
  const value = object[name];
  if (!Array.isArray(value)) throw new Error(UNREADABLE);
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(UNREADABLE);
    return item;
  });
}

function objectOf(object: JsonObject, name: string): JsonObject {
  const value = object[name];
  if (value === undefined || !isJsonObject(value)) throw new Error(UNREADABLE);
  return value;
}

function grantOf(object: JsonObject): OAuthPendingGrant {
  return {
    provider: textOf(object, 'provider'),
    redirectUri: textOf(object, 'redirectUri'),
    verifier: textOf(object, 'verifier'),
    subject: textOrNull(object, 'subject'),
    scopes: textList(object, 'scopes'),
  };
}

function rowOf(object: JsonObject, provider: OAuthProvider): OAuthConnectionRow {
  const connected = object.connected;
  if (typeof connected !== 'boolean') throw new Error(UNREADABLE);
  return {
    provider,
    connected,
    account: textOf(object, 'account'),
    avatarUrl: textOf(object, 'avatarUrl'),
    scope: textList(object, 'scope'),
    connectedAt: textOf(object, 'connectedAt'),
  };
}

const disconnected = (provider: OAuthProvider): OAuthConnectionRow => ({ provider, connected: false, account: '', avatarUrl: '', scope: [], connectedAt: '' });

export function createOAuthPort(options: OAuthPortOptions): OAuthPort {
  const secrets = (): HttpSecrets => (typeof options.secrets === 'function' ? options.secrets() : options.secrets);
  const now = options.now ?? Date.now;
  const subjects = new Map<string, string>();
  const mockTokens = new Map<string, { refresh: string; expiresAt: number; provider: OAuthProvider }>();
  const mockRefresh = new Map<string, { access: string; provider: OAuthProvider }>();
  const metadata = new Map<string, JsonObject>();
  const caller = (principal: string | undefined): string => {
    if (principal === undefined || principal === '') throw new Error(NO_CALLER);
    return principal;
  };
  const durable = async (held: HttpSecrets): Promise<boolean> => held.persist !== undefined && held.durable !== undefined && held.durable();
  const take = async (held: HttpSecrets, name: string, principal: string | undefined): Promise<string | undefined> => {
    if (held.take === undefined) throw new Error(NO_TAKE);
    return held.take(name, principal);
  };
  return {
    async answer(ask: OAuthAsk, principal: string | undefined): Promise<OAuthReply> {
      const scope = principal === '' ? undefined : principal;
      switch (ask.ask) {
        case 'pendingPut': {
          const held = secrets();
          const record = JSON.stringify({ grant: ask.grant, expiresAt: now() + ask.ttlMs });
          if (held.hold !== undefined) await held.hold(pendingName(ask.state), record, ask.ttlMs + PENDING_GRACE_MS, undefined);
          else await held.set(pendingName(ask.state), record, ask.ttlMs + PENDING_GRACE_MS, undefined);
          return { reply: 'done' };
        }
        case 'pendingTake': {
          const held = secrets();
          const name = pendingName(ask.state);
          const text = await take(held, name, undefined);
          if (text === undefined) return { reply: 'taken', taken: { found: 'missing' } };
          const record = parseObject(text);
          const expiresAt = record.expiresAt;
          if (typeof expiresAt !== 'number') throw new Error(UNREADABLE);
          if (expiresAt < now()) return { reply: 'taken', taken: { found: 'expired' } };
          return { reply: 'taken', taken: { found: 'grant', grant: grantOf(objectOf(record, 'grant')) } };
        }
        case 'connectionAvailable':
          return { reply: 'flag', value: await durable(secrets()) };
        case 'connectionSave': {
          const held = secrets();
          if (held.persist === undefined || !(await durable(held))) throw new Error(NO_CONNECTIONS);
          const who = caller(principal);
          const row: OAuthConnectionRow = {
            provider: ask.provider,
            connected: true,
            account: ask.grant.subject ?? '',
            avatarUrl: '',
            scope: ask.grant.scope ?? [],
            connectedAt: new Date(now()).toISOString(),
          };
          await held.persist(connectionName(ask.provider), JSON.stringify({ row, grant: ask.grant }), who);
          return { reply: 'row', row };
        }
        case 'connectionStatus': {
          const text = await secrets().get(connectionName(ask.provider), caller(principal));
          return { reply: 'row', row: text === undefined ? disconnected(ask.provider) : rowOf(objectOf(parseObject(text), 'row'), ask.provider) };
        }
        case 'connectionRemove':
          await secrets().forget(connectionName(ask.provider), caller(principal));
          return { reply: 'row', row: disconnected(ask.provider) };
        case 'subjectRemember':
          subjects.set(ask.accessToken, ask.subject);
          return { reply: 'done' };
        case 'subjectLookup':
          return { reply: 'subject', subject: subjects.get(ask.accessToken) ?? null };
        case 'subjectForget':
          subjects.delete(ask.accessToken);
          return { reply: 'done' };
        case 'metadataGet':
          return { reply: 'metadata', metadata: metadata.get(ask.issuer) ?? null };
        case 'metadataPut':
          metadata.set(ask.issuer, ask.metadata);
          return { reply: 'done' };
        case 'clock':
          return { reply: 'millis', value: now() };
        case 'consent':
          return { reply: 'code', code: options.consent === undefined ? null : await options.consent({ authUrl: ask.authUrl, state: ask.state, redirectUri: ask.redirectUri }) };
        case 'mockTokenPut':
          mockTokens.set(ask.accessToken, { refresh: ask.refreshToken, expiresAt: ask.expiresAtMs, provider: ask.provider });
          mockRefresh.set(ask.refreshToken, { access: ask.accessToken, provider: ask.provider });
          return { reply: 'done' };
        case 'mockTokenRefresh': {
          const old = mockRefresh.get(ask.refreshToken);
          if (old === undefined) return { reply: 'flag', value: false };
          mockTokens.delete(old.access);
          const sub = subjects.get(old.access);
          subjects.delete(old.access);
          if (sub !== undefined) subjects.set(ask.newAccessToken, sub);
          mockTokens.set(ask.newAccessToken, { refresh: ask.refreshToken, expiresAt: ask.expiresAtMs, provider: old.provider });
          mockRefresh.set(ask.refreshToken, { access: ask.newAccessToken, provider: old.provider });
          return { reply: 'flag', value: true };
        }
        case 'mockTokenRevoke': {
          const held = mockTokens.get(ask.token);
          if (held !== undefined) {
            mockTokens.delete(ask.token);
            mockRefresh.delete(held.refresh);
            subjects.delete(ask.token);
            return { reply: 'flag', value: true };
          }
          const issued = mockRefresh.get(ask.token);
          if (issued !== undefined) {
            mockRefresh.delete(ask.token);
            mockTokens.delete(issued.access);
            subjects.delete(issued.access);
            return { reply: 'flag', value: true };
          }
          return { reply: 'flag', value: false };
        }
        case 'mockTokenCheck': {
          const held = mockTokens.get(ask.accessToken);
          if (held === undefined) return { reply: 'mockToken', state: 'missing', provider: null };
          if (now() > held.expiresAt) {
            mockTokens.delete(ask.accessToken);
            subjects.delete(ask.accessToken);
            return { reply: 'mockToken', state: 'expired', provider: null };
          }
          return { reply: 'mockToken', state: 'valid', provider: held.provider };
        }
      }
    },
  };
}
