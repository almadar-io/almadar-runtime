/**
 * `transformersEmbedder` adapts an injected feature-extraction pipeline to the on-device embedder
 * port behind `browser/embed`: loaded once, on first use.
 */
import { describe, it, expect } from 'vitest';
import { transformersEmbedder, type FeatureExtractor } from '../src/host/chrome/index.js';
import { ChromePortError } from '../src/host/chrome/index.js';

async function codeOf(p: Promise<object>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof ChromePortError ? err.code : 'not an ChromePortError';
  }
  return 'resolved';
}

describe('transformersEmbedder', () => {
  function pipelineFake() {
    const runs: Array<{ texts: string[]; options: { pooling: 'mean'; normalize: true } }> = [];
    let loads = 0;
    const extractor: FeatureExtractor = async (texts, options) => {
      runs.push({ texts, options });
      return { tolist: () => texts.map((_, i) => [i, 0.5]) };
    };
    return { runs, loads: () => loads, load: async () => { loads += 1; return extractor; } };
  }

  it('prefixes every text, asks for mean-pooled normalized vectors, and returns them', async () => {
    const fake = pipelineFake();
    const port = transformersEmbedder(fake.load, { prefix: 'query: ' });
    expect(await port.embed(['a', 'b'])).toEqual([[0, 0.5], [1, 0.5]]);
    expect(fake.runs).toEqual([{ texts: ['query: a', 'query: b'], options: { pooling: 'mean', normalize: true } }]);
  });

  it('loads the pipeline once, on first use', async () => {
    const fake = pipelineFake();
    const port = transformersEmbedder(fake.load);
    expect(fake.loads()).toBe(0);
    await port.embed(['a']);
    await port.embed(['b']);
    expect(fake.loads()).toBe(1);
    expect(fake.runs.map((r) => r.texts)).toEqual([['a'], ['b']]);
  });

  it('edge: a failed load is tried again on the next call, not kept', async () => {
    const fake = pipelineFake();
    let fail = true;
    const port = transformersEmbedder(async () => {
      if (fail) throw new Error('offline');
      return fake.load();
    });
    await expect(port.embed(['a'])).rejects.toThrow('offline');
    fail = false;
    expect(await port.embed(['a'])).toEqual([[0, 0.5]]);
  });

  it('edge: an aborted signal stops before loading or running', async () => {
    const fake = pipelineFake();
    const abort = new AbortController();
    abort.abort();
    expect(await codeOf(transformersEmbedder(fake.load).embed(['a'], abort.signal))).toBe('CANCELLED');
    expect(fake.loads()).toBe(0);
  });
});
