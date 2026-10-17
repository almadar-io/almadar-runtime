/**
 * `browser/prompt` and `browser/embed`: the host's on-device model and embedder behind one contract, shared by the
 * interpreter (`EffectExecutor`) and the kernel host (`answerRequest`). A host with no port fails `unconfigured`, a
 * model that cannot answer now fails `unavailable`, and one that errors fails `failed`.
 */
import type { OnDeviceFailureKind, OnDeviceFailurePayload, OnDeviceModelPorts } from '@almadar/core';
import type { EffectHandlers } from '../types.js';

export const NO_ON_DEVICE_MODEL = 'browser/prompt: no on-device model is wired into this host';
export const NO_ON_DEVICE_EMBEDDER = 'browser/embed: no on-device embedder is wired into this host';

/** An on-device call that gave no answer; `payload` is what the failure route receives. */
export class OnDeviceModelFailure extends Error {
  readonly kind: OnDeviceFailureKind;
  readonly payload: OnDeviceFailurePayload;

  constructor(kind: OnDeviceFailureKind, message: string, key: string | null) {
    super(message);
    this.name = 'OnDeviceModelFailure';
    this.kind = kind;
    this.payload = { error: message, kind, key };
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reply text of one prompt; the schema text must be a JSON object. */
export async function promptOnDevice(
  ports: OnDeviceModelPorts | undefined,
  text: string,
  schemaText: string,
  key: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const model = ports?.model;
  if (model === undefined) throw new OnDeviceModelFailure('unconfigured', NO_ON_DEVICE_MODEL, key);
  let schema: object;
  try {
    const parsed: unknown = JSON.parse(schemaText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    schema = parsed;
  } catch {
    throw new OnDeviceModelFailure('failed', 'browser/prompt: the response schema must be JSON Schema text: a JSON object', key);
  }
  try {
    const state = await model.availability();
    if (state !== 'available') throw new OnDeviceModelFailure('unavailable', `The on-device model is ${state}`, key);
    return await model.prompt(text, schema, signal);
  } catch (error) {
    if (error instanceof OnDeviceModelFailure) throw error;
    throw new OnDeviceModelFailure('failed', failureMessage(error), key);
  }
}

/** One vector per text, in input order; an empty list is answered without asking the embedder. */
export async function embedOnDevice(
  ports: OnDeviceModelPorts | undefined,
  texts: readonly string[],
  key: string | null,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embedder = ports?.embedder;
  if (embedder === undefined) throw new OnDeviceModelFailure('unconfigured', NO_ON_DEVICE_EMBEDDER, key);
  try {
    return await embedder.embed([...texts], signal);
  } catch (error) {
    throw new OnDeviceModelFailure('failed', failureMessage(error), key);
  }
}

/** The `browserPrompt` and `browserEmbed` handlers over a host's ports; absent ports answer `unconfigured`. */
export function onDeviceHandlers(ports: OnDeviceModelPorts | undefined): Pick<EffectHandlers, 'browserPrompt' | 'browserEmbed'> {
  return {
    browserPrompt: (text, schemaText, key, signal) => promptOnDevice(ports, text, schemaText, key, signal),
    browserEmbed: (texts, key, signal) => embedOnDevice(ports, texts, key, signal),
  };
}
