import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExternalOrbitalLoader } from '../src/loader/external-loader.js';
import { HttpLoader } from '../src/loader/http-loader.js';
import { UnifiedLoader } from '../src/loader/unified-loader.js';
import type { DeclaredTraitConfig } from '@almadar/core';

// R-ORBITAL-IMPORT-SCHEMA-CONFIG-RUNG-USES-CONSUMER: `loadOrbital` must carry
// the loaded schema's OWN app-level `config` forward as `schemaConfig`, so a
// later consumer resolves the upstream orbital's traits against the schema
// that declared them, never the importing app's config.

const TEST_CONFIG: DeclaredTraitConfig = {
  theme: { type: 'string', default: 'dark' },
};

function buildSchemaJson(config?: DeclaredTraitConfig) {
  return {
    name: 'test-schema',
    orbitals: [
      {
        name: 'TestOrbital',
        entity: { name: 'Thing', fields: [{ name: 'id', type: 'string' }] },
        traits: [],
        pages: [],
      },
    ],
    ...(config ? { config } : {}),
  };
}

describe('ExternalOrbitalLoader.loadOrbital — schemaConfig', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('carries the schema\'s declared config as schemaConfig', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almadar-loader-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'schema.orb'),
      JSON.stringify(buildSchemaJson(TEST_CONFIG))
    );

    const loader = new ExternalOrbitalLoader({ basePath: tmpDir });
    const result = await loader.loadOrbital('./schema.orb');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toEqual(TEST_CONFIG);
  });

  it('omits schemaConfig when the schema declares no config', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almadar-loader-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'schema.orb'),
      JSON.stringify(buildSchemaJson())
    );

    const loader = new ExternalOrbitalLoader({ basePath: tmpDir });
    const result = await loader.loadOrbital('./schema.orb');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toBeUndefined();
    expect('schemaConfig' in result.data).toBe(false);
  });
});

describe('HttpLoader.loadOrbital — schemaConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(config?: DeclaredTraitConfig) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(buildSchemaJson(config)),
      }))
    );
  }

  it('carries the schema\'s declared config as schemaConfig', async () => {
    stubFetch(TEST_CONFIG);
    const loader = new HttpLoader({ basePath: 'https://example.com/schemas' });
    const result = await loader.loadOrbital('./schema.orb');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toEqual(TEST_CONFIG);
  });

  it('omits schemaConfig when the schema declares no config', async () => {
    stubFetch();
    const loader = new HttpLoader({ basePath: 'https://example.com/schemas' });
    const result = await loader.loadOrbital('./schema.orb');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toBeUndefined();
    expect('schemaConfig' in result.data).toBe(false);
  });
});

describe('UnifiedLoader.loadOrbital — schemaConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(config?: DeclaredTraitConfig) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(buildSchemaJson(config)),
      }))
    );
  }

  it('carries the schema\'s declared config as schemaConfig (named orbital)', async () => {
    stubFetch(TEST_CONFIG);
    const loader = new UnifiedLoader({
      basePath: 'https://example.com/schemas',
      forceLoader: 'http',
    });
    const result = await loader.loadOrbital('./schema.orb', 'TestOrbital');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toEqual(TEST_CONFIG);
  });

  it('omits schemaConfig when the schema declares no config (default orbital)', async () => {
    stubFetch();
    const loader = new UnifiedLoader({
      basePath: 'https://example.com/schemas',
      forceLoader: 'http',
    });
    const result = await loader.loadOrbital('./schema.orb');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.schemaConfig).toBeUndefined();
    expect('schemaConfig' in result.data).toBe(false);
  });
});
