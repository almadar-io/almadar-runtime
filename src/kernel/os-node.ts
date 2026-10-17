/**
 * The Node answerer of the kernel's `os` asks: the fs, process and net families on Node `fs`, `child_process`,
 * `net`, `dgram` and `dns`, with the native host's answer shapes, error kinds, timeouts and handle model
 * (`orbital-core` `os_host`). It holds no logic beyond the raw port: every grant decision is the kernel's,
 * reached through `OsGrantPort`. Import it only from a Node entry point (`@almadar/runtime/kernelOsNode`); the
 * browser bundle never carries it.
 */
import type { JsonValue } from '@almadar/core';
import type { OsError, OsOp, Settled } from '@almadar/core/kernel-wire';
import { FsOps, isFsOp } from './os-node-fs.js';
import { isNetOp, NetOps } from './os-node-net.js';
import { isProcessOp, ProcessOps } from './os-node-process.js';
import { isSysOp, SysOps } from './os-node-sys.js';
import { invalid, osFailure, OsFailure, OsState, type Deferral } from './os-node-support.js';
import type { OsGrantPort, OsHostPort } from './os-port.js';

export { kernelOsCompletions, kernelOsGrants } from './os-port.js';
export type { OsCompletionEvent, OsCompletionMatchers, OsCompletionPort, OsGrantKernel, OsGrantMatchers, OsGrantPort, OsHostPort, OsRequirement } from './os-port.js';

function failureOf(op: OsOp, raised: unknown): OsError {
  if (raised instanceof OsFailure) return raised.error;
  return { kind: 'io', message: `${op}: ${raised instanceof Error ? raised.message : String(raised)}` };
}

class NodeOsHost implements OsHostPort {
  private readonly state = new OsState();
  private readonly fs: FsOps;
  private readonly process: ProcessOps;
  private readonly net: NetOps;
  private readonly sys: SysOps;

  constructor(grants: OsGrantPort) {
    this.fs = new FsOps(this.state, grants);
    this.process = new ProcessOps(this.state, grants);
    this.net = new NetOps(this.state, grants);
    this.sys = new SysOps(grants);
  }

  private async dispatch(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    if (op === 'os/close') {
      if (this.fs.closeOwned(args) || this.net.closeOwned(args)) return {};
      throw osFailure('closed', op, 'not an open handle');
    }
    if (isFsOp(op)) return this.fs.run(op, args);
    if (isProcessOp(op)) return this.process.run(op, args);
    if (isNetOp(op)) return this.net.run(op, args);
    if (isSysOp(op)) return this.sys.run(op);
    throw osFailure('unsupported', op, 'this host does not implement the operation yet');
  }

  async answer(op: OsOp, args: JsonValue[]): Promise<Settled<JsonValue, OsError>> {
    try {
      return { ok: await this.dispatch(op, args) };
    } catch (raised) {
      return { error: failureOf(op, raised) };
    }
  }

  private deferral(op: OsOp, args: JsonValue[]): Deferral {
    switch (op) {
      case 'os/wait':
        return this.process.waitLater(args);
      case 'os/read':
        return this.fs.readLater(op, args);
      case 'os/recv':
        return this.net.recvLater(op, args);
      case 'os/recvfrom':
        return this.net.recvfromLater(op, args);
      default:
        throw osFailure('unsupported', op, 'this operation does not defer its completion');
    }
  }

  /** `Completions::run_later`: the checks fail in place, the wait runs in the background and its outcome goes to `deliver` unless the key is cancelled first. */
  defer(op: OsOp, args: JsonValue[], key: string, deliver: (outcome: Settled<JsonValue, OsError>) => void): Settled<null, OsError> {
    let blocking: Deferral;
    try {
      blocking = this.deferral(op, args);
    } catch (raised) {
      return { error: failureOf(op, raised) };
    }
    if (!this.state.completions.begin(key)) return { error: failureOf(op, invalid(op, `key ${key} already has a completion pending`)) };
    const finish = (build: () => JsonValue): void => {
      if (!this.state.completions.claim(key)) return;
      try {
        deliver({ ok: build() });
      } catch (raised) {
        deliver({ error: failureOf(op, raised) });
      }
    };
    blocking().then(finish, (raised: unknown) => finish(() => { throw raised; }));
    return { ok: null };
  }

  cancel(key: string): boolean {
    return this.state.completions.cancel(key);
  }

  close(): void {
    this.state.close();
  }
}

/** One program instance's `os` host: its own handle tables, closed by `close`. */
export function createNodeOsHost(grants: OsGrantPort): OsHostPort {
  return new NodeOsHost(grants);
}
