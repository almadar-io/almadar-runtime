/**
 * The on-device text embedder behind `browser/embed`. The host injects the library (the
 * chrome-extension shell passes transformers.js), so the browser entry stays dependency-free.
 */
import type { OnDeviceEmbedderPort } from '@almadar/core';
import { cancelled, isAborted } from './errors.js';

export type { OnDeviceEmbedderPort };

/** A feature-extraction pipeline, as transformers.js returns it. */
export type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: true }) => Promise<{ tolist(): number[][] }>;

export interface TransformersEmbedderOptions {
  /** Prepended to every text (e5 models expect `query: `). */
  prefix?: string;
}

/** An embedder over a feature-extraction pipeline, loaded on first use; a failed load is retried on the next call. */
export function transformersEmbedder(load: () => Promise<FeatureExtractor>, options: TransformersEmbedderOptions = {}): OnDeviceEmbedderPort {
  const prefix = options.prefix ?? '';
  let loading: Promise<FeatureExtractor> | undefined;
  return {
    async embed(texts, signal) {
      if (isAborted(signal)) throw cancelled();
      loading ??= load().catch((err: Error) => {
        loading = undefined;
        throw err;
      });
      const extract = await loading;
      if (isAborted(signal)) throw cancelled();
      const output = await extract(texts.map((t) => prefix + t), { pooling: 'mean', normalize: true });
      return output.tolist();
    },
  };
}
