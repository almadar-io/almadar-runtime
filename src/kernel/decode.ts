/** Decoders for what the kernel hands back as JSON: narrowed by checks, never cast. */
import { OrbitalEventResponseSchema, RowQuerySchema, RowWriteBatchSchema, type EntityRow, type JsonValue, type OrbitalEventResponse } from '@almadar/core';
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

export function decodeRequest(value: JsonValue): IoRequestWire {
  if (!isRecord(value)) throw new Error('kernel wire: a request is not an object');
  const kind = text(value, 'kind');
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
      return {
        kind,
        request: decodeHttpRequest(field(value, 'request')),
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
    case 'secret': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'secretSet': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), value: text(value, 'value'), ttlMs: whole(value, 'ttlMs'), ...(principal !== undefined ? { principal } : {}) };
    }
    case 'random':
      return { kind, bytes: whole(value, 'bytes') };
    case 'credentialStatus':
    case 'credentialForget': {
      const principal = optionalText(value, 'principal');
      return { kind, name: text(value, 'name'), ...(principal !== undefined ? { principal } : {}) };
    }
    default:
      throw new Error(`kernel wire: unknown request kind "${kind}"`);
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
    return { status, response: withSharedEffects(OrbitalEventResponseSchema.parse(field(value, 'response'))) };
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
