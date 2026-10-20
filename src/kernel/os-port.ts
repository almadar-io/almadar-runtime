/**
 * The `os` ports of a kernel host, with no Node builtin in sight so the browser bundle can import them.
 * The Node answerer is `os-node.ts`; the grant check is the Rust `OsGrants` (`allows` below), never TypeScript.
 */
import type { JsonValue } from '@almadar/core';
import type { CallSiteWire, OsError, OsOp, Settled } from '@almadar/core/kernel-wire';

export type OsFsMode = 'read' | 'write' | 'create' | 'remove' | 'meta';
export type OsNetKind = 'tcp' | 'udp' | 'listen';
export type OsStdioKind = 'in' | 'out' | 'err';
export type OsSysKind = 'cpu' | 'memory' | 'disk' | 'network' | 'power-state' | 'identity';
export type OsDesktopKind = 'notify' | 'speak' | 'brightness' | 'volume' | 'power';

/** One thing an `os/` call needs from the program's grants: the JSON of Rust `OsRequirement`. */
export type OsRequirement =
  | { need: 'fs'; path: string; mode: OsFsMode }
  | { need: 'exec'; command: string }
  | { need: 'net'; host: string; port: number; kinds: OsNetKind[] }
  | { need: 'env'; name: string }
  | { need: 'stdio'; kind: OsStdioKind }
  | { need: 'sys'; kind: OsSysKind }
  | { need: 'desktop'; kind: OsDesktopKind };

/** The grant decisions the wasm kernel owns (`OsGrants::allows`, the one-grant glob matcher, `is_public_address`). */
export interface OsGrantPort {
  /** `OsGrants::allows` over the grants every registered program declares. */
  allows(need: OsRequirement): boolean;
  /** Whether the absolute `glob` (`**`, `*`, `?`) matches `path`, as a one-grant `fs_allows` for read. */
  globMatches(glob: string, path: string): boolean;
  /** `is_public_address`: the rule an outbound host name must pass. */
  isPublicAddress(ip: string): boolean;
}

/** What a host answers an `os` ask with; `close` drops every handle it holds, as the native `OsHandles::close_all`. */
export interface OsHostPort {
  answer(op: OsOp, args: JsonValue[]): Promise<Settled<JsonValue, OsError>>;
  /**
   * `Completions::run_later`: a keyed ask of a completion-deferring op. A failed check (or a key already pending) is the
   * in-place `error`; `ok` means the work runs in the background and its outcome reaches `deliver` once, unless
   * the key is cancelled first. A host with no `defer` answers every ask in place.
   */
  defer?(op: OsOp, args: JsonValue[], key: string, deliver: (outcome: Settled<JsonValue, OsError>) => void): Settled<null, OsError>;
  /** `OsHandles::cancel_completion`: drop the pending completion of `key`; `false` when none is pending. */
  cancel?(key: string): boolean;
  close(): void;
}

/** The event a deferred `os` call's outcome fires on its call site, as the kernel shapes it. */
export interface OsCompletionEvent {
  event: string;
  payload: JsonValue;
}

/** What the wasm kernel decides about a deferred `os` call: which ops defer, and the event an outcome fires. */
export interface OsCompletionPort {
  defers(op: OsOp): boolean;
  event(site: CallSiteWire, key: string, outcome: Settled<JsonValue, OsError>): OsCompletionEvent | null;
}

/** The kernel exports the completion port is built from. */
export interface OsCompletionMatchers {
  osDeferringOps(): string;
  osCompletionEvent(siteJson: string, key: string, outcomeJson: string): string;
}

/** The completion port over the wasm kernel: `OsOp::defers_completion` and `completion_event`, not copied. */
export function kernelOsCompletions(kernel: OsCompletionMatchers): OsCompletionPort {
  const deferring: string[] = JSON.parse(kernel.osDeferringOps());
  return {
    defers: (op) => deferring.includes(op),
    event: (site, key, outcome) => {
      const fired: OsCompletionEvent | null = JSON.parse(kernel.osCompletionEvent(JSON.stringify(site), key, JSON.stringify(outcome)));
      return fired;
    },
  };
}

/** The kernel pieces a grant port is built from: the `Server` handle holding the program's grants and the module-level matchers. */
export interface OsGrantKernel {
  osAllows(requirementJson: string): boolean;
}

export interface OsGrantMatchers {
  osGlobMatches(glob: string, path: string): boolean;
  isPublicAddress(ip: string): boolean;
}

/** The grant port over the wasm kernel: every decision is `OsGrants::allows` and the exports beside it. */
export function kernelOsGrants(matchers: OsGrantMatchers, server: () => OsGrantKernel): OsGrantPort {
  return {
    allows: (need) => server().osAllows(JSON.stringify(need)),
    globMatches: (glob, path) => matchers.osGlobMatches(glob, path),
    isPublicAddress: (ip) => matchers.isPublicAddress(ip),
  };
}

/** Where a host anchors `~/` and `./` paths and grants: the user's home and the directory it started the program in (`orbital-core` `OsAnchors`). */
export interface OsAnchors {
  readonly home?: string;
  readonly start?: string;
}

/** What a written path names under the host's anchors (`OsAnchors::expand`). */
export type AnchoredPath = { kind: 'plain' } | { kind: 'anchored'; path: string } | { kind: 'unknown'; message: string };

export function expandAnchor(anchors: OsAnchors, text: string): AnchoredPath {
  const home = text === '~' ? '' : text.startsWith('~/') ? text.slice(2) : undefined;
  const start = text === '.' ? '' : text.startsWith('./') ? text.slice(2) : undefined;
  const rest = home ?? start;
  if (rest === undefined) return { kind: 'plain' };
  const dir = home !== undefined ? anchors.home : anchors.start;
  if (dir === undefined) return { kind: 'unknown', message: `${text}: this host has no ${home !== undefined ? 'home' : 'start'} directory` };
  return { kind: 'anchored', path: rest === '' ? dir : `${dir.replace(/\/+$/, '')}/${rest}` };
}

/** `path` and, when it lies under the home or start directory, its `~/` and `./` forms (`OsAnchors::forms`). */
function anchoredForms(anchors: OsAnchors, path: string): string[] {
  const forms = [path];
  const under = (dir: string | undefined, prefix: string): void => {
    if (dir === undefined) return;
    const root = dir.replace(/\/+$/, '');
    if (path === root) forms.push(prefix);
    else if (path.startsWith(`${root}/`)) forms.push(`${prefix}${path.slice(root.length + 1)}`);
  };
  under(anchors.home, '~/');
  under(anchors.start, './');
  return forms;
}

/** The grant port a host checks absolute paths through: an fs need also matches the program's `~/` and `./` grants (`OsGrants::fs_allows_at`). */
export function anchoredGrants(grants: OsGrantPort, anchors: OsAnchors): OsGrantPort {
  return {
    ...grants,
    allows: (need) => (need.need === 'fs' ? anchoredForms(anchors, need.path).some((path) => grants.allows({ ...need, path })) : grants.allows(need)),
  };
}
