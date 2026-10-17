/**
 * The `process` family on Node `child_process`: spawn, wait, kill, pids, environment and stdio. It mirrors
 * `os_host/process.rs` of the native host. `os/wait` answers in place unless the host defers a keyed ask
 * (`waitLater`); the watch ops and `os/stdin-read` are the native `unsupported` or not yet
 * answered here, as `answer` says.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { isatty } from 'node:tty';
import type { JsonObject, JsonValue } from '@almadar/core';
import type { OsOp } from '@almadar/core/kernel-wire';
import type { OsGrantPort, OsStdioKind } from './os-port.js';
import {
  argBytes,
  argI64,
  argOpt,
  argStr,
  ByteSource,
  denied,
  errnoCode,
  invalid,
  osFailure,
  processFailure,
  type ChildEntry,
  type Deferral,
  type ExitInfo,
  type OsState,
} from './os-node-support.js';

const PROCESS_OPS: ReadonlySet<OsOp> = new Set<OsOp>([
  'os/spawn', 'os/wait', 'os/kill', 'os/pid', 'os/ppid', 'os/watch-process', 'os/watch-signal', 'os/getenv', 'os/setenv',
  'os/unsetenv', 'os/environ', 'os/watch-env', 'os/stdin-read', 'os/stdout-write', 'os/stderr-write', 'os/isatty', 'os/tty-size',
]);

export function isProcessOp(op: OsOp): boolean {
  return PROCESS_OPS.has(op);
}

const PIPE_HIGH_WATER = 1024 * 1024;

type StdioMode = 'inherit' | 'pipe' | 'null';

const SIGNALS: Record<string, number> = constants.signals;

const SIGNAL_SET: ReadonlyArray<readonly [string, number]> = ['TERM', 'KILL', 'INT', 'HUP', 'QUIT', 'USR1', 'USR2', 'STOP', 'CONT'].map(
  (name) => [name, SIGNALS[`SIG${name}`]] as const,
);

function validEnvName(name: string): boolean {
  return name !== '' && !name.includes('=') && !name.includes('\0');
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ProcessOps {
  constructor(private readonly state: OsState, private readonly grants: OsGrantPort) {}

  private lookupEnv(name: string): string | null {
    if (this.state.env.has(name)) return this.state.env.get(name) ?? null;
    return process.env[name] ?? null;
  }

  private envGranted(op: OsOp, name: string): void {
    if (!this.grants.allows({ need: 'env', name })) throw denied(op, `environment ${name} is not granted`);
  }

  private stdioMode(options: JsonObject | undefined, key: string, kind: OsStdioKind): StdioMode {
    const op: OsOp = 'os/spawn';
    const given = options?.[key];
    let mode: StdioMode = 'null';
    if (given === undefined || given === null) {
      mode = 'null';
    } else if (typeof given === 'string') {
      if (given !== 'inherit' && given !== 'pipe' && given !== 'null') {
        throw invalid(op, `${key} must be inherit, pipe or null, got ${given}`);
      }
      mode = given;
    } else {
      throw invalid(op, `${key} must be a string`);
    }
    if (mode === 'inherit' && !this.grants.allows({ need: 'stdio', kind })) {
      throw denied(op, `inheriting ${key} is not granted`);
    }
    return mode;
  }

  async run(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    switch (op) {
      case 'os/spawn':
        return this.spawn(args);
      case 'os/wait':
        return this.wait(args);
      case 'os/kill':
        return this.kill(args);
      case 'os/pid':
        return { pid: process.pid };
      case 'os/ppid':
        return { pid: process.ppid };
      case 'os/getenv': {
        const name = argStr(args, 0, op);
        this.envGranted(op, name);
        return { value: this.lookupEnv(name) };
      }
      case 'os/setenv':
      case 'os/unsetenv':
        return this.setenv(op, args, op === 'os/setenv');
      case 'os/environ':
        return this.environ();
      case 'os/stdout-write':
        return this.writeStdio(op, args, false);
      case 'os/stderr-write':
        return this.writeStdio(op, args, true);
      case 'os/isatty':
        return { ok: isatty(this.stdFd(op, args)) };
      case 'os/tty-size':
        return this.ttySize(op, args);
      case 'os/watch-process':
      case 'os/watch-signal':
      case 'os/watch-env':
        throw osFailure('unsupported', op, 'streaming host not implemented');
      default:
        throw osFailure('unsupported', op, 'the Node os host does not answer this operation yet (G-ORB-308)');
    }
  }

  private async spawn(args: JsonValue[]): Promise<JsonValue> {
    const op: OsOp = 'os/spawn';
    const command = argStr(args, 0, op);
    const listed = args[1];
    if (!Array.isArray(listed) || !listed.every((item) => typeof item === 'string')) {
      throw invalid(op, 'argument 2 must be a list of strings');
    }
    const argv: string[] = listed.filter((item): item is string => typeof item === 'string');
    const given = argOpt(args, 2);
    if (given !== undefined && !isJsonRecord(given)) throw invalid(op, 'argument 3 must be an object');
    const options = given === undefined ? undefined : given;
    if (options !== undefined) {
      for (const key of Object.keys(options)) {
        if (!['cwd', 'env', 'stdin', 'stdout', 'stderr'].includes(key)) throw invalid(op, `unknown option ${key}`);
      }
    }
    if (!this.grants.allows({ need: 'exec', command })) throw denied(op, `command ${command} is not granted`);
    const wantedCwd = options?.cwd;
    let cwd: string | undefined;
    if (wantedCwd === undefined || wantedCwd === null) {
      cwd = undefined;
    } else if (typeof wantedCwd === 'string') {
      if (!this.grants.allows({ need: 'fs', path: wantedCwd, mode: 'read' })) {
        throw denied(op, `cwd ${wantedCwd} is not granted for read`);
      }
      cwd = wantedCwd;
    } else {
      throw invalid(op, 'cwd must be a string');
    }
    const stdinMode = this.stdioMode(options, 'stdin', 'in');
    const stdoutMode = this.stdioMode(options, 'stdout', 'out');
    const stderrMode = this.stdioMode(options, 'stderr', 'err');

    const vars: Record<string, string> = {};
    for (const [name, value] of this.state.env) {
      if (value !== null) vars[name] = value;
    }
    const wantedEnv = options?.env;
    if (wantedEnv === undefined || wantedEnv === null) {
      // the overlay alone
    } else if (isJsonRecord(wantedEnv)) {
      for (const [name, value] of Object.entries(wantedEnv)) {
        if (!validEnvName(name)) throw invalid(op, `bad environment name ${name}`);
        if (typeof value === 'string' && !value.includes('\0')) {
          vars[name] = value;
        } else if (value === null) {
          this.envGranted(op, name);
          const found = this.lookupEnv(name);
          if (found !== null) vars[name] = found;
          else delete vars[name];
        } else {
          throw invalid(op, `environment ${name} must be a string or null`);
        }
      }
    } else {
      throw invalid(op, 'env must be an object');
    }

    const modes = [stdinMode, stdoutMode, stderrMode].map((mode) => (mode === 'inherit' ? 'inherit' : mode === 'pipe' ? 'pipe' : 'ignore'));
    let child;
    try {
      child = spawn(command, argv, { cwd, env: vars, stdio: [modes[0], modes[1], modes[2]] });
    } catch (raised) {
      const error = raised instanceof Error ? raised : new Error(String(raised));
      if (errnoCode(error) === 'ERR_INVALID_ARG_VALUE') throw invalid(op, 'nul byte found in provided data');
      throw processFailure(op, error);
    }
    const exit = new Promise<ExitInfo>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal: signal === null ? null : (SIGNALS[signal] ?? null) }));
    });
    const started = await new Promise<Error | undefined>((resolve) => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', (error) => resolve(error));
    });
    if (started !== undefined) throw processFailure(op, started);
    child.on('error', () => undefined);
    const pid = child.pid ?? 0;
    const entry: ChildEntry = { child, exit, exited: false };
    void exit.then(() => {
      entry.exited = true;
    });
    const fields: JsonObject = { pid };
    if (child.stdin !== null) {
      const id = this.state.allocate();
      this.state.fds.set(id, { kind: 'child-stdin', stream: child.stdin });
      fields.stdin = id;
    }
    if (child.stdout !== null) {
      const id = this.state.allocate();
      this.state.fds.set(id, { kind: 'child-stdout', source: new ByteSource(child.stdout, PIPE_HIGH_WATER) });
      fields.stdout = id;
    }
    if (child.stderr !== null) {
      const id = this.state.allocate();
      this.state.fds.set(id, { kind: 'child-stderr', source: new ByteSource(child.stderr, PIPE_HIGH_WATER) });
      fields.stderr = id;
    }
    this.state.children.set(pid, entry);
    return fields;
  }

  private async wait(args: JsonValue[]): Promise<JsonValue> {
    return (await this.waitLater(args)())();
  }

  /** `os/wait` after its checks; a keyed ask under a route watches the child in the background (EXEC-QUEUE-10). */
  waitLater(args: JsonValue[]): Deferral {
    const op: OsOp = 'os/wait';
    const pid = argI64(args, 0, op);
    const entry = this.state.children.get(pid);
    if (entry === undefined) throw osFailure('closed', op, `pid ${pid} is not a spawned process`);
    return async () => {
      const info = await entry.exit;
      return () => {
        if (!this.state.children.delete(pid)) throw osFailure('closed', op, `pid ${pid} was already reaped`);
        const fields: JsonObject = {};
        if (info.code !== null) fields.code = info.code;
        if (info.signal !== null) fields.signal = info.signal;
        return fields;
      };
    };
  }

  private signalNumber(value: JsonValue): number {
    const op: OsOp = 'os/kill';
    let found: number | undefined;
    if (typeof value === 'string') found = SIGNAL_SET.find(([name]) => name === value)?.[1];
    else if (typeof value === 'number' && Number.isInteger(value)) found = SIGNAL_SET.find(([, number]) => number === value)?.[1];
    if (found === undefined) {
      throw invalid(op, 'signal must be one of TERM, KILL, INT, HUP, QUIT, USR1, USR2, STOP, CONT (or its number)');
    }
    return found;
  }

  private kill(args: JsonValue[]): JsonValue {
    const op: OsOp = 'os/kill';
    const pid = argI64(args, 0, op);
    const signal = this.signalNumber(args.length > 1 ? args[1] : null);
    const entry = this.state.children.get(pid);
    if (entry === undefined) throw osFailure('closed', op, `pid ${pid} is not a spawned process`);
    if (pid < -2147483648 || pid > 2147483647) throw invalid(op, 'pid out of range');
    if (entry.exited) return {};
    try {
      process.kill(pid, signal);
    } catch (raised) {
      throw processFailure(op, raised instanceof Error ? raised : new Error(String(raised)));
    }
    return {};
  }

  private setenv(op: OsOp, args: JsonValue[], set: boolean): JsonValue {
    const name = argStr(args, 0, op);
    this.envGranted(op, name);
    if (!validEnvName(name)) throw invalid(op, `bad environment name ${name}`);
    let entry: string | null = null;
    if (set) {
      const value = argStr(args, 1, op);
      if (value.includes('\0')) throw invalid(op, 'value contains a NUL byte');
      entry = value;
    }
    this.state.env.set(name, entry);
    return {};
  }

  private environ(): JsonValue {
    const names = new Set<string>(Object.keys(process.env).filter((name) => this.grants.allows({ need: 'env', name })));
    for (const [name, value] of this.state.env) {
      if (value !== null && this.grants.allows({ need: 'env', name })) names.add(name);
      else if (value === null) names.delete(name);
    }
    return { names: [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) };
  }

  private async writeStdio(op: OsOp, args: JsonValue[], toStderr: boolean): Promise<JsonValue> {
    const data = argBytes(args, 0, op);
    if (!this.grants.allows({ need: 'stdio', kind: toStderr ? 'err' : 'out' })) throw denied(op, 'stdio is not granted');
    const stream = toStderr ? process.stderr : process.stdout;
    await new Promise<void>((resolve, reject) => {
      stream.write(data, (error) => (error ? reject(error) : resolve()));
    }).catch((raised: Error) => {
      throw processFailure(op, raised);
    });
    return { bytes: data.length };
  }

  private stdFd(op: OsOp, args: JsonValue[]): number {
    const fd = argI64(args, 0, op);
    let kind: OsStdioKind;
    if (fd === 0) kind = 'in';
    else if (fd === 1) kind = 'out';
    else if (fd === 2) kind = 'err';
    else throw osFailure('unsupported', op, 'only fds 0, 1 and 2 are supported');
    if (!this.grants.allows({ need: 'stdio', kind })) throw denied(op, 'stdio is not granted');
    return fd;
  }

  private ttySize(op: OsOp, args: JsonValue[]): JsonValue {
    const fd = this.stdFd(op, args);
    if (!isatty(fd)) throw osFailure('io', op, `fd ${fd} is not a terminal`);
    if (fd === 0) throw osFailure('unsupported', op, 'the Node os host does not read the size of a terminal on fd 0 yet (G-ORB-308)');
    const stream = fd === 1 ? process.stdout : process.stderr;
    const [cols, rows] = stream.getWindowSize();
    return { rows, cols };
  }
}
