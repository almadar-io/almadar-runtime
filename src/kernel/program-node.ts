/**
 * Node-only: run one `.lolo`/`.orb` program on the kernel engine and read what it emits. The program's own atoms
 * (for example `std-llm`) do the work; this host answers the `http`, secret and `os` asks and nothing else.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { EmittedEvent, EntityRow, EventPayload, InboundAnswer, InboundDelivery, OrbitalSchema, TransitionRejection, UserContext } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { InFlightCalls } from '../effects/in-flight-calls.js';
import { dispatchInbound } from '../evaluation/inbound-dispatch.js';
import { resolveOrbBinary } from '../host/program/index.js';
import { tickEventKey } from '../traits/state-book.js';
import { KernelEngine } from './engine.js';
import type { KernelHostPorts } from './host.js';
import type { KernelModule } from './wire.js';
import { createHttpPorts, type HttpPorts, type HttpPortsOptions } from './http-exchange.js';
import { kernelOsGrants } from './os-port.js';
import type { OsHostPort } from './os-port.js';
import { loadHttpKernel, loadKernelModule, loadNativeKernelModule, resolveNativeAddon, type LoadedKernel } from './load-node.js';

export interface KernelProgramOptions {
  /** Which kernel runs the program: the WebAssembly module (default; the only one in a browser) or the native add-on. The host's ports are the same for both. */
  engine?: 'wasm' | 'native';
  /** The native kernel add-on (`kernel.node`); absent, `resolveNativeAddon()`. Used only by `engine: 'native'`. */
  nativeAddon?: string;
  /**
   * Environment variables selecting the store the native kernel answers its own row asks from (`DATA_BACKEND`,
   * `NODE_ENV`, `DATABASE_URL`, `COUCHDB_URL`, the Firebase variables); the host's in-memory store is then never asked.
   * Needs `engine: 'native'`; absent, the host's in-memory store answers.
   */
  store?: Readonly<Record<string, string>>;
  /** The directory of the built `@almadar/kernel` package (the one holding `pkg/`); absent, `resolveKernelDir()`. */
  kernelDir?: string;
  /** Where the installed `@almadar/core` and `@almadar/std` are found, node-style (default: the working directory). */
  languageFrom?: string;
  /** Transport overrides of the `http` effect: pinned fetch, address resolver, secret store. */
  http?: Pick<HttpPortsOptions, 'fetch' | 'resolve' | 'secrets' | 'random'>;
  /** Rows the program's in-memory store starts with, by entity name (a catalog the host already holds). */
  seed?: Record<string, EntityRow[]>;
  /** Answer the program's `os` effects with the Node host (its grants are the program's own); absent, every `os` ask is denied. */
  os?: boolean;
}

export interface ProgramRun {
  success: boolean;
  /** Every event the dispatch emitted, in order: the program's `-> external` results among them. */
  emits: EmittedEvent[];
  /** Why a transition or one of its effects did not run (an `effect-failed` carries the error); empty when all ran. */
  rejections: TransitionRejection[];
  error?: string;
}

/** `ALMADAR_KERNEL_DIR`, else the `@almadar/kernel` package that `from` (default: the working directory) resolves. */
export function resolveKernelDir(from: string = process.cwd()): string {
  const named = process.env.ALMADAR_KERNEL_DIR;
  if (named !== undefined && named !== '') return named;
  const entry = createRequire(join(resolve(from), 'resolve.js')).resolve('@almadar/kernel');
  return dirname(dirname(entry));
}

/** The payload of the first emit named `event`, read through `read`; `undefined` when the run emitted none. */
export function emitPayload<T>(run: ProgramRun, event: string, read: (payload: EventPayload) => T): T | undefined {
  const found = run.emits.find((emit) => emit.event === event);
  return found === undefined ? undefined : read(found.payload ?? {});
}

/**
 * `orb resolve`: the program with every `uses` flattened, as the kernel engine takes it. `orb` is the binary to run,
 * by default the one `resolveOrbBinary` picks.
 */
export async function resolveProgramFile(path: string, cwd: string = dirname(resolve(path)), orb: string = resolveOrbBinary(cwd)): Promise<OrbitalSchema> {
  const absolute = resolve(path);
  return new Promise<OrbitalSchema>((done, fail) => {
    const child = spawn(orb, ['resolve', absolute], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`orb resolve ${absolute} exited ${code}: ${Buffer.concat(err).toString('utf8')}`));
        return;
      }
      const text = Buffer.concat(out).toString('utf8');
      done(JSON.parse(text.slice(text.indexOf('{'))));
    });
  });
}

export class KernelProgram {
  private constructor(
    private readonly engine: KernelEngine,
    private readonly os: OsHostPort | undefined,
    private readonly schema: OrbitalSchema,
    private readonly http: HttpPorts,
    private readonly persistence: InMemoryPersistence,
  ) {}

  static async open(schema: OrbitalSchema, options: KernelProgramOptions): Promise<KernelProgram> {
    const languageFrom = options.languageFrom !== undefined ? { languageFrom: options.languageFrom } : {};
    const native = options.engine === 'native';
    if (options.store !== undefined && !native) throw new Error("KernelProgram: `store` needs engine: 'native'");
    if (options.store !== undefined && options.seed !== undefined) throw new Error('KernelProgram: `seed` fills the host store, which `store` replaces');
    const addon: LoadedKernel | undefined = native ? await loadNativeKernelModule(options.nativeAddon ?? resolveNativeAddon(), languageFrom) : undefined;
    const kernelDir = addon === undefined ? (options.kernelDir ?? resolveKernelDir()) : '';
    const kernel: KernelModule = addon ?? (await loadKernelModule(kernelDir, languageFrom));
    const http = createHttpPorts({
      kernel: addon !== undefined ? async () => addon : () => loadHttpKernel(kernelDir, languageFrom),
      ...options.http,
      egress: schema.egress ?? [],
    });
    const persistence = new InMemoryPersistence();
    if (options.seed !== undefined) persistence.seed(options.seed);
    let engine: KernelEngine | undefined;
    const requireEngine = (): KernelEngine => {
      if (engine === undefined) throw new Error('KernelProgram: an os ask arrived before the program opened');
      return engine;
    };
    const os = options.os === true ? (await import('./os-node.js')).createNodeOsHost(kernelOsGrants(kernel, requireEngine)) : undefined;
    const ports: KernelHostPorts = {
      persistence,
      callService: async () => null,
      programEffect: () => undefined,
      inFlightCalls: new InFlightCalls(),
      servicePorts: (caller, _user, message) => ({ caller, message, inputs: () => [], readableEntities: () => [], dispatchInput: async () => { throw new Error('KernelProgram has no input channel'); }, read: async () => [] }),
      deliverLive: () => undefined,
      deferCallOutcome: () => undefined,
      http,
      ...(os !== undefined ? { os } : {}),
    };
    engine = KernelEngine.open(kernel, schema, ports, options.store);
    return new KernelProgram(engine, os, schema, http, persistence);
  }

  /** Fire `event` at the orbital as `user` (the program's `@user`), wait for its whole cascade (every `http` ask included), and return what it emitted. */
  async dispatch(orbital: string, event: string, payload: EventPayload = {}, targetTrait?: string, user?: UserContext): Promise<ProgramRun> {
    const response = await this.engine.evaluate(
      orbital,
      { event, payload, ...(targetTrait !== undefined ? { targetTrait } : {}), ...(user !== undefined ? { user } : {}) },
      { orbital, ...(user !== undefined ? { user } : {}) },
    );
    return {
      success: response.success,
      emits: response.emittedEvents,
      rejections: response.rejections ?? [],
      ...(response.error !== undefined ? { error: response.error } : {}),
    };
  }

  /** Fire `trait`'s tick `name` once, as a host timer would; the kernel evaluates the tick's guard and effects. */
  async tick(orbital: string, trait: string, name: string): Promise<ProgramRun> {
    const response = await this.engine.evaluate(orbital, { event: tickEventKey(name), runTick: { trait, tick: name }, targetTrait: trait }, { orbital });
    return {
      success: response.success,
      emits: response.emittedEvents,
      rejections: response.rejections ?? [],
      ...(response.error !== undefined ? { error: response.error } : {}),
    };
  }

  /** Deliver an `/api/hooks/<name>` request to the program and return the answer it gave (EXEC-INBOUND-1). */
  async deliverInbound(name: string, delivery: InboundDelivery): Promise<InboundAnswer> {
    return dispatchInbound(this.schema, name, delivery, (orbital, request) => this.engine.evaluate(orbital, request, { orbital }), (credential) => this.http.secrets.get(credential, undefined));
  }

  /** The rows the host's in-memory store holds for `entity` (empty when the native kernel keeps its own `store`). */
  async rows(entity: string): Promise<EntityRow[]> {
    return this.persistence.list(entity);
  }

  close(): void {
    this.os?.close();
    this.engine.dispose();
  }
}
