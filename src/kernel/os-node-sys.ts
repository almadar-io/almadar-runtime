/**
 * The `sys` family on Node `os`: the grant gate and the readings that need no platform probing. It mirrors
 * `os_host/sys.rs`. Identity, uptime and load answer from Node `os` (the same libc / kernel reads). The rest answer
 * `unsupported`: cpu and memory differ per platform in what Node counts, disk-usage and mounts need the file-system
 * type name, interface flags and gateway are not in Node `os`, group-of has no Node API, and the desktop tools
 * (notify, speak, brightness, volume, suspend, hibernate) are platform tools Node does not wrap.
 */
import { hostname, loadavg, machine, release, type, uptime, userInfo, version } from 'node:os';
import type { JsonValue } from '@almadar/core';
import type { OsOp } from '@almadar/core/kernel-wire';
import type { OsDesktopKind, OsGrantPort, OsSysKind } from './os-port.js';
import { denied, osFailure } from './os-node-support.js';

const SYS_KIND: Partial<Record<OsOp, OsSysKind>> = {
  'os/uid': 'identity',
  'os/gid': 'identity',
  'os/username': 'identity',
  'os/group-of': 'identity',
  'os/hostname': 'identity',
  'os/uname': 'identity',
  'os/cpu-usage': 'cpu',
  'os/uptime': 'cpu',
  'os/load-avg': 'cpu',
  'os/memory-info': 'memory',
  'os/disk-usage': 'disk',
  'os/mounts': 'disk',
  'os/disk-io': 'disk',
  'os/network-interfaces': 'network',
  'os/network-stats': 'network',
  'os/network-connected': 'network',
  'os/default-gateway': 'network',
  'os/battery-status': 'power-state',
  'os/ac-power': 'power-state',
  'os/thermal-zones': 'power-state',
};

const DESKTOP_KIND: Partial<Record<OsOp, OsDesktopKind>> = {
  'os/notify': 'notify',
  'os/speak': 'speak',
  'os/brightness-get': 'brightness',
  'os/brightness-set': 'brightness',
  'os/volume-get': 'volume',
  'os/volume-set': 'volume',
  'os/volume-mute': 'volume',
  'os/suspend': 'power',
  'os/hibernate': 'power',
};

export function isSysOp(op: OsOp): boolean {
  return op === 'os/clock-monotonic' || op === 'os/watch-cron' || op in SYS_KIND || op in DESKTOP_KIND;
}

const ORIGIN = process.hrtime.bigint();

export class SysOps {
  constructor(private readonly grants: OsGrantPort) {}

  run(op: OsOp): JsonValue {
    const sys = SYS_KIND[op];
    if (sys !== undefined && !this.grants.allows({ need: 'sys', kind: sys })) {
      throw denied(op, `the sys grant ${sys} is missing`);
    }
    const desktop = DESKTOP_KIND[op];
    if (desktop !== undefined && !this.grants.allows({ need: 'desktop', kind: desktop })) {
      throw denied(op, `the desktop grant ${desktop} is missing`);
    }
    switch (op) {
      case 'os/clock-monotonic':
        return { nanos: Number(process.hrtime.bigint() - ORIGIN) };
      case 'os/uid':
        return { uid: process.getuid?.() ?? -1 };
      case 'os/gid':
        return { gid: process.getgid?.() ?? -1 };
      case 'os/username':
        return { username: userInfo().username };
      case 'os/hostname':
        return { hostname: hostname() };
      case 'os/uname':
        return { sysname: type(), nodename: hostname(), release: release(), version: version(), machine: machine() };
      case 'os/uptime':
        return { seconds: uptime() };
      case 'os/load-avg': {
        const [one, five, fifteen] = loadavg();
        return { one, five, fifteen };
      }
      case 'os/watch-cron':
        throw osFailure('unsupported', op, 'streaming host not implemented');
      default:
        throw osFailure('unsupported', op, 'the Node os host does not answer this operation yet (G-ORB-308)');
    }
  }
}
