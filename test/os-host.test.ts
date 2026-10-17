// The Node `os` answerer against the twin host fixture (test/fixtures/os-asks.json). The same fixture is replayed by the
// native os_host (orbital-core runtime); both must give these answers. The grant ports below are test doubles of the
// wasm kernel's exports: they evaluate only the fixture's grants (a `<dir>/**` glob or an exact entry), the product check is Rust.
import { createServer, type Server } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { JsonValue, OrbitalSchema } from '@almadar/core';
import { isJsonObject } from '@almadar/core';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { createNodeOsHost } from '../src/kernel/os-node.js';
import { kernelOsCompletions, kernelOsGrants, type OsCompletionPort, type OsGrantPort, type OsRequirement } from '../src/kernel/os-port.js';
import { KERNEL_DIR, loadKernel } from './helpers/kernel-module.js';
import type { CallSiteWire, IoRequestWire } from '../src/kernel/wire.js';
import type { DeferredCallOutcome } from '../src/kernel/host.js';

type FixtureValue = string | number | boolean | null | FixtureValue[] | { [key: string]: FixtureValue };

interface Step {
  name: string;
  op: string;
  args: FixtureValue[];
  key?: string;
  bind?: Record<string, string>;
  deferred?: 'pending' | { event: string; payload: FixtureValue };
  cancel?: string;
  cancelled?: boolean;
  expect: { ok: FixtureValue } | { error: { kind: string; message?: string; messagePrefix?: string } };
}

interface Fired {
  event: string;
  payload: JsonValue;
}

const ROUTED_SITE: CallSiteWire = { trait: 'Sup', followOn: false, emit: { success: 'DONE', failure: 'FAILED' } };

/** The completions a host dispatched as events of their own, awaited by key. */
class Dispatched {
  private readonly arrived = new Map<string, Fired>();
  private readonly waiting = new Map<string, (fired: Fired) => void>();

  readonly sink = (call: DeferredCallOutcome): void => {
    const payload: JsonValue = JSON.parse(JSON.stringify(call.payload ?? null));
    const key = isJsonObject(payload) && typeof payload.key === 'string' ? payload.key : '';
    const fired = { event: call.event, payload };
    const waiter = this.waiting.get(key);
    if (waiter !== undefined) {
      this.waiting.delete(key);
      waiter(fired);
    } else this.arrived.set(key, fired);
  };

  has(key: string): boolean {
    return this.arrived.has(key);
  }

  next(key: string): Promise<Fired> {
    const held = this.arrived.get(key);
    if (held !== undefined) {
      this.arrived.delete(key);
      return Promise.resolve(held);
    }
    return new Promise<Fired>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no completion for key ${key}`)), 10000);
      this.waiting.set(key, (fired) => {
        clearTimeout(timer);
        resolve(fired);
      });
    });
  }
}

interface FixtureGrants {
  fs?: Array<{ glob: string; modes: string[] }>;
  exec?: string[];
  net?: Array<{ target: string; kinds: string[] }>;
  env?: string[];
  stdio?: string[];
  sys?: string[];
  desktop?: string[];
}

interface Fixture {
  grants: FixtureGrants;
  steps: Step[];
}

const fixtureText = readFileSync(new URL('./fixtures/os-asks.json', import.meta.url), 'utf8');

function substitute(value: FixtureValue, vars: Map<string, FixtureValue>): FixtureValue {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z]+)\}/g, (_, name: string) => String(vars.get(name)));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value !== null && typeof value === 'object') {
    const named = value['$var'];
    if (typeof named === 'string' && Object.keys(value).length === 1) return vars.get(named) ?? null;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  }
  return value;
}

function matches(actual: JsonValue, expected: FixtureValue): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected['$number'] === true) return typeof actual === 'number';
    if (!isJsonObject(actual)) return false;
    const keys = Object.keys(expected);
    return keys.length === Object.keys(actual).length && keys.every((key) => key in actual && matches(actual[key], expected[key]));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matches(actual[i], item));
  }
  return actual === expected;
}

function fixtureGrants(grants: FixtureGrants): OsGrantPort {
  const subtree = (glob: string, path: string): boolean => {
    const at = normalize(path);
    if (!glob.endsWith('/**')) return at === glob;
    const base = glob.slice(0, -3);
    return at === base || at.startsWith(`${base}/`);
  };
  return {
    allows(need: OsRequirement): boolean {
      switch (need.need) {
        case 'fs':
          return need.path.startsWith('/') && (grants.fs ?? []).some((g) => g.modes.includes(need.mode) && subtree(g.glob, need.path));
        case 'exec':
          return (grants.exec ?? []).includes(need.command);
        case 'net':
          return (grants.net ?? []).some((g) => need.kinds.some((kind) => g.kinds.includes(kind)) && g.target === `${need.host}:${need.port}`);
        case 'env':
          return (grants.env ?? []).includes(need.name);
        case 'stdio':
          return (grants.stdio ?? []).includes(need.kind);
        case 'sys':
          return (grants.sys ?? []).includes(need.kind);
        case 'desktop':
          return (grants.desktop ?? []).includes(need.kind);
      }
    },
    globMatches: (glob, path) => subtree(glob, path),
    isPublicAddress: (ip) => ip !== '127.0.0.1' && ip !== '::1',
  };
}

function hostPorts(os: KernelHostPorts['os'], deferral?: { completions: OsCompletionPort; dispatched: Dispatched }): KernelHostPorts {
  return {
    persistence: new InMemoryPersistence(),
    callService: async () => null,
    programEffect: () => undefined,
    inFlightCalls: new InFlightCalls(),
    servicePorts: () => { throw new Error('unused'); },
    deliverLive: () => undefined,
    deferCallOutcome: () => deferral?.dispatched.sink,
    ...(deferral !== undefined ? { osCompletions: deferral.completions } : {}),
    ...(os !== undefined ? { os } : {}),
  };
}

function osAsk(op: string, args: JsonValue[], key?: string): IoRequestWire {
  return { kind: 'os', op: op as Extract<IoRequestWire, { kind: 'os' }>['op'], args, ...(key !== undefined ? { key, site: ROUTED_SITE } : {}) };
}

let tmp = '';
let echo: Server;
let port = 0;
let closedPort = 0;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'os-host-')));
  echo = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
  const spareAddress = spare.address();
  closedPort = typeof spareAddress === 'object' && spareAddress !== null ? spareAddress.port : 0;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

async function replayFixture(makeGrants: (grants: FixtureGrants) => OsGrantPort, completions?: OsCompletionPort): Promise<void> {
  const vars = new Map<string, FixtureValue>([['tmp', tmp], ['port', port], ['closedPort', closedPort]]);
  const fixture: Fixture = JSON.parse(fixtureText);
  const grants = substitute(fixture.grants as FixtureValue, vars) as FixtureGrants;
  const os = createNodeOsHost(makeGrants(grants));
  const dispatched = new Dispatched();
  const ports = hostPorts(os, completions !== undefined ? { completions, dispatched } : undefined);
  let replayed = 0;
  try {
    for (const step of fixture.steps) {
      replayed += 1;
      const keyed = step.key !== undefined || step.deferred !== undefined || step.cancel !== undefined;
      if (keyed && completions === undefined) continue;
      if (step.cancel !== undefined) {
        expect(os.cancel?.(step.cancel), step.name).toBe(step.cancelled);
        continue;
      }
      const args = step.args.map((arg) => substitute(arg, vars)) as JsonValue[];
      const answer = await answerRequest(ports, osAsk(step.op, args, step.key), { orbital: 'Main' });
      if (step.deferred !== undefined) {
        expect(answer, step.name).toEqual({ kind: 'serviceDeferred' });
        if (step.deferred !== 'pending' && step.key !== undefined) {
          const fired = await dispatched.next(step.key);
          const want = substitute(step.deferred as FixtureValue, vars) as FixtureValue;
          expect(matches({ event: fired.event, payload: fired.payload }, want), `${step.name}: ${JSON.stringify(fired)}`).toBe(true);
        }
        continue;
      }
      if (answer.kind !== 'os') throw new Error(`${step.name}: answered ${answer.kind}`);
      const expected = substitute(step.expect as FixtureValue, vars) as Step['expect'];
      if ('ok' in expected) {
        expect('ok' in answer.result, `${step.name}: ${JSON.stringify(answer.result)}`).toBe(true);
        if (!('ok' in answer.result)) continue;
        expect(matches(answer.result.ok, expected.ok), `${step.name}: ${JSON.stringify(answer.result.ok)}`).toBe(true);
        for (const [name, field] of Object.entries(step.bind ?? {})) {
          const ok = answer.result.ok;
          if (isJsonObject(ok)) vars.set(name, ok[field] as FixtureValue);
        }
      } else {
        expect('error' in answer.result, `${step.name}: ${JSON.stringify(answer.result)}`).toBe(true);
        if (!('error' in answer.result)) continue;
        const failure = answer.result.error;
        expect(failure.kind, step.name).toBe(expected.error.kind);
        if (expected.error.message !== undefined) expect(failure.message, step.name).toBe(expected.error.message);
        if (expected.error.messagePrefix !== undefined) expect(failure.message.startsWith(expected.error.messagePrefix), `${step.name}: ${failure.message}`).toBe(true);
      }
    }
  } finally {
    os.close();
  }
  expect(replayed).toBe(fixture.steps.length);
  expect(replayed).toBeGreaterThan(70);
}

describe('clock ask', () => {
  it('is answered from the host clock port, and from the system clock without one (control)', async () => {
    const ask: IoRequestWire = { kind: 'clock' };
    const fixed = await answerRequest({ ...hostPorts(undefined), now: () => 1_700_000_000_123 }, ask, { orbital: 'Main' });
    expect(fixed).toEqual({ kind: 'clock', result: { ok: 1_700_000_000_123 } });
    const before = Date.now();
    const system = await answerRequest(hostPorts(undefined), ask, { orbital: 'Main' });
    expect(system.kind === 'clock' && 'ok' in system.result && system.result.ok >= before).toBe(true);
  });
});

describe('os host', () => {
  it('answers an os ask through the Node port instead of unsupported', async () => {
    const os = createNodeOsHost(fixtureGrants({}));
    const answer = await answerRequest(hostPorts(os), osAsk('os/pid', []), { orbital: 'Main' });
    expect(answer).toEqual({ kind: 'os', result: { ok: { pid: process.pid } } });
    os.close();
  });

  it('refuses what the kernel grants do not allow, naming the op (control)', async () => {
    const os = createNodeOsHost(fixtureGrants({}));
    const answer = await answerRequest(hostPorts(os), osAsk('os/read-file', ['/etc/hostname']), { orbital: 'Main' });
    expect(answer).toEqual({ kind: 'os', result: { error: { kind: 'denied', message: 'os/read-file: /etc/hostname is not granted for Read' } } });
    os.close();
  });

  it('asks the kernel for exactly the grant each op needs', async () => {
    const asked: OsRequirement[] = [];
    const grants = fixtureGrants({ exec: ['echo'] });
    const os = createNodeOsHost({ ...grants, allows: (need) => { asked.push(need); return grants.allows(need); } });
    const answer = await os.answer('os/spawn', ['echo', ['x']]);
    expect(answer).toEqual({ ok: { pid: expect.any(Number) } });
    expect(asked).toEqual([{ need: 'exec', command: 'echo' }]);
    os.close();
  });

  it('answers denied with no os host configured, as the native host does with none', async () => {
    const answer = await answerRequest(hostPorts(undefined), osAsk('os/read-file', ['/data/a']), { orbital: 'Main' });
    expect(answer).toEqual({ kind: 'os', result: { error: { kind: 'denied', message: 'os/read-file: no os host configured' } } });
  });

  it('replays the twin fixture with the answers the native host gives', () => replayFixture(fixtureGrants), 60000);

  it.skipIf(KERNEL_DIR === undefined)('replays the twin fixture with the grants decided by the wasm kernel', async () => {
    const kernel = await loadKernel();
    let server: InstanceType<typeof kernel.Server> | undefined;
    try {
      await replayFixture((grants) => {
        const program: OrbitalSchema = {
          name: 'os-twin',
          version: '1.0.0',
          osGrants: grants as NonNullable<OrbitalSchema['osGrants']>,
          orbitals: [{ name: 'Main', pages: [], entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] }, traits: [] }],
        };
        server = new kernel.Server(JSON.stringify(program));
        return kernelOsGrants(kernel, () => {
          if (server === undefined) throw new Error('the kernel server is not open');
          return server;
        });
      }, kernelOsCompletions(kernel));
    } finally {
      server?.free();
    }
  }, 60000);

  it.skipIf(KERNEL_DIR === undefined)('keeps two keyed reads on two pipes outstanding together while a child fills its stderr first', async () => {
    const kernel = await loadKernel();
    const dispatched = new Dispatched();
    const os = createNodeOsHost(fixtureGrants({ exec: ['sh'] }));
    const ports = hostPorts(os, { completions: kernelOsCompletions(kernel), dispatched });
    const ask = (op: string, args: JsonValue[], key?: string) => answerRequest(ports, osAsk(op, args, key), { orbital: 'Main' });
    const spawned = async (script: string): Promise<{ pid: number; stdout: number; stderr: number }> => {
      const answer = await ask('os/spawn', ['sh', ['-c', script], { stdout: 'pipe', stderr: 'pipe' }]);
      if (answer.kind !== 'os' || !('ok' in answer.result) || !isJsonObject(answer.result.ok)) throw new Error(`spawn: ${JSON.stringify(answer)}`);
      const { pid, stdout, stderr } = answer.result.ok;
      if (typeof pid !== 'number' || typeof stdout !== 'number' || typeof stderr !== 'number') throw new Error('spawn: no pid and pipes');
      return { pid, stdout, stderr };
    };
    try {
      const silent = await spawned('sleep 30');
      const noisy = await spawned('head -c 200000 /dev/zero >&2; echo out');
      expect(await ask('os/read', [silent.stdout, 64], 'quiet')).toEqual({ kind: 'serviceDeferred' });
      expect(await ask('os/read', [noisy.stderr, 65536], 'err')).toEqual({ kind: 'serviceDeferred' });
      expect(await ask('os/read', [noisy.stdout, 64], 'out')).toEqual({ kind: 'serviceDeferred' });
      const out = await dispatched.next('out');
      expect(out).toEqual({ event: 'DONE', payload: { data: Buffer.from('out\n').toString('base64'), eof: false, key: 'out' } });
      const err = await dispatched.next('err');
      expect(err.event).toBe('DONE');
      expect(isJsonObject(err.payload) && typeof err.payload.data === 'string' && err.payload.data.length > 0).toBe(true);
      expect(dispatched.has('quiet'), 'control: the read of the silent pipe is still outstanding').toBe(false);
      expect(os.cancel?.('quiet')).toBe(true);
    } finally {
      os.close();
    }
  }, 30000);

  it('answers a keyed read in place when the host has no completion sink (control)', async () => {
    const os = createNodeOsHost(fixtureGrants({ exec: ['echo'] }));
    const ports = hostPorts(os);
    const spawned = await answerRequest(ports, osAsk('os/spawn', ['echo', ['hi'], { stdout: 'pipe' }]), { orbital: 'Main' });
    if (spawned.kind !== 'os' || !('ok' in spawned.result) || !isJsonObject(spawned.result.ok)) throw new Error(`spawn: ${JSON.stringify(spawned)}`);
    const read = await answerRequest(ports, osAsk('os/read', [spawned.result.ok.stdout, 64], 'k'), { orbital: 'Main' });
    expect(read).toEqual({ kind: 'os', result: { ok: { data: Buffer.from('hi\n').toString('base64'), eof: false } } });
    os.close();
  });
});
