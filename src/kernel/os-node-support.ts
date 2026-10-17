/**
 * What the Node `os` families share: the failure, the argument readers, the bytes encoding and the handle
 * state. Each reader mirrors `os_host/args.rs` of the native host; each message is the native one.
 */
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import type { Socket as TcpSocket } from 'node:net';
import type { Socket as UdpSocket } from 'node:dgram';
import type { JsonValue } from '@almadar/core';
import type { OsError, OsErrorKind, OsOp } from '@almadar/core/kernel-wire';

export class OsFailure extends Error {
  constructor(readonly error: OsError) {
    super(error.message);
  }
}

export function osFailure(kind: OsErrorKind, op: OsOp, what: string): OsFailure {
  return new OsFailure({ kind, message: `${op}: ${what}` });
}

export function denied(op: OsOp, what: string): OsFailure {
  return osFailure('denied', op, what);
}

export function invalid(op: OsOp, what: string): OsFailure {
  return osFailure('invalid', op, what);
}

function invalidArgument(op: OsOp, i: number, expected: string): OsFailure {
  return invalid(op, `argument ${i + 1} must be ${expected}`);
}

function argument(args: JsonValue[], i: number, op: OsOp, expected: string): JsonValue {
  if (i >= args.length) return fail(invalid(op, `missing argument ${i + 1} (${expected})`));
  return args[i];
}

function fail(failure: OsFailure): never {
  throw failure;
}

/** The argument at `i` unless it is absent or null. */
export function argOpt(args: JsonValue[], i: number): JsonValue | undefined {
  return i < args.length && args[i] !== null ? args[i] : undefined;
}

export function argStr(args: JsonValue[], i: number, op: OsOp): string {
  const value = argument(args, i, op, 'a string');
  return typeof value === 'string' ? value : fail(invalidArgument(op, i, 'a string'));
}

/** An integral number that fits an `i64`. */
export function argI64(args: JsonValue[], i: number, op: OsOp): number {
  const value = argument(args, i, op, 'an integer');
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) < 9.007_199_254_740_992e15) return value;
  return fail(invalidArgument(op, i, 'an integer'));
}

export function argBool(args: JsonValue[], i: number, op: OsOp): boolean {
  const value = argument(args, i, op, 'a boolean');
  return typeof value === 'boolean' ? value : fail(invalidArgument(op, i, 'a boolean'));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard padded base64 with canonical padding and no trailing bits, as the Rust `STANDARD` engine decodes; the failure text. */
function decodeStandardBase64(text: string): { bytes: Buffer } | { failure: string } {
  const symbols = text.endsWith('==') ? text.length - 2 : text.endsWith('=') ? text.length - 1 : text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (i >= symbols) continue;
    if (BASE64_ALPHABET.indexOf(text[i]) === -1) return { failure: `Invalid byte ${code}, offset ${i}.` };
  }
  const padding = text.length - symbols;
  const remainder = symbols % 4;
  if (remainder === 1) return { failure: `Invalid input length: ${symbols}` };
  if (text.length % 4 !== 0 || (remainder === 0 && padding !== 0) || (remainder === 2 && padding !== 2) || (remainder === 3 && padding !== 1)) {
    return { failure: 'Invalid padding' };
  }
  if (remainder === 2 || remainder === 3) {
    const last = BASE64_ALPHABET.indexOf(text[symbols - 1]);
    const spare = remainder === 2 ? 0b1111 : 0b11;
    if ((last & spare) !== 0) return { failure: `Invalid last symbol ${text.charCodeAt(symbols - 1)}, offset ${symbols - 1}.` };
  }
  return { bytes: Buffer.from(text, 'base64') };
}

/** A `bytes` argument: a standard padded base64 string. */
export function argBytes(args: JsonValue[], i: number, op: OsOp): Buffer {
  const decoded = decodeStandardBase64(argStr(args, i, op));
  if ('failure' in decoded) throw invalid(op, `argument ${i + 1} is not standard base64: ${decoded.failure}`);
  return decoded.bytes;
}

/** The run-time value of `bytes`: standard padded base64. */
export function bytesValue(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const ERRNO: Record<string, number> = constants.errno;

const POSIX_TEXT: Record<string, string> = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  ESRCH: 'No such process',
  EINTR: 'Interrupted system call',
  EIO: 'Input/output error',
  E2BIG: 'Argument list too long',
  EBADF: 'Bad file descriptor',
  EAGAIN: 'Resource temporarily unavailable',
  ENOMEM: 'Cannot allocate memory',
  EACCES: 'Permission denied',
  EBUSY: 'Device or resource busy',
  EEXIST: 'File exists',
  EXDEV: 'Invalid cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  EFBIG: 'File too large',
  ENOSPC: 'No space left on device',
  ESPIPE: 'Illegal seek',
  EROFS: 'Read-only file system',
  EMLINK: 'Too many links',
  EPIPE: 'Broken pipe',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EADDRINUSE: 'Address already in use',
  EADDRNOTAVAIL: 'Cannot assign requested address',
  ENETDOWN: 'Network is down',
  ENETUNREACH: 'Network is unreachable',
  ECONNABORTED: 'Software caused connection abort',
  ECONNRESET: 'Connection reset by peer',
  ENOTCONN: 'Transport endpoint is not connected',
  ETIMEDOUT: 'Connection timed out',
  ECONNREFUSED: 'Connection refused',
  EHOSTUNREACH: 'No route to host',
  EINPROGRESS: 'Operation now in progress',
};

const DARWIN_TEXT: Record<string, string> = {
  EXDEV: 'Cross-device link',
  EBUSY: 'Resource busy',
  ENOTCONN: 'Socket is not connected',
  ETIMEDOUT: 'Operation timed out',
};

/** An I/O failure whose text is the whole message (Rust `io::Error::new`/`const_error!`, no OS error behind it). */
export class TextIoError extends Error {
  constructor(readonly code: string, text: string) {
    super(text);
  }
}

/** A failure with an OS error number, as the syscall would have returned it. */
export function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

/** `Display` of a Rust `io::Error`: `<strerror> (os error <n>)`, or the text of an error with no OS number. */
export function errnoText(error: Error): string {
  if (error instanceof TextIoError) return error.message;
  const code = errnoCode(error);
  const number = code === undefined ? undefined : ERRNO[code];
  const text = code === undefined ? undefined : (process.platform === 'darwin' ? DARWIN_TEXT[code] : undefined) ?? POSIX_TEXT[code];
  if (number === undefined || text === undefined) return error.message;
  return `${text} (os error ${number})`;
}

export function errnoCode(error: Error): string | undefined {
  const raised: NodeJS.ErrnoException = error;
  return raised.code;
}

/** The kind `fs.rs` gives an I/O error. */
export function fsKind(code: string | undefined): OsErrorKind {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'EEXIST':
      return 'exists';
    case 'EACCES':
    case 'EPERM':
      return 'denied';
    case 'ETIMEDOUT':
      return 'timeout';
    case 'EINVAL':
    case 'EISDIR':
    case 'ENOTDIR':
    case 'ENAMETOOLONG':
    case 'ELOOP':
    case 'EBADF':
      return 'invalid';
    default:
      return 'io';
  }
}

/** The kind `process.rs` gives an I/O error. */
export function processKind(code: string | undefined): OsErrorKind {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'denied';
    case 'EINVAL':
      return 'invalid';
    default:
      return 'io';
  }
}

/** The kind `net.rs` gives an I/O error. */
export function netKind(code: string | undefined): OsErrorKind {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'denied';
    case 'ETIMEDOUT':
    case 'EAGAIN':
    case 'EWOULDBLOCK':
    case 'EINPROGRESS':
      return 'timeout';
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'ENOTCONN':
      return 'closed';
    case 'EADDRINUSE':
    case 'EEXIST':
      return 'exists';
    case 'EINVAL':
      return 'invalid';
    default:
      return 'io';
  }
}

export function processFailure(op: OsOp, error: Error): OsFailure {
  return osFailure(processKind(errnoCode(error)), op, errnoText(error));
}

export function netFailure(op: OsOp, error: Error): OsFailure {
  return osFailure(netKind(errnoCode(error)), op, errnoText(error));
}

/** Bytes a stream delivers, held until a call asks for them; a full buffer holds the stream back. */
export class ByteSource {
  private chunks: Buffer[] = [];
  private held = 0;
  private ended = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly stream: Readable, private readonly highWater: number) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.held += chunk.length;
      if (this.held > this.highWater) stream.pause();
      this.notify();
    });
    stream.on('end', () => {
      this.ended = true;
      this.notify();
    });
    stream.on('error', (error: Error) => {
      this.failure = error;
      this.notify();
    });
    stream.on('close', () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** One read at a time, as the native pipe lock does: a read that has not ended holds the next one back. */
  take(want: number, timeoutMs: number | undefined): Promise<Buffer | 'timeout'> {
    const run = this.queue.then(() => this.takeNow(want, timeoutMs));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** At most `want` bytes of one read: what is held, else what arrives; empty at end of stream; `'timeout'` after `timeoutMs`. */
  private async takeNow(want: number, timeoutMs: number | undefined): Promise<Buffer | 'timeout'> {
    if (want === 0) return Buffer.alloc(0);
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      if (this.held > 0) return this.slice(want);
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return Buffer.alloc(0);
      const left = deadline === undefined ? undefined : deadline - Date.now();
      if (left !== undefined && left <= 0) return 'timeout';
      await new Promise<void>((resolve) => {
        const timer = left === undefined ? undefined : setTimeout(resolve, left);
        this.wake = () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private slice(want: number): Buffer {
    const parts: Buffer[] = [];
    let need = want;
    while (need > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.length <= need) {
        parts.push(head);
        need -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, need));
        this.chunks[0] = head.subarray(need);
        need = 0;
      }
    }
    const taken = Buffer.concat(parts);
    this.held -= taken.length;
    if (this.held <= this.highWater) this.stream.resume();
    return taken;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

/** `write_all`: the bytes handed to `stream`, failing when it errors or, with `timeoutMs`, does not take them in time. */
export function writeAll(stream: Writable, data: Uint8Array, timeoutMs: number | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => reject(errnoError('EAGAIN')), timeoutMs);
    stream.write(data, (error) => {
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

export type FdEntry =
  | { kind: 'file'; handle: FileHandle; position: number; append: boolean }
  | { kind: 'child-stdin'; stream: Writable }
  | { kind: 'child-stdout'; source: ByteSource }
  | { kind: 'child-stderr'; source: ByteSource };

export interface ExitInfo {
  code: number | null;
  signal: number | null;
}

export interface ChildEntry {
  child: ChildProcess;
  exit: Promise<ExitInfo>;
  exited: boolean;
}

export type SockEntry =
  | { kind: 'stream'; socket: TcpSocket; source: ByteSource; shut: boolean }
  | { kind: 'datagram'; socket: UdpSocket; inbox: Datagram[]; failure: Error | undefined; wake: (() => void) | undefined };

export interface Datagram {
  data: Buffer;
  peer: string;
}

/** A deferred call after its synchronous checks: `blocking` waits on the world, then hands back the answer to build once the completion is claimed. */
export type Deferral = () => Promise<() => JsonValue>;

/** The keys whose deferred completion is still wanted (native `Completions`). */
export class Completions {
  private readonly live = new Set<string>();

  /** `false` when `key` already has a completion pending. */
  begin(key: string): boolean {
    if (this.live.has(key)) return false;
    this.live.add(key);
    return true;
  }

  /** Drop the pending completion of `key`; `false` when none is pending. */
  cancel(key: string): boolean {
    return this.live.delete(key);
  }

  /** Take the right to deliver `key`'s completion: `false` when it was cancelled first. */
  claim(key: string): boolean {
    return this.live.delete(key);
  }

  clear(): void {
    this.live.clear();
  }
}

/** Descriptors 0, 1 and 2 are the standard streams; allocated ids start here. */
export const FIRST_HANDLE_ID = 3;

/** The handles one program instance owns, one id sequence across files, pipes and sockets. */
export class OsState {
  private next = FIRST_HANDLE_ID;
  readonly fds = new Map<number, FdEntry>();
  readonly socks = new Map<number, SockEntry>();
  readonly children = new Map<number, ChildEntry>();
  readonly env = new Map<string, string | null>();
  readonly completions = new Completions();
  cwd: string | undefined;

  allocate(): number {
    const id = this.next;
    this.next += 1;
    return id;
  }

  close(): void {
    this.completions.clear();
    for (const entry of this.children.values()) entry.child.kill('SIGKILL');
    this.children.clear();
    this.env.clear();
    for (const entry of this.fds.values()) closeFd(entry);
    this.fds.clear();
    this.cwd = undefined;
    for (const entry of this.socks.values()) closeSock(entry);
    this.socks.clear();
  }
}

export function closeFd(entry: FdEntry): void {
  if (entry.kind === 'file') void entry.handle.close();
  else if (entry.kind === 'child-stdin') entry.stream.end();
  else entry.source.destroy();
}

export function closeSock(entry: SockEntry): void {
  if (entry.kind === 'stream') entry.socket.destroy();
  else entry.socket.close();
}

/** Compare as UTF-8 bytes, the order Rust sorts strings in. */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
