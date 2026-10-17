/**
 * The `fs` family on Node `fs`: files, descriptors, directories, stat and path effects. It mirrors
 * `os_host/fs.rs` of the native host: every path is checked lexically, resolved by hand and checked again
 * after resolution, and every answer shape and message is the native one. The grant decisions are the
 * kernel's (`OsGrantPort`); nothing here decides a grant.
 */
import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, copyFile, link, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { JsonObject, JsonValue } from '@almadar/core';
import type { OsErrorKind, OsOp } from '@almadar/core/kernel-wire';
import type { OsFsMode, OsGrantPort } from './os-port.js';
import {
  argBool,
  argBytes,
  argI64,
  argOpt,
  argStr,
  byteOrder,
  bytesValue,
  closeFd,
  denied,
  errnoCode,
  errnoError,
  errnoText,
  fsKind,
  invalid,
  osFailure,
  FIRST_HANDLE_ID,
  OsFailure,
  type Deferral,
  type FdEntry,
  type OsState,
} from './os-node-support.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINKS = 40;
const CHUNK = 1024 * 1024;

interface Located {
  norm: string;
  real: string;
}

interface Flags {
  read: boolean;
  write: boolean;
  append: boolean;
  create: boolean;
  truncate: boolean;
  exclusive: boolean;
}

interface Kinded {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

function kindOf(entry: Kinded): string {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return 'other';
}

function millis(ns: bigint): number {
  let seconds = ns / 1_000_000_000n;
  let nanos = ns % 1_000_000_000n;
  if (nanos < 0n) {
    nanos += 1_000_000_000n;
    seconds -= 1n;
  }
  return Number(seconds) * 1000 + Number(nanos) / 1_000_000;
}

function statValue(entry: BigIntStats): JsonObject {
  return {
    kind: kindOf(entry),
    size: Number(entry.size),
    mode: Number(entry.mode & 0o7777n),
    uid: Number(entry.uid),
    gid: Number(entry.gid),
    atime: millis(entry.atimeNs),
    mtime: millis(entry.mtimeNs),
    ctime: millis(entry.ctimeNs),
  };
}

/** The absolute path with `.` dropped and `..` collapsed; undefined when a `..` climbs above the root. */
function lexical(path: string): string | undefined {
  const kept: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (kept.length === 0) return undefined;
      kept.pop();
      continue;
    }
    kept.push(part);
  }
  return `/${kept.join('/')}`;
}

function joinPath(directory: string, part: string): string {
  return directory === '/' ? `/${part}` : `${directory}/${part}`;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let at = path;
  for (;;) {
    out.push(at);
    if (at === '/') return out;
    at = parentOf(at);
  }
}

function components(path: string): string[] {
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

/** Resolve `path` component by component, following links (the last one only when `followLast`), as the native `resolve`. */
async function resolveReal(path: string, followLast: boolean): Promise<string> {
  const queue = components(path);
  let current = '/';
  let links = 0;
  while (queue.length > 0) {
    const part = queue.shift() ?? '';
    if (part === '..') {
      current = parentOf(current);
      continue;
    }
    const next = joinPath(current, part);
    const entry = await lstat(next).catch((raised: Error) => raised);
    if (entry instanceof Error) {
      if (errnoCode(entry) === 'ENOENT') {
        current = next;
        continue;
      }
      throw entry;
    }
    if (entry.isSymbolicLink() && (followLast || queue.length > 0)) {
      links += 1;
      if (links > MAX_LINKS) throw errnoError('ELOOP');
      const target = await readlink(next);
      if (target.startsWith('/')) current = '/';
      queue.unshift(...components(target));
    } else {
      current = next;
    }
  }
  return current;
}

function modeName(mode: OsFsMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

const FS_OPS: ReadonlySet<OsOp> = new Set<OsOp>([
  'os/read-file', 'os/write-file', 'os/append-file', 'os/open', 'os/close', 'os/read', 'os/write', 'os/seek', 'os/truncate',
  'os/fsync', 'os/copy', 'os/rename', 'os/remove', 'os/link', 'os/symlink', 'os/readlink', 'os/watch-files', 'os/mkdir',
  'os/rmdir', 'os/list-dir', 'os/glob', 'os/mktemp', 'os/realpath', 'os/cwd', 'os/chdir', 'os/stat', 'os/lstat', 'os/access',
  'os/exists', 'os/chmod', 'os/chown', 'os/utimes',
]);

export function isFsOp(op: OsOp): boolean {
  return FS_OPS.has(op);
}

export class FsOps {
  constructor(private readonly state: OsState, private readonly grants: OsGrantPort) {}

  private failure(op: OsOp, kind: OsErrorKind, what: string): OsFailure {
    return osFailure(kind, op, what);
  }

  private io(op: OsOp, path: string, error: Error): OsFailure {
    return this.failure(op, fsKind(errnoCode(error)), `${path}: ${errnoText(error)}`);
  }

  private allow(op: OsOp, path: string, mode: OsFsMode): void {
    if (!this.grants.allows({ need: 'fs', path, mode })) {
      throw denied(op, `${path} is not granted for ${modeName(mode)}`);
    }
  }

  private async locate(op: OsOp, raw: string, mode: OsFsMode, followLast: boolean): Promise<Located> {
    if (raw === '') throw invalid(op, 'empty path');
    const absolute = this.absolute(op, raw);
    const norm = lexical(absolute);
    if (norm === undefined) throw denied(op, `${raw} climbs above the root`);
    this.allow(op, norm, mode);
    const real = await resolveReal(norm, followLast).catch((raised: Error) => {
      throw this.io(op, norm, raised);
    });
    if (real !== norm && !this.grants.allows({ need: 'fs', path: real, mode })) {
      throw denied(op, `${norm} resolves to ${real}, outside the grant`);
    }
    return { norm, real };
  }

  private absolute(op: OsOp, raw: string): string {
    if (raw.startsWith('/')) return raw;
    const cwd = this.state.cwd;
    if (cwd === undefined) throw invalid(op, `${raw} is relative and no working directory is set (os/chdir)`);
    return `${cwd}/${raw}`;
  }

  private require(op: OsOp, at: Located, mode: OsFsMode): void {
    this.allow(op, at.norm, mode);
    if (at.real !== at.norm) this.allow(op, at.real, mode);
  }

  private async path(op: OsOp, raw: string, mode: OsFsMode, followLast: boolean): Promise<string> {
    return (await this.locate(op, raw, mode, followLast)).real;
  }

  private async missing(op: OsOp, at: Located): Promise<boolean> {
    const found = await lstat(at.real).catch((raised: Error) => raised);
    if (!(found instanceof Error)) return false;
    if (errnoCode(found) === 'ENOENT') return true;
    throw this.io(op, at.real, found);
  }

  private async writeTarget(op: OsOp, raw: string): Promise<string> {
    const at = await this.locate(op, raw, 'write', true);
    if (await this.missing(op, at)) this.require(op, at, 'create');
    return at.real;
  }

  private modeArg(op: OsOp, args: JsonValue[], i: number): number | undefined {
    if (argOpt(args, i) === undefined) return undefined;
    const mode = argI64(args, i, op);
    if (mode < 0 || mode > 0o7777) throw invalid(op, 'mode must be within 0..=0o7777');
    return mode;
  }

  private fdEntry(op: OsOp, fd: number): FdEntry {
    const entry = this.state.fds.get(fd);
    if (entry === undefined) throw osFailure('closed', op, `fd ${fd} is not open`);
    return entry;
  }

  private fileEntry(op: OsOp, fd: number): Extract<FdEntry, { kind: 'file' }> {
    const entry = this.fdEntry(op, fd);
    if (entry.kind !== 'file') throw invalid(op, `fd ${fd} is a pipe, not a file`);
    return entry;
  }

  private fdIo(op: OsOp, raised: Error): OsFailure {
    return this.io(op, 'fd', raised);
  }

  /** `None` of the native `answer`: an `os/close` of a handle this table does not own. */
  closeOwned(args: JsonValue[]): boolean {
    const fd = argI64(args, 0, 'os/close');
    const entry = this.state.fds.get(fd);
    if (fd < FIRST_HANDLE_ID || entry === undefined) return false;
    this.state.fds.delete(fd);
    closeFd(entry);
    return true;
  }

  async run(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    switch (op) {
      case 'os/read-file':
        return this.readFile(op, args);
      case 'os/write-file':
        return this.writeFile(op, args, false);
      case 'os/append-file':
        return this.writeFile(op, args, true);
      case 'os/open':
        return this.open(op, args);
      case 'os/read':
        return this.read(op, args);
      case 'os/write':
        return this.write(op, args);
      case 'os/seek':
        return this.seek(op, args);
      case 'os/truncate':
        return this.truncate(op, args);
      case 'os/fsync': {
        const entry = this.fileEntry(op, argI64(args, 0, op));
        await entry.handle.sync().catch((raised: Error) => {
          throw this.fdIo(op, raised);
        });
        return {};
      }
      case 'os/copy': {
        const from = await this.path(op, argStr(args, 0, op), 'read', true);
        const to = await this.writeTarget(op, argStr(args, 1, op));
        await copyFile(from, to).catch((raised: Error) => {
          throw this.io(op, from, raised);
        });
        return {};
      }
      case 'os/rename': {
        const from = await this.path(op, argStr(args, 0, op), 'remove', false);
        const to = await this.locate(op, argStr(args, 1, op), 'create', false);
        if (!(await this.missing(op, to))) this.require(op, to, 'remove');
        await rename(from, to.real).catch((raised: Error) => {
          throw this.io(op, from, raised);
        });
        return {};
      }
      case 'os/remove': {
        const path = await this.path(op, argStr(args, 0, op), 'remove', false);
        const entry = await lstat(path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        if (entry.isDirectory()) throw invalid(op, `${path} is a directory; use os/rmdir`);
        await unlink(path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return {};
      }
      case 'os/link': {
        const target = await this.path(op, argStr(args, 0, op), 'write', true);
        const path = await this.path(op, argStr(args, 1, op), 'create', false);
        await link(target, path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return {};
      }
      case 'os/symlink': {
        const target = argStr(args, 0, op);
        const path = await this.path(op, argStr(args, 1, op), 'create', false);
        await symlink(target, path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return {};
      }
      case 'os/readlink': {
        const path = await this.path(op, argStr(args, 0, op), 'read', false);
        const target = await readlink(path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return { target };
      }
      case 'os/watch-files':
        throw this.failure(op, 'unsupported', 'streaming host not implemented');
      case 'os/mkdir':
        return this.mkdir(op, args);
      case 'os/rmdir':
        return this.rmdir(op, args);
      case 'os/list-dir':
        return this.listDir(op, args);
      case 'os/glob':
        return this.glob(op, args);
      case 'os/mktemp':
        return this.mktemp(op, args);
      case 'os/realpath': {
        const path = await this.path(op, argStr(args, 0, op), 'read', true);
        await lstat(path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return { path };
      }
      case 'os/cwd': {
        const cwd = this.state.cwd;
        if (cwd === undefined) throw invalid(op, 'no working directory is set (os/chdir)');
        return { path: cwd };
      }
      case 'os/chdir': {
        const path = await this.path(op, argStr(args, 0, op), 'read', true);
        const entry = await stat(path).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        if (!entry.isDirectory()) throw invalid(op, `${path} is not a directory`);
        this.state.cwd = path;
        return {};
      }
      case 'os/stat':
      case 'os/lstat': {
        const follow = op === 'os/stat';
        const path = await this.path(op, argStr(args, 0, op), 'read', follow);
        const read = follow ? stat : lstat;
        const entry = await read(path, { bigint: true }).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return statValue(entry);
      }
      case 'os/access':
        return this.access(op, args);
      case 'os/exists': {
        const path = await this.path(op, argStr(args, 0, op), 'read', true);
        const present = await stat(path).then(() => true, () => false);
        return { ok: present };
      }
      case 'os/chmod': {
        const path = await this.path(op, argStr(args, 0, op), 'meta', true);
        const mode = this.modeArg(op, args, 1);
        if (mode === undefined) throw invalid(op, 'missing mode');
        await chmod(path, mode).catch((raised: Error) => {
          throw this.io(op, path, raised);
        });
        return {};
      }
      case 'os/chown':
        return this.chown(op, args);
      case 'os/utimes':
        return this.utimes(op, args);
      default:
        throw this.failure(op, 'unsupported', 'not a file operation');
    }
  }

  private async readFile(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'read', true);
    const handle = await open(path, 'r').catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    const parts: Buffer[] = [];
    let total = 0;
    try {
      while (total < MAX_BYTES + 1) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, MAX_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        parts.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
    } catch (raised) {
      throw this.io(op, path, raised instanceof Error ? raised : new Error(String(raised)));
    } finally {
      await handle.close();
    }
    if (total > MAX_BYTES) {
      throw invalid(op, `${path} exceeds the ${MAX_BYTES}-byte (64 MiB) per-call cap; use os/open and os/read`);
    }
    return { data: bytesValue(Buffer.concat(parts)) };
  }

  private async writeFile(op: OsOp, args: JsonValue[], append: boolean): Promise<JsonValue> {
    const path = await this.writeTarget(op, argStr(args, 0, op));
    const data = argBytes(args, 1, op);
    const mode = this.modeArg(op, args, 2);
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | (append ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
    const handle = await open(path, flags, mode).catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    try {
      let written = 0;
      while (written < data.length) {
        const { bytesWritten } = await handle.write(data, written, data.length - written, null);
        written += bytesWritten;
      }
    } catch (raised) {
      throw this.io(op, path, raised instanceof Error ? raised : new Error(String(raised)));
    } finally {
      await handle.close();
    }
    return { bytes: data.length };
  }

  private parseFlags(op: OsOp, flags: string): Flags {
    const exclusive = flags.endsWith('x');
    const base = exclusive ? flags.slice(0, -1) : flags;
    let parsed: Omit<Flags, 'exclusive'>;
    switch (base) {
      case 'r':
        parsed = { read: true, write: false, append: false, create: false, truncate: false };
        break;
      case 'r+':
        parsed = { read: true, write: true, append: false, create: false, truncate: false };
        break;
      case 'w':
        parsed = { read: false, write: true, append: false, create: true, truncate: true };
        break;
      case 'w+':
        parsed = { read: true, write: true, append: false, create: true, truncate: true };
        break;
      case 'a':
        parsed = { read: false, write: true, append: true, create: true, truncate: false };
        break;
      case 'a+':
        parsed = { read: true, write: true, append: true, create: true, truncate: false };
        break;
      default:
        throw invalid(op, `flags ${JSON.stringify(flags)} must be one of r r+ w w+ a a+, optionally followed by x`);
    }
    if (exclusive && !parsed.create) throw invalid(op, 'the x flag needs w or a');
    return { ...parsed, exclusive };
  }

  private async open(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const raw = argStr(args, 0, op);
    const flags = this.parseFlags(op, argStr(args, 1, op));
    const mode = this.modeArg(op, args, 2);
    const at = await this.locate(op, raw, flags.write ? 'write' : 'read', true);
    if (flags.read && flags.write) this.require(op, at, 'read');
    if (flags.create && (flags.exclusive || (await this.missing(op, at)))) this.require(op, at, 'create');
    let access = fsConstants.O_RDONLY;
    if (flags.write) access = flags.read ? fsConstants.O_RDWR : fsConstants.O_WRONLY;
    let numeric = access;
    if (flags.append) numeric |= fsConstants.O_APPEND;
    if (flags.truncate) numeric |= fsConstants.O_TRUNC;
    if (flags.exclusive) numeric |= fsConstants.O_CREAT | fsConstants.O_EXCL;
    else if (flags.create) numeric |= fsConstants.O_CREAT;
    const handle = await open(at.real, numeric, mode).catch((raised: Error) => {
      throw this.io(op, at.real, raised);
    });
    const fd = this.state.allocate();
    this.state.fds.set(fd, { kind: 'file', handle, position: 0, append: flags.append });
    return { fd };
  }

  private async read(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    return (await this.readLater(op, args)())();
  }

  /** `os/read` after its checks; a keyed ask under a route runs the returned work in the background (EXEC-QUEUE-10). */
  readLater(op: OsOp, args: JsonValue[]): Deferral {
    const fd = argI64(args, 0, op);
    const count = argI64(args, 1, op);
    if (count < 0 || count > MAX_BYTES) {
      throw invalid(op, `count must be within 0..=${MAX_BYTES} (64 MiB per-call cap)`);
    }
    const entry = this.fdEntry(op, fd);
    if (entry.kind === 'child-stdin') throw invalid(op, `fd ${fd} is write-only`);
    return async () => {
      let data: Buffer;
      if (entry.kind === 'file') {
        const parts: Buffer[] = [];
        let total = 0;
        try {
          while (total < count) {
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK, count - total));
            const { bytesRead } = await entry.handle.read(chunk, 0, chunk.length, entry.position);
            if (bytesRead === 0) break;
            parts.push(chunk.subarray(0, bytesRead));
            total += bytesRead;
            entry.position += bytesRead;
          }
        } catch (raised) {
          throw this.fdIo(op, raised instanceof Error ? raised : new Error(String(raised)));
        }
        data = Buffer.concat(parts);
      } else {
        try {
          const taken = await entry.source.take(count, undefined);
          data = taken === 'timeout' ? Buffer.alloc(0) : taken;
        } catch (raised) {
          throw this.fdIo(op, raised instanceof Error ? raised : new Error(String(raised)));
        }
      }
      const answer = { data: bytesValue(data), eof: count > 0 && data.length === 0 };
      return () => answer;
    };
  }

  private async write(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const fd = argI64(args, 0, op);
    const data = argBytes(args, 1, op);
    const entry = this.fdEntry(op, fd);
    if (entry.kind === 'file') {
      try {
        let written = 0;
        while (written < data.length) {
          const position = entry.append ? null : entry.position;
          const { bytesWritten } = await entry.handle.write(data, written, data.length - written, position);
          written += bytesWritten;
          if (!entry.append) entry.position += bytesWritten;
        }
        if (entry.append) entry.position = (await entry.handle.stat()).size;
      } catch (raised) {
        throw this.fdIo(op, raised instanceof Error ? raised : new Error(String(raised)));
      }
    } else if (entry.kind === 'child-stdin') {
      const { stream } = entry;
      await new Promise<void>((resolve, reject) => {
        stream.write(data, (error) => (error ? reject(error) : resolve()));
      }).catch((raised: Error) => {
        throw this.fdIo(op, raised);
      });
    } else {
      throw invalid(op, `fd ${fd} is read-only`);
    }
    return { bytes: data.length };
  }

  private async seek(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const fd = argI64(args, 0, op);
    const offset = argI64(args, 1, op);
    const whence = argStr(args, 2, op);
    if (whence !== 'set' && whence !== 'cur' && whence !== 'end') {
      throw invalid(op, `whence ${JSON.stringify(whence)} must be set, cur or end`);
    }
    if (whence === 'set' && offset < 0) throw invalid(op, 'a set offset cannot be negative');
    const entry = this.fileEntry(op, fd);
    let target = offset;
    if (whence === 'cur') target = entry.position + offset;
    if (whence === 'end') {
      const size = (await entry.handle.stat().catch((raised: Error) => {
        throw this.fdIo(op, raised);
      })).size;
      target = size + offset;
    }
    if (target < 0) throw this.fdIo(op, errnoError('EINVAL'));
    entry.position = target;
    return { offset: target };
  }

  private async truncate(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const size = argI64(args, 1, op);
    if (size < 0) throw invalid(op, 'size cannot be negative');
    if (typeof args[0] === 'number') {
      const entry = this.fileEntry(op, argI64(args, 0, op));
      await entry.handle.truncate(size).catch((raised: Error) => {
        throw this.fdIo(op, raised);
      });
      return {};
    }
    const path = await this.path(op, argStr(args, 0, op), 'write', true);
    const handle = await open(path, fsConstants.O_WRONLY).catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    try {
      await handle.truncate(size);
    } catch (raised) {
      throw this.io(op, path, raised instanceof Error ? raised : new Error(String(raised)));
    } finally {
      await handle.close();
    }
    return {};
  }

  private async mkdir(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const at = await this.locate(op, argStr(args, 0, op), 'create', false);
    const recursive = argOpt(args, 1) === undefined ? false : argBool(args, 1, op);
    const mode = this.modeArg(op, args, 2);
    if (recursive) {
      for (const ancestor of ancestorsOf(at.real)) {
        const present = await lstat(ancestor).then(() => true, () => false);
        if (!present) this.allow(op, ancestor, 'create');
      }
    }
    await mkdir(at.real, { recursive, mode }).catch((raised: Error) => {
      throw this.io(op, at.real, raised);
    });
    return {};
  }

  private async requireTreeRemovable(op: OsOp, directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((raised: Error) => {
      throw this.io(op, directory, raised);
    });
    for (const entry of entries) {
      const path = joinPath(directory, entry.name);
      this.allow(op, path, 'remove');
      if (entry.isDirectory()) await this.requireTreeRemovable(op, path);
    }
  }

  private async rmdir(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'remove', false);
    const recursive = argOpt(args, 1) === undefined ? false : argBool(args, 1, op);
    const entry = await lstat(path).catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    if (!entry.isDirectory()) throw invalid(op, `${path} is not a directory; use os/remove`);
    if (recursive) {
      await this.requireTreeRemovable(op, path);
      await rm(path, { recursive: true }).catch((raised: Error) => {
        throw this.io(op, path, raised);
      });
    } else {
      await rmdir(path).catch((raised: Error) => {
        throw this.io(op, path, raised);
      });
    }
    return {};
  }

  private async listDir(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'read', true);
    const found = await readdir(path, { withFileTypes: true }).catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    const entries = found
      .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
      .sort((a, b) => byteOrder(a.name, b.name) || byteOrder(a.kind, b.kind));
    return { entries };
  }

  private async glob(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const raw = argStr(args, 0, op);
    if (raw === '') throw invalid(op, 'empty pattern');
    const pattern = lexical(this.absolute(op, raw));
    if (pattern === undefined) throw denied(op, `${raw} climbs above the root`);
    const fixed: string[] = [];
    let rest = 0;
    let wild = false;
    let deep = false;
    for (const part of components(pattern)) {
      if (wild || part.includes('*') || part.includes('?')) {
        wild = true;
        rest += 1;
        deep = deep || part === '**';
      } else {
        fixed.push(part);
      }
    }
    const prefix = `/${fixed.join('/')}`;
    this.allow(op, prefix, 'read');
    const found: string[] = [];
    await this.consider(prefix, pattern, found);
    if (wild) await this.walk(prefix, 1, deep ? undefined : rest, pattern, found);
    const sorted = [...new Set(found)].sort(byteOrder);
    return { paths: sorted };
  }

  private async consider(path: string, pattern: string, out: string[]): Promise<void> {
    if (!this.grants.globMatches(pattern, path) || !this.grants.allows({ need: 'fs', path, mode: 'read' })) return;
    const real = await resolveReal(path, true).catch((raised: Error) => raised);
    if (real instanceof Error) return;
    if (real !== path && !this.grants.allows({ need: 'fs', path: real, mode: 'read' })) return;
    if (await lstat(path).then(() => true, () => false)) out.push(path);
  }

  private async walk(directory: string, level: number, maxLevel: number | undefined, pattern: string, out: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((raised: Error) => raised);
    if (entries instanceof Error) return;
    const children = entries
      .map((entry) => ({ path: joinPath(directory, entry.name), isDir: entry.isDirectory() }))
      .sort((a, b) => byteOrder(a.path, b.path));
    for (const child of children) {
      await this.consider(child.path, pattern, out);
      if (child.isDir && (maxLevel === undefined || level < maxLevel)) {
        await this.walk(child.path, level + 1, maxLevel, pattern, out);
      }
    }
  }

  private async mktemp(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const prefix = argStr(args, 0, op);
    if (prefix.includes('/') || prefix.includes('\0') || prefix === '..' || prefix === '.') {
      throw invalid(op, 'prefix must be a plain file-name prefix');
    }
    const base = argOpt(args, 1) === undefined ? (process.env.TMPDIR ?? '/tmp') : argStr(args, 1, op);
    const at = await this.locate(op, base, 'create', true);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = joinPath(at.real, `${prefix}${randomBytes(8).toString('hex')}`);
      const handle = await open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600).catch((raised: Error) => raised);
      if (handle instanceof Error) {
        if (errnoCode(handle) === 'EEXIST') continue;
        throw this.io(op, candidate, handle);
      }
      await handle.close();
      return { path: candidate };
    }
    throw this.failure(op, 'io', 'could not find an unused temporary name');
  }

  private async access(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'read', true);
    let flags = fsConstants.F_OK;
    if (argOpt(args, 1) !== undefined) {
      const mode = argStr(args, 1, op);
      if (mode === 'exists') flags = fsConstants.F_OK;
      else if (mode === 'read') flags = fsConstants.R_OK;
      else if (mode === 'write') flags = fsConstants.W_OK;
      else if (mode === 'exec' || mode === 'execute') flags = fsConstants.X_OK;
      else if (mode !== '' && [...mode].every((letter) => 'rwx'.includes(letter))) {
        flags = 0;
        for (const letter of mode) {
          flags |= letter === 'r' ? fsConstants.R_OK : letter === 'w' ? fsConstants.W_OK : fsConstants.X_OK;
        }
      } else {
        throw invalid(op, `mode ${JSON.stringify(mode)} must be exists, read, write, exec or letters of rwx`);
      }
    }
    const outcome = await access(path, flags).then(() => undefined, (raised: Error) => raised);
    if (outcome === undefined) return { ok: true };
    const code = errnoCode(outcome);
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return { ok: false };
    throw this.io(op, path, outcome);
  }

  private async chown(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'meta', true);
    const id = (i: number): number => {
      const value = argI64(args, i, op);
      if (value === -1) return -1;
      if (value < 0 || value >= 0xffff_ffff) throw invalid(op, 'uid and gid must be -1 or a valid id');
      return value;
    };
    const uid = id(1);
    const gid = id(2);
    await chown(path, uid, gid).catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    return {};
  }

  private async utimes(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const path = await this.path(op, argStr(args, 0, op), 'meta', true);
    const accessed = new Date(argI64(args, 1, op));
    const modified = new Date(argI64(args, 2, op));
    if (Number.isNaN(accessed.getTime())) throw invalid(op, 'atime is out of range');
    if (Number.isNaN(modified.getTime())) throw invalid(op, 'mtime is out of range');
    const handle = await open(path, 'r').catch((raised: Error) => {
      throw this.io(op, path, raised);
    });
    try {
      await handle.utimes(accessed, modified);
    } catch (raised) {
      throw this.io(op, path, raised instanceof Error ? raised : new Error(String(raised)));
    } finally {
      await handle.close();
    }
    return {};
  }
}
