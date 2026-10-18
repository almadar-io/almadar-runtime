import type { OnDeviceModelPort } from '@almadar/core';
import { ChromePortError, cancelled, isAborted } from './errors.js';

/** A Prompt API session. */
export interface ChromeModelSession {
  prompt(text: string, options: { responseConstraint: object; signal?: AbortSignal }): Promise<string>;
  clone(): Promise<ChromeModelSession>;
  destroy(): void;
}

/** Chrome's built-in Prompt API (`LanguageModel`). */
export interface ChromeLanguageModel {
  availability(): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  create(): Promise<ChromeModelSession>;
}

/** How long one prompt may run. Chrome's model service occasionally never answers a prompt; without a deadline that stalls every call queued behind it. */
export const PROMPT_TIMEOUT_MS = 30_000;

export interface ChromePromptModelOptions {
  timeoutMs?: number;
}

/**
 * Chrome's Prompt API behind the on-device model port, looked up at each call (the model can arrive
 * after start); an absent API reads as unavailable.
 */
export function chromePromptModel(lookup: () => ChromeLanguageModel | undefined, options: ChromePromptModelOptions = {}): OnDeviceModelPort {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS;
  let base: Promise<ChromeModelSession> | undefined;
  return {
    availability: async () => {
      const lm = lookup();
      return lm ? lm.availability() : 'unavailable';
    },
    prompt: async (text, schema, signal) => {
      const lm = lookup();
      if (!lm) throw new ChromePortError('This browser has no Prompt API', 'MODEL_UNAVAILABLE');
      if (isAborted(signal)) throw cancelled();
      // One base session, cloned per prompt: each prompt starts clean without paying for a new session.
      base ??= lm.create();
      let session: ChromeModelSession;
      try {
        session = await (await base).clone();
      } catch (err) {
        base = undefined;
        throw err;
      }
      if (isAborted(signal)) {
        session.destroy();
        throw cancelled();
      }
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onCallerAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ChromePortError(`The on-device model did not answer within ${timeoutMs}ms`, 'TIMEOUT_ERROR', { timeoutMs }));
          abort.abort();
        }, timeoutMs);
        onCallerAbort = () => {
          reject(cancelled());
          abort.abort();
        };
        signal?.addEventListener('abort', onCallerAbort, { once: true });
      });
      try {
        return await Promise.race([session.prompt(text, { responseConstraint: schema, signal: abort.signal }), stopped]);
      } finally {
        clearTimeout(timer);
        if (onCallerAbort !== undefined) signal?.removeEventListener('abort', onCallerAbort);
        session.destroy();
      }
    },
  };
}
