/** Decoders for what the kernel hands back as JSON: narrowed by checks, never cast. */
import { isEventResponse, type Envelope, type InstanceRef, type OAuthAsk, type OsOp, type PageFactFieldWire, type TabAction, type TabApply, type TabAsk, type TabCommand, type TabField } from '@almadar/core/kernel-wire';
import { isJsonObject, type JsonObject, RowQuerySchema, RowWriteBatchSchema, type EntityRow, type JsonValue, type OrbitalEventResponse } from '@almadar/core';
import type { CallSiteWire, HttpBody, HttpRequestWire, HttpResponseWire, IoRequestWire, PendingRequestWire, ResolveProgressWire, ServerProgressWire } from './wire.js';

type JsonRecord = { [key: string]: JsonValue };

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: JsonRecord, name: string): JsonValue {
  const value = record[name];
  if (value === undefined) throw new Error(`kernel wire: "${name}" is missing`);
  return value;
}

function text(record: JsonRecord, name: string): string {
  const value = field(record, name);
  if (typeof value !== 'string') throw new Error(`kernel wire: "${name}" is not a string`);
  return value;
}

function whole(record: JsonRecord, name: string): number {
  const value = field(record, name);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`kernel wire: "${name}" is not an integer`);
  return value;
}

function list(record: JsonRecord, name: string): JsonValue[] {
  const value = field(record, name);
  if (!Array.isArray(value)) throw new Error(`kernel wire: "${name}" is not a list`);
  return value;
}

function optionalText(record: JsonRecord, name: string): string | undefined {
  return record[name] === undefined ? undefined : text(record, name);
}

function decodeSite(value: JsonValue): CallSiteWire {
  if (!isRecord(value)) throw new Error('kernel wire: "site" is not an object');
  const orbital = optionalText(value, 'orbital');
  const emit = field(value, 'emit');
  if (!isRecord(emit)) throw new Error('kernel wire: "emit" is not an object');
  const success = optionalText(emit, 'success');
  const failure = optionalText(emit, 'failure');
  const cancelled = optionalText(emit, 'cancelled');
  const onMessage = optionalText(emit, 'onMessage');
  const followOn = field(value, 'followOn');
  if (typeof followOn !== 'boolean') throw new Error('kernel wire: "followOn" is not a boolean');
  return {
    ...(orbital !== undefined ? { orbital } : {}),
    trait: text(value, 'trait'),
    followOn,
    emit: {
      ...(success !== undefined ? { success } : {}),
      ...(failure !== undefined ? { failure } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
      ...(onMessage !== undefined ? { onMessage } : {}),
    },
  };
}

function headerPairs(record: JsonRecord, name: string): Array<[string, string]> {
  return list(record, name).map((pair) => {
    const [headerName, headerValue, ...rest] = Array.isArray(pair) ? pair : [];
    if (typeof headerName !== 'string' || typeof headerValue !== 'string' || rest.length > 0) {
      throw new Error(`kernel wire: "${name}" holds a header that is not a [name, value] pair`);
    }
    return [headerName, headerValue];
  });
}

export function decodeHttpBody(value: JsonValue): HttpBody {
  if (!isRecord(value)) throw new Error('kernel wire: an http body is not an object');
  const kind = text(value, 'kind');
  switch (kind) {
    case 'empty':
      return { kind };
    case 'text':
      return { kind, text: text(value, 'text') };
    case 'base64':
      return { kind, data: text(value, 'data') };
    default:
      throw new Error(`kernel wire: unknown http body kind "${kind}"`);
  }
}

export function decodeHttpRequest(value: JsonValue): HttpRequestWire {
  if (!isRecord(value)) throw new Error('kernel wire: an http request is not an object');
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0)) {
    throw new Error('kernel wire: "timeoutMs" is not a non-negative integer');
  }
  return {
    method: text(value, 'method'),
    url: text(value, 'url'),
    headers: headerPairs(value, 'headers'),
    body: decodeHttpBody(field(value, 'body')),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function decodeHttpResponse(value: JsonValue): HttpResponseWire {
  if (!isRecord(value)) throw new Error('kernel wire: an http response is not an object');
  const status = whole(value, 'status');
  return { status, headers: headerPairs(value, 'headers'), body: decodeHttpBody(field(value, 'body')) };
}

const OS_OPS: readonly OsOp[] = [
  'os/read-file', 'os/write-file', 'os/append-file', 'os/open', 'os/close', 'os/read', 'os/write', 'os/seek', 'os/truncate',
  'os/fsync', 'os/copy', 'os/rename', 'os/remove', 'os/link', 'os/symlink', 'os/readlink', 'os/watch-files', 'os/mkdir',
  'os/rmdir', 'os/list-dir', 'os/glob', 'os/mktemp', 'os/realpath', 'os/cwd', 'os/chdir', 'os/stat', 'os/lstat', 'os/access',
  'os/exists', 'os/chmod', 'os/chown', 'os/utimes', 'os/spawn', 'os/wait', 'os/kill', 'os/pid', 'os/ppid', 'os/watch-process',
  'os/watch-signal', 'os/getenv', 'os/setenv', 'os/unsetenv', 'os/environ', 'os/watch-env', 'os/stdin-read', 'os/stdout-write',
  'os/stderr-write', 'os/isatty', 'os/tty-size', 'os/tcp-connect', 'os/tcp-listen', 'os/send', 'os/recv', 'os/udp-bind',
  'os/sendto', 'os/recvfrom', 'os/dns-resolve', 'os/shutdown', 'os/watch-port', 'os/clock-monotonic', 'os/uid', 'os/gid',
  'os/username', 'os/group-of', 'os/watch-cron', 'os/cpu-usage', 'os/memory-info', 'os/uptime', 'os/load-avg', 'os/hostname',
  'os/uname', 'os/disk-usage', 'os/mounts', 'os/disk-io', 'os/network-interfaces', 'os/network-stats', 'os/network-connected',
  'os/default-gateway', 'os/battery-status', 'os/ac-power', 'os/thermal-zones', 'os/notify', 'os/speak', 'os/brightness-get',
  'os/brightness-set', 'os/volume-get', 'os/volume-set', 'os/volume-mute', 'os/suspend', 'os/hibernate',
];

function osOp(record: JsonRecord, name: string): OsOp {
  const raw = text(record, name);
  const found = OS_OPS.find((op) => op === raw);
  if (found === undefined) throw new Error(`kernel wire: unknown os op "${raw}"`);
  return found;
}

/** Every request kind of the generated wire, keyed so a kind the wire gains is a type error here until listed. */
const REQUEST_KINDS: { readonly [K in IoRequestWire['kind']]: true } = {
  readRow: true, listRows: true, queryRows: true, writeRows: true, createRow: true, writeRow: true, deleteRow: true,
  callService: true, cancelCall: true, substrate: true, http: true, httpStream: true, httpBeacon: true, pageFacts: true,
  prompt: true, embed: true, tab: true, secret: true, secretSet: true, secretRotate: true, oauth: true, deliver: true, random: true,
  os: true, credentialStatus: true, credentialForget: true, clock: true,
  credentialStoreList: true, credentialStoreRead: true, credentialStoreWrite: true, credentialStoreRemove: true,
  credentialStoreRotate: true, credentialModeRead: true, credentialModeWrite: true,
};

function isRequestKind(raw: string): raw is IoRequestWire['kind'] {
  return Object.prototype.hasOwnProperty.call(REQUEST_KINDS, raw);
}

function assertNever(value: never): never {
  throw new Error(`kernel wire: unhandled request kind "${String(value)}"`);
}

function decodeInstanceRef(value: JsonValue): InstanceRef {
  if (!isRecord(value)) throw new Error('kernel wire: an instance reference is not an object');
  const trait = optionalText(value, 'trait');
  return { instance: text(value, 'instance'), orbital: text(value, 'orbital'), ...(trait !== undefined ? { trait } : {}) };
}

function decodeEnvelope(value: JsonValue): Envelope {
  if (!isRecord(value)) throw new Error('kernel wire: an envelope is not an object');
  return {
    id: text(value, 'id'),
    from: decodeInstanceRef(field(value, 'from')),
    to: decodeInstanceRef(field(value, 'to')),
    event: text(value, 'event'),
    payload: field(value, 'payload'),
    causalId: text(value, 'causalId'),
    hop: whole(value, 'hop'),
  };
}

function optionalFlag(record: JsonRecord, name: string): boolean | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`kernel wire: "${name}" is not a boolean`);
  return value;
}

function optionalWhole(record: JsonRecord, name: string): number | undefined {
  return record[name] === undefined ? undefined : whole(record, name);
}

function tabRecord(value: JsonValue, what: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`kernel wire: ${what} is not an object`);
  return value;
}

function decodeTabField(value: JsonValue): TabField {
  const entry = tabRecord(value, 'a tab field');
  const selector = optionalText(entry, 'selector');
  const attr = optionalText(entry, 'attr');
  const template = optionalText(entry, 'template');
  const resolve = optionalFlag(entry, 'resolve');
  const required = optionalFlag(entry, 'required');
  return {
    name: text(entry, 'name'),
    ...(selector !== undefined ? { selector } : {}),
    ...(attr !== undefined ? { attr } : {}),
    ...(resolve !== undefined ? { resolve } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}

function decodeTabApply(entry: JsonRecord): TabApply {
  const label = optionalText(entry, 'label');
  return {
    elementId: text(entry, 'elementId'),
    styles: list(entry, 'styles').map((style) => {
      const record = tabRecord(style, 'a tab style');
      return { property: text(record, 'property'), value: text(record, 'value') };
    }),
    ...(label !== undefined ? { label } : {}),
  };
}

function tabAction(entry: JsonRecord): TabAction {
  const raw = text(entry, 'action');
  if (raw === 'click' || raw === 'focus' || raw === 'type') return raw;
  throw new Error(`kernel wire: unknown tab action "${raw}"`);
}

function decodeTabCommand(value: JsonValue): TabCommand {
  const entry = tabRecord(value, 'a tab command');
  const kind = text(entry, 'kind');
  switch (kind) {
    case 'query': {
      const limit = optionalWhole(entry, 'limit');
      const waitMs = optionalWhole(entry, 'waitMs');
      return {
        kind,
        selector: text(entry, 'selector'),
        fields: list(entry, 'fields').map(decodeTabField),
        ...(limit !== undefined ? { limit } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
      };
    }
    case 'watch':
      return { kind, watchId: text(entry, 'watchId'), selector: text(entry, 'selector'), fields: list(entry, 'fields').map(decodeTabField) };
    case 'unwatch':
      return { kind, watchId: text(entry, 'watchId') };
    case 'apply':
      return { kind, ...decodeTabApply(entry) };
    case 'applyMany':
      return { kind, items: list(entry, 'items').map((item) => decodeTabApply(tabRecord(item, 'a tab treatment'))) };
    case 'act': {
      const typed = optionalText(entry, 'text');
      return { kind, elementId: text(entry, 'elementId'), action: tabAction(entry), ...(typed !== undefined ? { text: typed } : {}) };
    }
    default:
      throw new Error(`kernel wire: unknown tab command "${kind}"`);
  }
}

function decodeTabAsk(value: JsonValue): TabAsk {
  const entry = tabRecord(value, 'a tab ask');
  const kind = text(entry, 'kind');
  switch (kind) {
    case 'list':
      return { kind };
    case 'open': {
      const active = optionalFlag(entry, 'active');
      if (active === undefined) throw new Error('kernel wire: "active" is missing');
      return { kind, url: text(entry, 'url'), active };
    }
    case 'close':
      return { kind, tab: whole(entry, 'tab') };
    case 'navigate':
      return { kind, tab: whole(entry, 'tab'), url: text(entry, 'url') };
    case 'command':
      return { kind, tab: whole(entry, 'tab'), command: decodeTabCommand(field(entry, 'command')) };
    case 'awaitReady':
      return { kind, tab: whole(entry, 'tab'), timeoutMs: whole(entry, 'timeoutMs') };
    case 'watch': {
      const deliver = tabRecord(field(entry, 'deliver'), 'a tab delivery');
      return {
        kind,
        watchId: text(entry, 'watchId'),
        match: text(entry, 'match'),
        selector: text(entry, 'selector'),
        fields: list(entry, 'fields').map(decodeTabField),
        deliver: { orbital: text(deliver, 'orbital'), trait: text(deliver, 'trait'), event: text(deliver, 'event') },
      };
    }
    case 'unwatch':
      return { kind, watchId: text(entry, 'watchId') };
    default:
      throw new Error(`kernel wire: unknown tab ask "${kind}"`);
  }
}

function pageFactField(entry: JsonValue): PageFactFieldWire {
  if (entry === 'hostname' || entry === 'referrer' || entry === 'screenWidth') return entry;
  throw new Error('kernel wire: "fields" holds an unknown page fact');
}

export function decodeRequest(value: JsonValue): IoRequestWire {
  if (!isRecord(value)) throw new Error('kernel wire: a request is not an object');
  const rawKind = text(value, 'kind');
  if (!isRequestKind(rawKind)) throw new Error(`kernel wire: unknown request kind "${rawKind}"`);
  const kind = rawKind;
  switch (kind) {
    case 'readRow':
      return { kind, entityType: text(value, 'entityType'), id: text(value, 'id') };
    case 'listRows':
      return { kind, entityType: text(value, 'entityType') };
    case 'queryRows': {
      const project = text(value, 'project');
      if (project !== 'rows' && project !== 'ids') throw new Error(`kernel wire: unknown projection "${project}"`);
      return { kind, entityType: text(value, 'entityType'), query: RowQuerySchema.parse(field(value, 'query')), project };
    }
    case 'writeRows':
      return { kind, batch: RowWriteBatchSchema.parse(field(value, 'batch')) };
    case 'createRow':
      return { kind, entityType: text(value, 'entityType'), data: field(value, 'data') };
    case 'writeRow':
      return { kind, entityType: text(value, 'entityType'), id: text(value, 'id'), data: field(value, 'data') };
    case 'deleteRow':
      return { kind, entityType: text(value, 'entityType'), id: text(value, 'id') };
    case 'callService': {
      const key = optionalText(value, 'key');
      const rawCaller = value.caller;
      let caller: { principal: string; role?: string } | undefined;
      if (rawCaller !== undefined) {
        if (!isRecord(rawCaller)) throw new Error('kernel wire: "caller" is not an object');
        const role = optionalText(rawCaller, 'role');
        caller = { principal: text(rawCaller, 'principal'), ...(role !== undefined ? { role } : {}) };
      }
      const rawSite = value.site;
      return {
        kind,
        service: text(value, 'service'),
        method: text(value, 'method'),
        args: field(value, 'args'),
        ...(key !== undefined ? { key } : {}),
        ...(caller !== undefined ? { caller } : {}),
        ...(rawSite !== undefined ? { site: decodeSite(rawSite) } : {}),
      };
    }
    case 'cancelCall':
      return { kind, key: text(value, 'key') };
    case 'substrate':
      return { kind, op: text(value, 'op'), args: list(value, 'args') };
    case 'http': {
      const key = optionalText(value, 'key');
      const rawSite = value.site;
      const delayMs = value.delayMs;
      if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0)) {
        throw new Error('kernel wire: "delayMs" is not a non-negative integer');
      }
      return {
        kind,
        request: decodeHttpRequest(field(value, 'request')),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(rawSite !== undefined ? { site: decodeSite(rawSite) } : {}),
      };
    }
    case 'httpStream': {
      const key = optionalText(value, 'key');
      const framing = text(value, 'framing');
      if (framing !== 'sse' && framing !== 'jsonLines') throw new Error(`kernel wire: unknown stream framing "${framing}"`);
      const rawSite = value.site;
      return {
        kind,
        request: decodeHttpRequest(field(value, 'request')),
        framing,
        ...(key !== undefined ? { key } : {}),
        ...(rawSite !== undefined ? { site: decodeSite(rawSite) } : {}),
      };
    }
    case 'prompt': {
      const key = optionalText(value, 'key');
      return { kind, text: text(value, 'text'), schema: text(value, 'schema'), ...(key !== undefined ? { key } : {}) };
    }
    case 'embed': {
      const key = optionalText(value, 'key');
      const texts = list(value, 'texts').map((entry) => {
        if (typeof entry !== 'string') throw new Error('kernel wire: "texts" holds a non-string');
        return entry;
      });
      return { kind, texts, ...(key !== undefined ? { key } : {}) };
    }
    case 'tab': {
      const key = optionalText(value, 'key');
      return { kind, ask: decodeTabAsk(field(value, 'ask')), ...(key !== undefined ? { key } : {}) };
    }
    case 'secret': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'secretSet': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), value: text(value, 'value'), ttlMs: whole(value, 'ttlMs'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'secretRotate': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), value: text(value, 'value'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'random':
      return { kind, bytes: whole(value, 'bytes') };
    case 'clock':
      return { kind };
    case 'os': {
      const key = optionalText(value, 'key');
      const rawSite = value.site;
      return {
        kind,
        op: osOp(value, 'op'),
        args: list(value, 'args'),
        ...(key !== undefined ? { key } : {}),
        ...(rawSite !== undefined ? { site: decodeSite(rawSite) } : {}),
      };
    }
    case 'oauth': {
      const principal = optionalText(value, 'principal');
      return { kind, ask: decodeOAuthAsk(field(value, 'ask')), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'credentialStatus':
    case 'credentialForget': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'credentialStoreList':
    case 'credentialStoreRotate':
    case 'credentialModeRead':
      return { kind };
    case 'credentialStoreRead':
    case 'credentialStoreRemove':
      return { kind, name: text(value, 'name') };
    case 'credentialStoreWrite':
      return { kind, service: text(value, 'service'), name: text(value, 'name'), value: text(value, 'value') };
    case 'credentialModeWrite':
      return { kind, mode: text(value, 'mode') };
    case 'httpBeacon': {
      const key = optionalText(value, 'key');
      const rawSite = value.site;
      return {
        kind,
        request: decodeHttpRequest(field(value, 'request')),
        ...(key !== undefined ? { key } : {}),
        ...(rawSite !== undefined ? { site: decodeSite(rawSite) } : {}),
      };
    }
    case 'pageFacts':
      return { kind, fields: list(value, 'fields').map(pageFactField) };
    case 'deliver': {
      const key = optionalText(value, 'key');
      return { kind, envelope: decodeEnvelope(field(value, 'envelope')), ...(key !== undefined ? { key } : {}), site: decodeSite(field(value, 'site')) };
    }
    default:
      return assertNever(kind);
  }
}

function decodePending(value: JsonValue): PendingRequestWire {
  if (!isRecord(value)) throw new Error('kernel wire: a pending request is not an object');
  return { id: whole(value, 'id'), request: decodeRequest(field(value, 'request')) };
}

/**
 * `clientEffects` and `clientEffectsByTrait` are one list seen twice (same length and order, 1:1 by index):
 * the flat array holds the very effect each frame carries, as the JS runtime builds them.
 */
function withSharedEffects(response: OrbitalEventResponse): OrbitalEventResponse {
  const frames = response.clientEffectsByTrait;
  if (frames === undefined || response.clientEffects?.length !== frames.length) return response;
  return { ...response, clientEffects: frames.map((frame) => frame.effect) };
}

export function decodeProgress(json: string): ServerProgressWire {
  const value: JsonValue = JSON.parse(json);
  if (!isRecord(value)) throw new Error('kernel wire: progress is not an object');
  const status = text(value, 'status');
  if (status === 'done') {
    const response = field(value, 'response');
    if (!isEventResponse(response)) throw new Error('kernel wire: "response" is not an event response');
    return { status, response: withSharedEffects(response) };
  }
  if (status === 'await') {
    return { status, flight: whole(value, 'flight'), requests: list(value, 'requests').map(decodePending) };
  }
  throw new Error(`kernel wire: unknown status "${status}"`);
}

export function decodeResolveProgress(json: string): ResolveProgressWire {
  const value: JsonValue = JSON.parse(json);
  if (!isRecord(value)) throw new Error('kernel wire: resolve progress is not an object');
  const status = text(value, 'status');
  if (status === 'done') {
    const rows: EntityRow[] = list(value, 'rows').map((row) => {
      if (!isRecord(row)) throw new Error('kernel wire: a resolved row is not an object');
      return row;
    });
    const total = field(value, 'total');
    if (typeof total !== 'number') throw new Error('kernel wire: "total" is not a number');
    return { status, rows, total };
  }
  if (status === 'await') {
    return { status, flight: whole(value, 'flight'), requests: list(value, 'requests').map(decodePending) };
  }
  throw new Error(`kernel wire: unknown status "${status}"`);
}

function recordOf(value: JsonValue | undefined, what: string): JsonObject {
  if (value === undefined || !isJsonObject(value)) throw new Error(`${what} is not an object`);
  return value;
}

function oauthText(source: JsonObject, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new Error(`driver oauth ask: \`${key}\` is not text`);
  return value;
}

function oauthNumber(source: JsonObject, key: string): number {
  const value = source[key];
  if (typeof value !== 'number') throw new Error(`driver oauth ask: \`${key}\` is not a number`);
  return value;
}

function oauthNullableText(source: JsonObject, key: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  return oauthText(source, key);
}

function oauthProvider(source: JsonObject): 'google' | 'github' | 'auth0' {
  const value = source.provider;
  if (value === 'google' || value === 'github' || value === 'auth0') return value;
  throw new Error('driver oauth ask: `provider` is not google, github or auth0');
}

function oauthTextList(source: JsonObject, key: string): string[] | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`driver oauth ask: \`${key}\` is not a list of text`);
  return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
}

/** The driver's `oauth` ask, decoded against the closed ask set before it reaches the host's store. */
export function decodeOAuthAsk(value: JsonValue | undefined): OAuthAsk {
  const ask = recordOf(value, 'the oauth ask');
  switch (ask.ask) {
    case 'pendingPut': {
      const grant = recordOf(ask.grant, 'the pending grant');
      if (typeof ask.ttlMs !== 'number') throw new Error('driver oauth ask: `ttlMs` is not a number');
      return {
        ask: 'pendingPut',
        state: oauthText(ask, 'state'),
        ttlMs: ask.ttlMs,
        grant: {
          provider: oauthText(grant, 'provider'),
          redirectUri: oauthText(grant, 'redirectUri'),
          verifier: oauthText(grant, 'verifier'),
          subject: oauthNullableText(grant, 'subject'),
          scopes: oauthTextList(grant, 'scopes') ?? [],
        },
      };
    }
    case 'pendingTake':
      return { ask: 'pendingTake', state: oauthText(ask, 'state') };
    case 'connectionAvailable':
      return { ask: 'connectionAvailable' };
    case 'connectionSave': {
      const grant = recordOf(ask.grant, 'the token grant');
      if (typeof grant.expiresIn !== 'number') throw new Error('driver oauth ask: `expiresIn` is not a number');
      return {
        ask: 'connectionSave',
        provider: oauthProvider(ask),
        grant: {
          accessToken: oauthText(grant, 'accessToken'),
          refreshToken: oauthNullableText(grant, 'refreshToken'),
          expiresIn: grant.expiresIn,
          tokenType: oauthText(grant, 'tokenType'),
          scope: oauthTextList(grant, 'scope'),
          subject: oauthNullableText(grant, 'subject'),
        },
      };
    }
    case 'connectionStatus':
      return { ask: 'connectionStatus', provider: oauthProvider(ask) };
    case 'connectionRemove':
      return { ask: 'connectionRemove', provider: oauthProvider(ask) };
    case 'subjectRemember':
      return { ask: 'subjectRemember', accessToken: oauthText(ask, 'accessToken'), subject: oauthText(ask, 'subject') };
    case 'subjectLookup':
      return { ask: 'subjectLookup', accessToken: oauthText(ask, 'accessToken') };
    case 'subjectForget':
      return { ask: 'subjectForget', accessToken: oauthText(ask, 'accessToken') };
    case 'metadataGet':
      return { ask: 'metadataGet', issuer: oauthText(ask, 'issuer') };
    case 'metadataPut':
      return { ask: 'metadataPut', issuer: oauthText(ask, 'issuer'), metadata: recordOf(ask.metadata, 'the metadata') };
    case 'clock':
      return { ask: 'clock' };
    case 'mockTokenPut':
      return { ask: 'mockTokenPut', accessToken: oauthText(ask, 'accessToken'), refreshToken: oauthText(ask, 'refreshToken'), expiresAtMs: oauthNumber(ask, 'expiresAtMs'), provider: oauthProvider(ask) };
    case 'mockTokenRefresh':
      return { ask: 'mockTokenRefresh', refreshToken: oauthText(ask, 'refreshToken'), newAccessToken: oauthText(ask, 'newAccessToken'), expiresAtMs: oauthNumber(ask, 'expiresAtMs') };
    case 'mockTokenRevoke':
      return { ask: 'mockTokenRevoke', token: oauthText(ask, 'token') };
    case 'mockTokenCheck':
      return { ask: 'mockTokenCheck', accessToken: oauthText(ask, 'accessToken') };
    case 'consent':
      return { ask: 'consent', authUrl: oauthText(ask, 'authUrl'), state: oauthText(ask, 'state'), redirectUri: oauthText(ask, 'redirectUri') };
    default:
      throw new Error(`driver oauth ask "${String(ask.ask)}" is unknown`);
  }
}

