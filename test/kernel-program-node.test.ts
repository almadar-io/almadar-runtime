// The Node program host: a `.lolo` program composing std-llm runs on the kernel engine, the transport is a fake fetch
// (recorded exchange), and the dispatch returns the program's external emits.
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isJsonObject, type EventPayload, type JsonValue } from '@almadar/core';
import { emitPayload, KernelProgram, resolveProgramFile, type ProgramRun } from '../src/kernel/program-node.js';
import { kernelWorkspaceHost } from '../src/kernel/workspace-node.js';
import type { PinnedInit } from '../src/kernel/http-exchange.js';
import { memorySecrets } from './helpers/fake-http-kernel.js';
import { KERNEL_DIR, NATIVE_ADDON } from './helpers/kernel-module.js';
import type { OrbitalSchema } from '@almadar/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.lolo`, import.meta.url));
const program = fixture('embed-lmstudio');

interface Sent { url: string; body: string }

function transport(status: number, reply: string) {
  const sent: Sent[] = [];
  return {
    sent,
    http: {
      secrets: memorySecrets({}),
      fetch: async (url: URL, init: PinnedInit) => {
        sent.push({ url: url.href, body: init.body === undefined ? '' : new TextDecoder().decode(init.body) });
        return new Response(reply, { status, headers: [['content-type', 'application/json']] });
      },
      resolve: async (host: string) => ({ literal: true, addresses: [host] }),
    },
  };
}

function vectors(payload: EventPayload): number[][] {
  const rows = payload.embeddings;
  if (!Array.isArray(rows)) throw new Error('no embeddings');
  return rows.map((row) => (Array.isArray(row) ? row.map((n) => (typeof n === 'number' ? n : NaN)) : []));
}

function code(payload: EventPayload): string {
  return typeof payload.code === 'string' ? payload.code : '';
}

describe.skipIf(KERNEL_DIR === undefined)('kernel program host', () => {
  let open: KernelProgram | undefined;
  afterEach(() => { open?.close(); open = undefined; });

  async function startFile(name: string, http: NonNullable<Parameters<typeof KernelProgram.open>[1]['http']>): Promise<KernelProgram> {
    open?.close();
    open = await KernelProgram.open(await resolveProgramFile(fixture(name)), { kernelDir: KERNEL_DIR ?? '', http });
    return open;
  }

  const start = (http: ReturnType<typeof transport>['http']): Promise<KernelProgram> => startFile('embed-lmstudio', http);

  it('embeds texts through std-llm on the local embedder and returns LLM_EMBED_RESULT', async () => {
    const t = transport(200, JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } }));
    const run: ProgramRun = await (await start(t.http)).dispatch('EmbedOrbital', 'LLM_EMBED', { texts: ['alpha', 'beta'] });
    expect(run.success).toBe(true);
    expect(emitPayload(run, 'LLM_EMBED_RESULT', vectors)).toEqual([[1, 0], [0, 1]]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].url).toBe('http://127.0.0.1:1234/v1/embeddings');
    const body: JsonValue = JSON.parse(t.sent[0].body);
    expect(isJsonObject(body) && body.model).toBe('text-embedding-bge-base-en-v1.5');
    expect(isJsonObject(body) && body.input).toEqual(['alpha', 'beta']);
  });

  it('control: a provider failure ends in LLM_FAILED and no result', async () => {
    const t = transport(400, JSON.stringify({ error: { message: 'bad model' } }));
    const run = await (await start(t.http)).dispatch('EmbedOrbital', 'LLM_EMBED', { texts: ['alpha'] });
    expect(emitPayload(run, 'LLM_EMBED_RESULT', vectors)).toBeUndefined();
    expect(emitPayload(run, 'LLM_FAILED', code)).not.toBeUndefined();
  });

  describe('std-llm image parts', () => {
    const generate = async (images: Array<{ mediaType: string; data: string }> | undefined): Promise<{ content: JsonValue; run: ProgramRun }> => {
      const t = transport(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      const run = await (await startFile('vision-lmstudio', t.http)).dispatch('VisionOrbital', 'LLM_GENERATE', { userPrompt: 'grade', ...(images !== undefined ? { images } : {}) });
      const body: JsonValue = JSON.parse(t.sent[0].body);
      const messages = isJsonObject(body) ? body.messages : null;
      const user = Array.isArray(messages) ? messages[1] : null;
      return { content: isJsonObject(user) ? user.content : null, run };
    };

    it('sends an OpenAI-compatible text part then an image_url data URL', async () => {
      const { content, run } = await generate([{ mediaType: 'image/png', data: 'AAAA' }]);
      expect(content).toEqual([{ type: 'text', text: 'grade' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
      expect(emitPayload(run, 'LLM_GENERATE_RESULT', (payload) => payload.content)).toBe('ok');
    });

    it('control: without images the user message stays a plain string', async () => {
      expect((await generate(undefined)).content).toBe('grade');
    });
  });

  describe('std-llm extract maxTokens', () => {
    const extract = async (maxTokens: number | undefined): Promise<JsonValue> => {
      const t = transport(200, JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      const run = await (await startFile('vision-lmstudio', t.http)).dispatch('VisionOrbital', 'LLM_EXTRACT', { text: 'x', schema: '{}', ...(maxTokens !== undefined ? { maxTokens } : {}) });
      expect(emitPayload(run, 'LLM_EXTRACT_RESULT', (payload) => payload.json)).toBe('{"a":1}');
      const body: JsonValue = JSON.parse(t.sent[0].body);
      return isJsonObject(body) ? body.max_tokens : null;
    };

    it('sends the caller\'s maxTokens', async () => {
      expect(await extract(777)).toBe(777);
    });

    it('control: without maxTokens the request carries no limit', async () => {
      expect(await extract(undefined)).toBeUndefined();
    });
  });

  describe('std-image', () => {
    const image = async (file: string, payload: Record<string, JsonValue>, replies: Array<{ status: number; body: string }>): Promise<{ sent: string[]; run: ProgramRun }> => {
      const sent: string[] = [];
      let i = 0;
      const http = {
        secrets: memorySecrets({ OPEN_ROUTER_API_KEY: 'sk-test' }),
        fetch: async (url: URL, init: PinnedInit) => {
          sent.push(`${init.method} ${url.href} ${init.body === undefined ? '' : new TextDecoder().decode(init.body)}`);
          const reply = replies[Math.min(i++, replies.length - 1)];
          return new Response(reply.body, { status: reply.status, headers: [['content-type', 'application/json']] });
        },
        resolve: async (host: string) => ({ literal: host.startsWith('127.'), addresses: [host.startsWith('127.') ? host : '93.184.216.34'] }),
      };
      const run = await (await startFile(file, http)).dispatch('ProbeOrbital', 'IMAGE_GENERATE', payload);
      return { sent, run };
    };
    const done = { status: 200, body: JSON.stringify({ data: [{ b64_json: 'QUJD' }], usage: { cost: 0.5, total_tokens: 3 } }) };

    it('local img2img posts the shim body with references and strength', async () => {
      const { sent, run } = await image('image-local', { prompt: 'a cat', model: 'flux2-klein', references: [{ url: 'data:image/png;base64,AAAA' }], strength: 0.5 }, [done]);
      expect(sent).toEqual([`POST http://127.0.0.1:8180/v1/images/generations ${JSON.stringify({ image_strength: 0.5, input_references: [{ image_url: { url: 'data:image/png;base64,AAAA' }, type: 'image_url' }], model: 'flux2-klein', prompt: 'a cat' })}`]);
      expect(emitPayload(run, 'IMAGE_GENERATED', (payload) => payload.images)).toEqual([{ data: 'QUJD', mediaType: 'image/png' }]);
    });

    it('openrouter retries a 503 once and then answers', async () => {
      const { sent, run } = await image('image-openrouter', { prompt: 'a cat' }, [{ status: 503, body: 'busy' }, done]);
      expect(sent).toHaveLength(2);
      expect(emitPayload(run, 'IMAGE_GENERATED', (payload) => payload.totalTokens)).toBe(3);
    });

    it('control: the local server is never retried', async () => {
      const { sent, run } = await image('image-local', { prompt: 'a cat' }, [{ status: 503, body: 'busy' }, done]);
      expect(sent).toHaveLength(1);
      expect(emitPayload(run, 'IMAGE_FAILED', (payload) => payload.message)).toContain('local returned 503');
    });

    it('size with resolution is refused before any send', async () => {
      const { sent, run } = await image('image-openrouter', { prompt: 'a cat', size: '512x512', resolution: '1K' }, [done]);
      expect(sent).toHaveLength(0);
      expect(emitPayload(run, 'IMAGE_FAILED', (payload) => payload.code)).toBe('VALIDATION_ERROR');
    });
  });
});

describe.skipIf(KERNEL_DIR === undefined || NATIVE_ADDON === undefined)('kernel engines: the wasm module and the native add-on run one program to the same emits', () => {
  const engines = ['wasm', 'native'] as const;
  let open: KernelProgram | undefined;
  afterEach(() => { open?.close(); open = undefined; });

  async function run(engine: (typeof engines)[number], file: string, http: ReturnType<typeof transport>['http'], event: string, payload: EventPayload): Promise<ProgramRun> {
    open?.close();
    open = await KernelProgram.open(await resolveProgramFile(fixture(file)), {
      engine,
      ...(KERNEL_DIR !== undefined ? { kernelDir: KERNEL_DIR } : {}),
      ...(NATIVE_ADDON !== undefined ? { nativeAddon: NATIVE_ADDON } : {}),
      http,
    });
    return open.dispatch('EmbedOrbital', event, payload);
  }

  const reply = JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });

  it('answers the http ask of std-llm identically on both engines', async () => {
    const runs: ProgramRun[] = [];
    for (const engine of engines) {
      const t = transport(200, reply);
      const result = await run(engine, 'embed-lmstudio', t.http, 'LLM_EMBED', { texts: ['alpha', 'beta'] });
      expect(emitPayload(result, 'LLM_EMBED_RESULT', vectors), engine).toEqual([[1, 0], [0, 1]]);
      expect(t.sent.map((s) => s.url), engine).toEqual(['http://127.0.0.1:1234/v1/embeddings']);
      runs.push(result);
    }
    expect(runs[1].emits).toEqual(runs[0].emits);
  });

  it('control: a provider failure ends in LLM_FAILED on both engines, with the same emits', async () => {
    const runs: ProgramRun[] = [];
    for (const engine of engines) {
      const result = await run(engine, 'embed-lmstudio', transport(400, JSON.stringify({ error: { message: 'bad model' } })).http, 'LLM_EMBED', { texts: ['alpha'] });
      expect(emitPayload(result, 'LLM_EMBED_RESULT', vectors), engine).toBeUndefined();
      expect(emitPayload(result, 'LLM_FAILED', code), engine).not.toBeUndefined();
      runs.push(result);
    }
    expect(runs[1].emits).toEqual(runs[0].emits);
  });

  describe('os asks under the program grants', () => {
    const programReading = (dir: string, path: string): OrbitalSchema => ({
      name: 'App',
      osGrants: { fs: [{ glob: `${dir}/**`, modes: ['read'] }] },
      orbitals: [{
        name: 'Main',
        entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'Reader',
          linkedEntity: 'Job',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
            transitions: [{ from: 'idle', to: 'done', event: 'READ', effects: [['os/read-file', path, { emit: { success: 'OK', failure: 'BAD' } }]] }],
          },
        }],
      }],
    });

    it('reads a granted file and refuses a path outside the grants, the same on both engines', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kernel-engines-')));
      try {
        writeFileSync(join(dir, 'a.txt'), 'hello');
        const emitted: Array<{ granted: ProgramRun; outside: ProgramRun }> = [];
        for (const engine of engines) {
          const results: ProgramRun[] = [];
          for (const path of [join(dir, 'a.txt'), '/etc/hosts']) {
            open?.close();
            open = await KernelProgram.open(programReading(dir, path), {
              engine,
              os: true,
              ...(KERNEL_DIR !== undefined ? { kernelDir: KERNEL_DIR } : {}),
              ...(NATIVE_ADDON !== undefined ? { nativeAddon: NATIVE_ADDON } : {}),
            });
            results.push(await open.dispatch('Main', 'READ', {}, 'Reader'));
          }
          const [granted, outside] = results;
          expect(emitPayload(granted, 'OK', (p) => p.data), engine).toBe('aGVsbG8=');
          expect(emitPayload(outside, 'BAD', (p) => p.kind), engine).toBe('denied');
          emitted.push({ granted, outside });
        }
        expect(emitted[1].granted.emits).toEqual(emitted[0].granted.emits);
        expect(emitted[1].outside.emits.map((e) => e.event)).toEqual(emitted[0].outside.emits.map((e) => e.event));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe.skipIf(KERNEL_DIR === undefined)('kernel workspace host: std-workspace as the program host\'s workspaces', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  // orb resolves std node-style from the project, so the project lives under this package.
  const project = (): string => {
    const base = fileURLToPath(new URL('./.tmp-workspace-host', import.meta.url));
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'p-'));
    dirs.push(dir, base);
    return dir;
  };
  const host = (dir: string) => kernelWorkspaceHost({ projectRoot: dir, ...(KERNEL_DIR !== undefined ? { kernel: { kernelDir: KERNEL_DIR } } : {}) });

  it('writes a file as the caller, snapshots it, and lists the snapshot back', async () => {
    const dir = project();
    const ws = await host(dir).open('app-1', { principal: 'user-a' });
    await ws.writeFile('orbitals/HelloApp.orb', '{"name":"HelloApp"}');
    expect(readFileSync(join(ws.workDir, 'orbitals/HelloApp.orb'), 'utf8')).toBe('{"name":"HelloApp"}');
    const snap = await ws.snapshot('program/eval HelloApp');
    expect(snap?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect((await ws.listSnapshots()).map((s) => s.reason)).toContain('program/eval HelloApp');
  });

  it('control: a workspace is the caller\'s own, and a second snapshot with nothing changed commits nothing', async () => {
    const dir = project();
    const h = host(dir);
    const a = await h.open('app-1', { principal: 'user-a' });
    const b = await h.open('app-1', { principal: 'user-b' });
    expect(a.workDir).not.toBe(b.workDir);
    await a.writeFile('orbitals/X.orb', '{}');
    await a.snapshot('first');
    expect(await a.snapshot('again')).toBeNull();
    expect(await b.listSnapshots()).toEqual([]);
  });

  it('control: a path that escapes the workspace is refused and nothing is written', async () => {
    const dir = project();
    const ws = await host(dir).open('app-1', { principal: 'user-a' });
    await expect(ws.writeFile('../escape.orb', '{}')).rejects.toThrow(/sandbox/);
    expect(existsSync(join(dir, 'workspaces', 'user-a', 'escape.orb'))).toBe(false);
  });

  it('control: a call without a signed-in caller is refused before any program opens', async () => {
    const dir = project();
    await expect(host(dir).open('app-1', {})).rejects.toThrow(/signed-in/);
  });

  describe('bucket mode: std-workspace over std-storage on an S3-compatible endpoint', () => {
    const ENDPOINT = 'http://s3.workspace.test:9000';
    const BUCKET = 'ws-bucket';
    const xml = (text: string): string => text.replace(/&/g, '&amp;');

    function s3() {
      const objects = new Map<string, Uint8Array>();
      const seen: Array<{ method: string; url: string; authorized: boolean }> = [];
      const fetch = async (url: URL, init: PinnedInit): Promise<Response> => {
        const method = init.method;
        const authorization = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
        seen.push({ method, url: url.href, authorized: authorization.startsWith('AWS4-HMAC-SHA256') && authorization.includes('Credential=hmac-key-id/') });
        const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
        if (method === 'PUT') { objects.set(key, init.body ?? new Uint8Array()); return new Response('', { status: 200, headers: [['etag', '"x"']] }); }
        if (method === 'DELETE') { objects.delete(key); return new Response('', { status: 204 }); }
        if (url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') ?? '';
          const contents = [...objects.entries()].filter(([name]) => name.startsWith(prefix))
            .map(([name, body]) => `<Contents><Key>${xml(name)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>${body.byteLength}</Size></Contents>`).join('');
          return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, { status: 200, headers: [['content-type', 'application/xml']] });
        }
        const found = objects.get(key);
        return found === undefined
          ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: [['content-type', 'application/xml']] })
          : new Response(found, { status: 200 });
      };
      return { objects, seen, fetch };
    }

    const bucketHost = (dir: string, fetch: (url: URL, init: PinnedInit) => Promise<Response>, secrets: Record<string, string>) =>
      kernelWorkspaceHost({
        projectRoot: dir,
        bucket: { name: BUCKET, endpoint: ENDPOINT, region: 'auto', accessKeyId: 'ALMADAR_WORKSPACE_HMAC_KEY_ID', secretAccessKey: 'ALMADAR_WORKSPACE_HMAC_SECRET' },
        kernel: { ...(KERNEL_DIR !== undefined ? { kernelDir: KERNEL_DIR } : {}), http: { secrets: memorySecrets(secrets), fetch, resolve: async (host: string) => ({ literal: true, addresses: [host] }) } },
      });
    const KEYS = { ALMADAR_WORKSPACE_HMAC_KEY_ID: 'hmac-key-id', ALMADAR_WORKSPACE_HMAC_SECRET: 'hmac-secret' };

    it('mirrors a write into the bucket under the owner path, signed with the HMAC key, at the same local path as disk mode', async () => {
      const dir = project();
      const bucket = s3();
      const ws = await bucketHost(dir, bucket.fetch, KEYS).open('app-1', { principal: 'user-a' });
      await ws.writeFile('orbitals/HelloApp.orb', '{"name":"HelloApp"}');
      await ws.snapshot('program/eval HelloApp');
      expect(ws.workDir).toBe(join(dir, 'workspaces', 'user-a', 'app-1'));
      expect(readFileSync(join(ws.workDir, 'orbitals/HelloApp.orb'), 'utf8')).toBe('{"name":"HelloApp"}');
      expect(new TextDecoder().decode(bucket.objects.get('workspaces/user-a/app-1/files/orbitals/HelloApp.orb'))).toContain('HelloApp');
      expect([...bucket.objects.keys()].some((key) => key.startsWith('workspaces/user-a/app-1/history/'))).toBe(true);
      expect(bucket.seen.length).toBeGreaterThan(0);
      expect(bucket.seen.every((call) => call.url.startsWith(`${ENDPOINT}/${BUCKET}/`) && call.authorized)).toBe(true);
    });

    it('control: a cold cache is restored from the bucket', async () => {
      const first = project();
      const bucket = s3();
      const a = await bucketHost(first, bucket.fetch, KEYS).open('app-1', { principal: 'user-a' });
      await a.writeFile('orbitals/HelloApp.orb', '{"name":"HelloApp"}');
      await a.snapshot('first');
      const second = project();
      const b = await bucketHost(second, bucket.fetch, KEYS).open('app-1', { principal: 'user-a' });
      expect((await b.listSnapshots()).map((s) => s.reason)).toContain('first');
      expect(readFileSync(join(b.workDir, 'orbitals/HelloApp.orb'), 'utf8')).toBe('{"name":"HelloApp"}');
    });

    it('control: without the HMAC credentials the write fails and nothing reaches the bucket', async () => {
      const dir = project();
      const bucket = s3();
      const ws = await bucketHost(dir, bucket.fetch, {}).open('app-1', { principal: 'user-a' });
      await expect(ws.writeFile('orbitals/HelloApp.orb', '{}')).rejects.toThrow();
      expect([...bucket.objects.keys()].some((key) => key.includes('/files/orbitals/'))).toBe(false);
    });
  });
});
