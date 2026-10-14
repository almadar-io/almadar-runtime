/** Decoders for what the kernel hands back as JSON: narrowed by checks, never cast. */
import { OrbitalEventResponseSchema, type JsonValue, type OrbitalEventResponse } from '@almadar/core';
import type { CallSiteWire, IoRequestWire, PendingRequestWire, ServerProgressWire } from './wire.js';

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

export function decodeRequest(value: JsonValue): IoRequestWire {
  if (!isRecord(value)) throw new Error('kernel wire: a request is not an object');
  const kind = text(value, 'kind');
  switch (kind) {
    case 'readRow':
      return { kind, entityType: text(value, 'entityType'), id: text(value, 'id') };
    case 'listRows':
      return { kind, entityType: text(value, 'entityType') };
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
