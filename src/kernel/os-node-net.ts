/**
 * The `net` family on Node `net`, `dgram` and `dns`: TCP, UDP and name resolution. It mirrors `os_host/net.rs`
 * of the native host: every target is checked with the kernel's grants before any syscall, a destination named
 * by a host name must resolve to public addresses only, every socket carries a 5 s read and write timeout, a
 * connect waits 10 s, and `recv` returns at most 64 MiB from one read. Listening and port watching are the
 * native `unsupported`.
 */
import { lookup } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { createConnection, isIP, type Socket } from 'node:net';
import type { JsonValue } from '@almadar/core';
import type { OsOp } from '@almadar/core/kernel-wire';
import type { OsGrantPort, OsNetKind } from './os-port.js';
import {
  argBytes,
  argI64,
  argOpt,
  argStr,
  ByteSource,
  bytesValue,
  denied,
  errnoCode,
  errnoError,
  invalid,
  netFailure,
  osFailure,
  TextIoError,
  writeAll,
  type Datagram,
  type Deferral,
  type OsState,
  type SockEntry,
} from './os-node-support.js';

const IO_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RECV = 64 * 1024 * 1024;
const MAX_DATAGRAM = 65_535;
const SOCKET_HIGH_WATER = 1024 * 1024;

const NET_OPS: ReadonlySet<OsOp> = new Set<OsOp>([
  'os/tcp-connect', 'os/tcp-listen', 'os/send', 'os/recv', 'os/udp-bind', 'os/sendto', 'os/recvfrom', 'os/dns-resolve', 'os/shutdown', 'os/watch-port',
]);

export function isNetOp(op: OsOp): boolean {
  return NET_OPS.has(op);
}

interface Address {
  address: string;
  family: 4 | 6;
}

const LOOKUP_FAILED = process.platform === 'darwin' ? 'nodename nor servname provided, or not known' : 'Name or service not known';

function hostArg(args: JsonValue[], i: number, op: OsOp): string {
  const name = argStr(args, i, op).replace(/^\[+/, '').replace(/\]+$/, '');
  if (name === '') throw osFailure('invalid', op, 'the host is empty');
  return name;
}

function portArg(args: JsonValue[], i: number, op: OsOp): number {
  const port = argI64(args, i, op);
  if (port < 0 || port > 65535) throw osFailure('invalid', op, 'the port must be 0 to 65535');
  return port;
}

function countArg(args: JsonValue[], i: number, op: OsOp): number {
  const count = argI64(args, i, op);
  if (count < 0) throw osFailure('invalid', op, 'the count must not be negative');
  return count;
}

function peerText(address: string, port: number, family: string): string {
  return family === 'IPv6' ? `[${address}]:${port}` : `${address}:${port}`;
}

function streamFailure(op: OsOp, error: Error): ReturnType<typeof netFailure> {
  const code = errnoCode(error);
  return netFailure(op, code !== undefined && code.startsWith('ERR_STREAM') ? errnoError('EPIPE') : error);
}

export class NetOps {
  constructor(private readonly state: OsState, private readonly grants: OsGrantPort) {}

  private checkGrant(op: OsOp, name: string, port: number, kind: OsNetKind): void {
    if (!this.grants.allows({ need: 'net', host: name, port, kinds: [kind] })) {
      throw denied(op, `${name}:${port} is not granted`);
    }
  }

  private async resolve(op: OsOp, name: string): Promise<Address[]> {
    const found = await lookup(name, { all: true, verbatim: true }).catch((raised: Error) => raised);
    if (found instanceof Error) {
      const text = errnoCode(found) === 'ENOTFOUND' ? `failed to lookup address information: ${LOOKUP_FAILED}` : found.message;
      throw osFailure('not-found', op, `${name} did not resolve: ${text}`);
    }
    if (found.length === 0) throw osFailure('not-found', op, `${name} has no addresses`);
    return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
  }

  private async outbound(op: OsOp, name: string): Promise<Address[]> {
    const literal = isIP(name);
    if (literal !== 0) return [{ address: name, family: literal === 6 ? 6 : 4 }];
    const addresses = await this.resolve(op, name);
    const closed = addresses.find((entry) => !this.grants.isPublicAddress(entry.address));
    if (closed !== undefined) throw denied(op, `${name} resolves to ${closed.address}, not a public address`);
    return addresses;
  }

  private streamEntry(op: OsOp, id: number): Extract<SockEntry, { kind: 'stream' }> {
    const entry = this.state.socks.get(id);
    if (entry === undefined) throw osFailure('closed', op, 'not an open socket');
    if (entry.kind !== 'stream') throw osFailure('invalid', op, 'not a connected stream socket');
    return entry;
  }

  private datagramEntry(op: OsOp, id: number): Extract<SockEntry, { kind: 'datagram' }> {
    const entry = this.state.socks.get(id);
    if (entry === undefined) throw osFailure('closed', op, 'not an open socket');
    if (entry.kind !== 'datagram') throw osFailure('invalid', op, 'not a datagram socket');
    return entry;
  }

  /** `None` of the native `answer`: an `os/close` of a handle this table does not own. */
  closeOwned(args: JsonValue[]): boolean {
    const id = argI64(args, 0, 'os/close');
    const entry = this.state.socks.get(id);
    if (entry === undefined) return false;
    this.state.socks.delete(id);
    if (entry.kind === 'stream') entry.socket.destroy();
    else entry.socket.close();
    return true;
  }

  async run(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    switch (op) {
      case 'os/tcp-connect':
        return this.tcpConnect(op, args);
      case 'os/send':
        return this.send(op, args);
      case 'os/recv':
        return this.recv(op, args);
      case 'os/udp-bind':
        return this.udpBind(op, args);
      case 'os/sendto':
        return this.sendto(op, args);
      case 'os/recvfrom':
        return this.recvfrom(op, args);
      case 'os/dns-resolve':
        return this.dnsResolve(op, args);
      case 'os/shutdown':
        return this.shutdown(op, args);
      default:
        throw osFailure('unsupported', op, 'streaming host not implemented');
    }
  }

  private connectOnce(address: Address, port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: address.address, port, autoSelectFamily: false });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TextIoError('ETIMEDOUT', 'connection timed out'));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async tcpConnect(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const name = hostArg(args, 0, op);
    const port = portArg(args, 1, op);
    this.checkGrant(op, name, port, 'tcp');
    let last: Error | undefined;
    for (const address of await this.outbound(op, name)) {
      const outcome = await this.connectOnce(address, port).catch((raised: Error) => raised);
      if (outcome instanceof Error) {
        last = outcome;
        continue;
      }
      const id = this.state.allocate();
      this.state.socks.set(id, { kind: 'stream', socket: outcome, source: new ByteSource(outcome, SOCKET_HIGH_WATER), shut: false });
      return { sock: id };
    }
    if (last === undefined) throw osFailure('io', op, 'no address to connect to');
    throw netFailure(op, last);
  }

  private async send(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const id = argI64(args, 0, op);
    const data = argBytes(args, 1, op);
    const entry = this.streamEntry(op, id);
    if (entry.shut) throw netFailure(op, errnoError('EPIPE'));
    await writeAll(entry.socket, data, IO_TIMEOUT_MS).catch((raised: Error) => {
      throw streamFailure(op, raised);
    });
    return { bytes: data.length };
  }

  private async recv(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    return (await this.recvLater(op, args)())();
  }

  /** `os/recv` after its checks; a keyed ask under a route reads in the background (EXEC-QUEUE-10). */
  recvLater(op: OsOp, args: JsonValue[]): Deferral {
    const id = argI64(args, 0, op);
    const want = Math.min(countArg(args, 1, op), MAX_RECV);
    const entry = this.streamEntry(op, id);
    return async () => {
      if (entry.shut) {
        const ended = { data: bytesValue(Buffer.alloc(0)), eof: want > 0 };
        return () => ended;
      }
      const taken = await entry.source.take(want, IO_TIMEOUT_MS).catch((raised: Error) => {
        throw netFailure(op, raised);
      });
      if (taken === 'timeout') throw netFailure(op, errnoError('EAGAIN'));
      const answer = { data: bytesValue(taken), eof: taken.length === 0 && want > 0 };
      return () => answer;
    };
  }

  private bindOnce(address: Address, port: number): Promise<SockEntry> {
    return new Promise<SockEntry>((resolve, reject) => {
      const socket = createSocket(address.family === 6 ? 'udp6' : 'udp4');
      const entry: Extract<SockEntry, { kind: 'datagram' }> = { kind: 'datagram', socket, inbox: [], failure: undefined, wake: undefined };
      socket.on('message', (data, info) => {
        entry.inbox.push({ data, peer: peerText(info.address, info.port, info.family) });
        entry.wake?.();
      });
      socket.on('error', (error) => {
        entry.failure = error;
        entry.wake?.();
        reject(error);
      });
      socket.once('listening', () => resolve(entry));
      socket.bind(port, address.address);
    });
  }

  private async udpBind(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const name = hostArg(args, 0, op);
    const port = portArg(args, 1, op);
    this.checkGrant(op, name, port, 'udp');
    let last: Error | undefined;
    for (const address of await this.resolve(op, name)) {
      const bound = await this.bindOnce(address, port).catch((raised: Error) => raised);
      if (bound instanceof Error) {
        last = bound;
        continue;
      }
      const id = this.state.allocate();
      this.state.socks.set(id, bound);
      return { sock: id };
    }
    throw last === undefined ? osFailure('io', op, 'no address to bind') : netFailure(op, last);
  }

  private async sendto(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const id = argI64(args, 0, op);
    const data = argBytes(args, 1, op);
    const name = hostArg(args, 2, op);
    const port = portArg(args, 3, op);
    this.checkGrant(op, name, port, 'udp');
    const entry = this.datagramEntry(op, id);
    let last: Error | undefined;
    for (const address of await this.outbound(op, name)) {
      const sent = await new Promise<Error | undefined>((resolve) => {
        entry.socket.send(data, port, address.address, (error) => resolve(error ?? undefined));
      });
      if (sent === undefined) return { bytes: data.length };
      last = sent;
    }
    throw last === undefined ? osFailure('io', op, 'no address to send to') : netFailure(op, last);
  }

  private async nextDatagram(entry: Extract<SockEntry, { kind: 'datagram' }>): Promise<Datagram | Error> {
    const deadline = Date.now() + IO_TIMEOUT_MS;
    for (;;) {
      const queued = entry.inbox.shift();
      if (queued !== undefined) return queued;
      if (entry.failure !== undefined) return entry.failure;
      const left = deadline - Date.now();
      if (left <= 0) return errnoError('EAGAIN');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        entry.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private async recvfrom(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    return (await this.recvfromLater(op, args)())();
  }

  /** `os/recvfrom` after its checks; a keyed ask under a route reads in the background (EXEC-QUEUE-10). */
  recvfromLater(op: OsOp, args: JsonValue[]): Deferral {
    const id = argI64(args, 0, op);
    const want = Math.min(countArg(args, 1, op), MAX_RECV, MAX_DATAGRAM);
    const entry = this.datagramEntry(op, id);
    return async () => {
      const received = await this.nextDatagram(entry);
      if (received instanceof Error) throw netFailure(op, received);
      const answer = { data: bytesValue(received.data.subarray(0, want)), peer: received.peer };
      return () => answer;
    };
  }

  private async dnsResolve(op: OsOp, args: JsonValue[]): Promise<JsonValue> {
    const name = hostArg(args, 0, op);
    let family: number | undefined;
    if (argOpt(args, 1) !== undefined) {
      family = argI64(args, 1, op);
      if (family !== 4 && family !== 6) throw invalid(op, 'the family must be 4 or 6');
    }
    if (!this.grants.allows({ need: 'net', host: name, port: 0, kinds: ['tcp', 'udp'] })) {
      throw denied(op, `${name}:0 is not granted`);
    }
    const seen: string[] = [];
    for (const entry of await this.resolve(op, name)) {
      const wanted = family === undefined || family === entry.family;
      if (wanted && !seen.includes(entry.address)) seen.push(entry.address);
    }
    if (seen.length === 0) throw osFailure('not-found', op, `${name} has no address of that family`);
    return { addresses: seen };
  }

  private shutdown(op: OsOp, args: JsonValue[]): JsonValue {
    const id = argI64(args, 0, op);
    const entry = this.streamEntry(op, id);
    if (entry.socket.destroyed) throw netFailure(op, errnoError('ENOTCONN'));
    entry.socket.end();
    entry.shut = true;
    return {};
  }
}
