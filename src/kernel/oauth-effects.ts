/**
 * The interpreter and kernel-host half of the OAuth effects (`oauth-authorize`, `oauth-connection-status`,
 * `oauth-connection-forget`): the asks that orbital-core's `run_oauth_authorize` / `run_oauth_connection` make,
 * in the same order, answered here. Every rule (client and option parsing, the authorization URL, the failure
 * messages) is the kernel's, reached through `@almadar/kernel`; only the sequencing of host asks lives here.
 */
import { isJsonObject, type JsonObject, type JsonValue, type OAuthAuthorizePayload, type OAuthConnectionPayload, type OAuthEffectFailurePayload, type RuntimeValue } from '@almadar/core';
import type { OAuthAsk, OAuthReply } from '@almadar/core/kernel-wire';
import { base64Standard, isOAuthCode, isOAuthReason, type HttpKernel, type HttpPorts } from './http-exchange.js';

const PENDING_GRANT_TTL_MS = 10 * 60 * 1000;
/** A mock authorization never expires (the mock backend keeps its states for the life of the process). */
const MOCK_PENDING_TTL_MS = Number.MAX_SAFE_INTEGER;
const PROVIDERS = ['google', 'github', 'auth0'] as const;

/** A failed OAuth effect: its payload is what the `emit.failure` route carries. */
export class OAuthEffectFailure extends Error {
  constructor(readonly payload: OAuthEffectFailurePayload) {
    super(payload.error);
  }
}

function parsed(text: string): JsonValue {
  return JSON.parse(text);
}

function objectOf(value: JsonValue | undefined, what: string): JsonObject {
  if (value === undefined || !isJsonObject(value)) throw new Error(`${what} is malformed`);
  return value;
}

function failureOf(kernel: HttpKernel, reason: OAuthEffectFailurePayload['reason']): OAuthEffectFailure {
  if (kernel.oauthFailure === undefined) throw new Error('this kernel build has no OAuth failure messages');
  const payload = objectOf(parsed(kernel.oauthFailure(reason)), 'the oauth failure');
  const { error, code } = payload;
  if (typeof error !== 'string' || !isOAuthCode(code)) throw new Error('the oauth failure is malformed');
  return new OAuthEffectFailure({ error, code, reason });
}

async function ask(ports: HttpPorts, kernel: HttpKernel, request: OAuthAsk, principal: string | undefined): Promise<OAuthReply> {
  if (ports.oauth === undefined) throw failureOf(kernel, 'store-unavailable');
  try {
    const reply = await ports.oauth.answer(request, principal);
    if (!isReplyOf(request, reply)) throw new Error('wrong reply');
    return reply;
  } catch {
    throw failureOf(kernel, 'store-unavailable');
  }
}

function isReplyOf(request: OAuthAsk, reply: OAuthReply): boolean {
  switch (request.ask) {
    case 'pendingPut': case 'subjectRemember': case 'subjectForget': case 'metadataPut': return reply.reply === 'done';
    case 'pendingTake': return reply.reply === 'taken';
    case 'connectionAvailable': return reply.reply === 'flag';
    case 'connectionSave': case 'connectionStatus': case 'connectionRemove': return reply.reply === 'row';
    case 'subjectLookup': return reply.reply === 'subject';
    case 'metadataGet': return reply.reply === 'metadata';
    case 'clock': return reply.reply === 'millis';
    case 'mockTokenPut': return reply.reply === 'done';
    case 'mockTokenRefresh': case 'mockTokenRevoke': return reply.reply === 'flag';
    case 'mockTokenCheck': return reply.reply === 'mockToken';
    case 'consent': return reply.reply === 'code';
  }
}

/** `oauth-authorize`: the kernel's steps, in order — secret, metadata, two draws, pending grant. */
export async function oauthAuthorizePayload(
  ports: HttpPorts,
  client: RuntimeValue | undefined,
  options: RuntimeValue | undefined,
  principal: string | undefined,
  key?: RuntimeValue,
): Promise<OAuthAuthorizePayload> {
  if (key !== undefined && (typeof key !== 'string' || key === '')) {
    throw new Error(`call key must evaluate to a non-empty string, got ${String(key)}`);
  }
  const echoed = typeof key === 'string' ? key : null;
  const kernel = await ports.kernel();
  if (kernel.oauthAuthorizePlan === undefined || kernel.oauthAuthorizeBuild === undefined) {
    throw new Error('oauth-authorize: this kernel build cannot run it');
  }
  const planned = objectOf(parsed(kernel.oauthAuthorizePlan(JSON.stringify(client ?? null), JSON.stringify(options ?? null))), 'the authorize plan');
  if (planned.mode === 'mock') {
    if (kernel.oauthAuthorizeMockBuild === undefined) throw new Error('oauth-authorize: this kernel build cannot run it');
    const mock = objectOf(parsed(kernel.oauthAuthorizeMockBuild(JSON.stringify(planned.plan ?? null), base64Standard(ports.random(16)))), 'the authorization');
    return keepGrant(ports, kernel, mock, MOCK_PENDING_TTL_MS, principal, echoed, false);
  }
  const slot = objectOf(planned.clientId, 'the client id slot');
  if (typeof slot.name !== 'string') throw new Error('the client id slot is malformed');
  let owner: string | undefined;
  if (slot.scope === 'user') {
    if (principal === undefined) throw failureOf(kernel, 'not-signed-in');
    owner = principal;
  }
  const clientId = await ports.secrets.get(slot.name, owner);
  if (clientId === undefined) throw failureOf(kernel, 'unconfigured-client');
  let metadata: JsonValue = planned.metadata ?? null;
  if (typeof planned.issuer === 'string') {
    const reply = await ask(ports, kernel, { ask: 'metadataGet', issuer: planned.issuer }, principal);
    metadata = reply.reply === 'metadata' ? reply.metadata : null;
  }
  if (metadata === null) throw failureOf(kernel, 'metadata-invalid');
  const state = ports.random(32);
  const verifier = ports.random(32);
  const built = objectOf(
    parsed(kernel.oauthAuthorizeBuild(JSON.stringify(planned.plan ?? null), clientId, JSON.stringify(metadata), base64Standard(state), base64Standard(verifier))),
    'the authorization',
  );
  if (typeof built.refused === 'string') throw new Error(built.refused);
  if (built.failure !== undefined) {
    const failure = objectOf(built.failure, 'the failure');
    const reason = failure.reason;
    if (!isOAuthReason(reason)) throw new Error('the oauth failure is malformed');
    throw failureOf(kernel, reason);
  }
  return keepGrant(ports, kernel, objectOf(built.ok, 'the authorization'), PENDING_GRANT_TTL_MS, principal, echoed, true);
}

/** Hand the pending grant to the host and report the URL and state; a real authorization then asks the host for the person's consent, which answers the code it returned (none on a host that asks no one). */
async function keepGrant(ports: HttpPorts, kernel: HttpKernel, ok: JsonObject, ttlMs: number, principal: string | undefined, key: string | null, consent: boolean): Promise<OAuthAuthorizePayload> {
  const grant = objectOf(ok.grant, 'the pending grant');
  if (typeof ok.authUrl !== 'string' || typeof ok.state !== 'string') throw new Error('the authorization is malformed');
  const scopes = Array.isArray(grant.scopes) ? grant.scopes.flatMap((scope) => (typeof scope === 'string' ? [scope] : [])) : [];
  await ask(
    ports,
    kernel,
    {
      ask: 'pendingPut',
      state: ok.state,
      ttlMs,
      grant: {
        provider: String(grant.provider),
        redirectUri: String(grant.redirectUri),
        verifier: String(grant.verifier),
        subject: typeof grant.subject === 'string' ? grant.subject : null,
        scopes,
      },
    },
    principal,
  );
  let code = '';
  if (consent) {
    const reply = await ask(ports, kernel, { ask: 'consent', authUrl: ok.authUrl, state: ok.state, redirectUri: String(grant.redirectUri) }, principal);
    code = reply.reply === 'code' ? (reply.code ?? '') : '';
  }
  return { authUrl: ok.authUrl, state: ok.state, code, key };
}

/** `oauth-connection-status` / `oauth-connection-forget`: store first, then caller (the legacy order). */
export async function oauthConnectionPayload(
  ports: HttpPorts,
  head: 'oauth-connection-status' | 'oauth-connection-forget',
  provider: RuntimeValue | undefined,
  principal: string | undefined,
): Promise<OAuthConnectionPayload> {
  const word = PROVIDERS.find((known) => known === provider);
  if (word === undefined) {
    throw new Error(typeof provider === 'string'
      ? `${head}: provider must be google, github or auth0, not \`${provider}\``
      : `${head}: provider must be a provider word`);
  }
  const kernel = await ports.kernel();
  const available = await ask(ports, kernel, { ask: 'connectionAvailable' }, principal);
  if (available.reply !== 'flag' || !available.value) throw failureOf(kernel, 'store-unavailable');
  if (principal === undefined || principal === '') throw failureOf(kernel, 'not-signed-in');
  const reply = await ask(ports, kernel, head === 'oauth-connection-status' ? { ask: 'connectionStatus', provider: word } : { ask: 'connectionRemove', provider: word }, principal);
  if (reply.reply !== 'row') throw failureOf(kernel, 'store-unavailable');
  return reply.row;
}
