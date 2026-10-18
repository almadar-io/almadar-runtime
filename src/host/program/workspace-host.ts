import type { ServiceCallContext } from '../../types.js';

/**
 * The slice of a workspace the program host drives: write a file into it and snapshot it.
 * `@almadar/runtime` implements it over `std-workspace` on the kernel.
 */
export interface WorkspacePort {
  /** The workspace's absolute directory. */
  readonly workDir: string;
  writeFile(relPath: string, content: string): Promise<void>;
  snapshot(reason: string): Promise<{ oid: string } | null>;
  listSnapshots(opts?: { limit?: number }): Promise<Array<{ id: string; timestamp: number; reason: string }>>;
}

/**
 * Where a host keeps its workspaces, and how it opens the one a call names as
 * the calling principal (it owns access). A workspace lives at
 * `<root>/<owner>/<session>` (`owner` = {@link workspaceOwnerSegment} of the principal).
 */
export interface WorkspaceHost {
  readonly root: string;
  open(workspace: string, context: ServiceCallContext): Promise<WorkspacePort>;
}

let installedHost: WorkspaceHost | null = null;

/** Install the host's workspaces; called once at boot. */
export function installWorkspaceHost(host: WorkspaceHost): void {
  installedHost = host;
}

/** Testing/reset hook. */
export function uninstallWorkspaceHost(): void {
  installedHost = null;
}

/** The installed workspace host, or null on a host that keeps none. */
export function installedWorkspaceHost(): WorkspaceHost | null {
  return installedHost;
}

/**
 * A principal's workspace directory name: letters, digits and `-` kept, every
 * other UTF-8 byte (including `_`) written as `_` plus two hex digits. One
 * path segment per principal, reversible, so no two principals share one.
 * The same encoding `std-workspace` gives its owner and workspace directories.
 */
export function workspaceOwnerSegment(principal: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(principal)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9-]/.test(ch) ? ch : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}
