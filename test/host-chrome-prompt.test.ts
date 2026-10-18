// @vitest-environment jsdom
/** The Chrome Prompt API behind the on-device model port, run against a fake of the Chrome surface it uses. */
import { describe, it, expect } from 'vitest';
import { chromePromptModel, ChromePortError, type ChromeLanguageModel, type ChromeModelSession } from '../src/host/chrome/index.js';

describe('chromePromptModel', () => {
  it('reports availability and prompts with the response constraint', async () => {
    const calls: Array<{ text: string; constraint: object }> = [];
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async () => {
        const session: ChromeModelSession = {
          prompt: async (text, opts) => {
            calls.push({ text, constraint: opts.responseConstraint });
            return '{"ok":true}';
          },
          clone: async () => session,
          destroy: () => undefined,
        };
        return session;
      },
    };
    const model = chromePromptModel(() => lm);
    expect(await model.availability()).toBe('available');
    expect(await model.prompt('hi', { type: 'object' })).toBe('{"ok":true}');
    expect(calls).toEqual([{ text: 'hi', constraint: { type: 'object' } }]);
  });

  it('control: no Prompt API at all reads as unavailable', async () => {
    expect(await chromePromptModel(() => undefined).availability()).toBe('unavailable');
  });

  it('edge: a model that becomes available after start (downloaded, installed) is used from then on', async () => {
    let lm: ChromeLanguageModel | undefined;
    const model = chromePromptModel(() => lm);
    expect(await model.availability()).toBe('unavailable');
    const session: ChromeModelSession = { prompt: async () => '{}', clone: async () => session, destroy: () => undefined };
    lm = { availability: async () => 'available', create: async () => session };
    expect(await model.availability()).toBe('available');
  });

  const hangingModel = (honorsAbort: boolean) => {
    const seen = { destroyed: 0, aborted: false };
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async () => {
        const session: ChromeModelSession = {
          prompt: (_text, opts) => new Promise<string>((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              seen.aborted = true;
              if (honorsAbort) reject(new DOMException('aborted', 'AbortError'));
            });
          }),
          clone: async () => session,
          destroy: () => { seen.destroyed++; },
        };
        return session;
      },
    };
    return { lm, seen };
  };

  it('a prompt that never answers fails at the deadline as TIMEOUT_ERROR, aborting and destroying its session', async () => {
    const { lm, seen } = hangingModel(true);
    const err = await chromePromptModel(() => lm, { timeoutMs: 30 }).prompt('hi', {}).catch((e: ChromePortError) => e);
    expect(err).toBeInstanceOf(ChromePortError);
    expect((err as ChromePortError).code).toBe('TIMEOUT_ERROR');
    expect(seen).toEqual({ destroyed: 1, aborted: true });
  });

  it('edge: a prompt that ignores the abort still fails at the deadline (the caller is never held)', async () => {
    const { lm, seen } = hangingModel(false);
    const started = Date.now();
    const err = await chromePromptModel(() => lm, { timeoutMs: 30 }).prompt('hi', {}).catch((e: ChromePortError) => e);
    expect((err as ChromePortError).code).toBe('TIMEOUT_ERROR');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen.destroyed).toBe(1);
  });

  it('control: an answer before the deadline comes back and nothing is aborted', async () => {
    let signal: AbortSignal | undefined;
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async () => {
        const session: ChromeModelSession = { prompt: async (_t, opts) => { signal = opts.signal; return '{"ok":1}'; }, clone: async () => session, destroy: () => undefined };
        return session;
      },
    };
    expect(await chromePromptModel(() => lm, { timeoutMs: 1000 }).prompt('hi', {})).toBe('{"ok":1}');
    await new Promise((r) => setTimeout(r, 1100));
    expect(signal?.aborted).toBe(false);
  });
});

describe('chromePromptModel sessions and cancel', () => {
  function cloningModel(answer: (signal: AbortSignal | undefined) => Promise<string>) {
    const seen = { created: 0, cloned: 0, destroyed: 0, baseDestroyed: 0 };
    const session = (base: boolean) => ({
      prompt: (_text: string, opts: { responseConstraint: object; signal?: AbortSignal }) => answer(opts.signal),
      clone: async () => { seen.cloned++; return session(false); },
      destroy: () => { if (base) seen.baseDestroyed++; else seen.destroyed++; },
    });
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async () => { seen.created++; return session(true); },
    };
    return { lm, seen };
  }

  it('creates the base session once and clones it for each prompt, destroying each clone', async () => {
    const { lm, seen } = cloningModel(async () => '{}');
    const model = chromePromptModel(() => lm);
    await model.prompt('a', {});
    await model.prompt('b', {});
    expect(seen).toEqual({ created: 1, cloned: 2, destroyed: 2, baseDestroyed: 0 });
  });

  it('a caller abort fails the prompt as CANCELLED, not as a timeout', async () => {
    const { lm } = cloningModel((signal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const abort = new AbortController();
    const pending = chromePromptModel(() => lm, { timeoutMs: 5000 }).prompt('a', {}, abort.signal).catch((e: ChromePortError) => e);
    abort.abort();
    expect(((await pending) as ChromePortError).code).toBe('CANCELLED');
  });

  it('edge: when cloning fails the base is dropped, the prompt fails, and the next prompt creates a fresh base', async () => {
    let failClone = true;
    const seen = { created: 0 };
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async () => {
        seen.created++;
        return {
          prompt: async () => '{}',
          clone: async () => {
            if (failClone) throw new Error('the model service restarted');
            return { prompt: async () => '{"ok":1}', clone: async () => { throw new Error('unused'); }, destroy: () => undefined };
          },
          destroy: () => undefined,
        };
      },
    };
    const model = chromePromptModel(() => lm);
    await expect(model.prompt('a', {})).rejects.toThrow(/restarted/);
    failClone = false;
    expect(await model.prompt('b', {})).toBe('{"ok":1}');
    expect(seen.created).toBe(2);
  });
});
