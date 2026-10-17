/**
 * Node-only: the program host's workspaces, kept by `std-workspace` on the kernel. A workspace is a git repository under
 * `<project>/workspaces/<owner>/<workspace>`; the atom does every file and git call through the program's own `os` grants,
 * and this host only fires its events and reads what it emits.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '@almadar/core';
import type { IntegrationCallContext } from '@almadar/integrations';
import { workspaceOwnerSegment, type WorkspaceHost, type WorkspacePort } from '@almadar/integrations/program';
import { emitPayload, KernelProgram, resolveProgramFile, type KernelProgramOptions, type ProgramRun } from './program-node.js';

/** Workspaces kept in a bucket through `std-storage` over SigV4 (Google Cloud Storage's S3 interoperability endpoint with HMAC keys). */
export interface KernelWorkspaceBucket {
  /** The bucket name. */
  name: string;
  /** The S3-compatible origin; `https://storage.googleapis.com` for Google Cloud Storage. */
  endpoint: string;
  /** The signing region; `auto` for Google Cloud Storage. */
  region: string;
  /** The name of the credential (an environment variable) holding the HMAC access key id. */
  accessKeyId: string;
  /** The name of the credential (an environment variable) holding the HMAC secret. */
  secretAccessKey: string;
}

export const GCS_ENDPOINT = 'https://storage.googleapis.com';
export const WORKSPACE_HMAC_KEY_ID = 'ALMADAR_WORKSPACE_HMAC_KEY_ID';
export const WORKSPACE_HMAC_SECRET = 'ALMADAR_WORKSPACE_HMAC_SECRET';

/** The bucket a host's environment names: `ALMADAR_WORKSPACE_BUCKET` on Google Cloud Storage, keyed by the two HMAC credentials; absent, the project's disk. */
export function workspaceBucketFromEnv(env: Record<string, string | undefined>): KernelWorkspaceBucket | undefined {
  const name = env.ALMADAR_WORKSPACE_BUCKET;
  if (name === undefined || name === '') return undefined;
  return { name, endpoint: GCS_ENDPOINT, region: 'auto', accessKeyId: WORKSPACE_HMAC_KEY_ID, secretAccessKey: WORKSPACE_HMAC_SECRET };
}

export interface KernelWorkspaceHostOptions {
  /** Keep the workspaces in this bucket (the project's `workspaces/` directory is then a cache); absent, on the project's disk. */
  bucket?: KernelWorkspaceBucket;
  /** The project the program host runs `orb` in; workspaces live under its `workspaces/` directory. */
  projectRoot: string;
  /** The `orb` binary that resolves the generated program; absent, the host's default resolution. */
  orb?: string;
  /** How the kernel is loaded; the `os` answerer is always on. */
  kernel?: Omit<KernelProgramOptions, 'os'>;
}

const ORBITAL = 'Workspaces';
const TRAIT = `${ORBITAL}WorkspaceClient`;

/** Where a project keeps its workspaces. */
export function workspacesRoot(projectRoot: string): string {
  return join(projectRoot, 'workspaces');
}

/** The program that opens `std-workspace` with its root named, and the `fs` and `exec` grants it needs. */
function programText(root: string, bucket: KernelWorkspaceBucket | undefined): string {
  const egress = bucket === undefined ? '' : `\n  egress: [${JSON.stringify(bucket.endpoint)}],`;
  return `app kernel-workspace-host [
  version: "1.0.0",
  description: "The program host's workspaces, run by std-workspace.",${egress}
  fs: { ${JSON.stringify(`${root}/**`)}: [read, write, create, remove] },
  exec: ["git"]
]
uses Ws from "std/behaviors/std-workspace"
orbital ${ORBITAL} = Ws.orbitals.WorkspaceOrbital {${bucket === undefined ? `
  traits { WorkspaceClient { config { root: ${JSON.stringify(root)} } } }` : `
  traits {
    WorkspaceClient { config { root: ${JSON.stringify(root)}, store: bucket, bucket: ${JSON.stringify(bucket.name)} } }
    WorkspaceStore { config { endpoint: ${JSON.stringify(bucket.endpoint)}, region: ${JSON.stringify(bucket.region)}, bucket: ${JSON.stringify(bucket.name)}, accessKeyId: ${JSON.stringify(bucket.accessKeyId)}, secretAccessKey: ${JSON.stringify(bucket.secretAccessKey)} } }
  }`}
}
`;
}

function failure(run: ProgramRun, failed: string, what: string): Error {
  const detail = emitPayload(run, failed, (p) => (typeof p.message === 'string' ? p.message : ''));
  return new Error(`workspace ${what} failed: ${detail ?? run.error ?? 'no answer'}`);
}

interface Snapshot { id: string; timestamp: number; reason: string }

function snapshots(payload: EventPayload): Snapshot[] {
  const rows = payload.snapshots;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) =>
    typeof row === 'object' && row !== null && !Array.isArray(row) && typeof row.id === 'string' && typeof row.timestamp === 'number' && typeof row.reason === 'string'
      ? [{ id: row.id, timestamp: row.timestamp, reason: row.reason }]
      : [],
  );
}

/**
 * The workspace host over `std-workspace`: one kernel program for the host, opened on first use, one request at a time.
 * Each call runs as the calling principal (`@user.id`), which the atom turns into the owner directory.
 */
export function kernelWorkspaceHost(options: KernelWorkspaceHostOptions): WorkspaceHost {
  const root = workspacesRoot(options.projectRoot);
  let program: Promise<KernelProgram> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const open = (): Promise<KernelProgram> => {
    program ??= (async () => {
      mkdirSync(root, { recursive: true });
      const granted = realpathSync(root);
      const dir = mkdtempSync(join(tmpdir(), 'almadar-workspace-host-'));
      try {
        const file = join(dir, 'workspace-host.lolo');
        writeFileSync(file, programText(granted, options.bucket));
        const schema = await resolveProgramFile(file, options.projectRoot, options.orb);
        return await KernelProgram.open(schema, { ...options.kernel, os: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    return program;
  };

  const run = <T>(principal: string, event: string, payload: EventPayload, read: (run: ProgramRun) => T): Promise<T> => {
    const next = tail.then(async () => read(await (await open()).dispatch(ORBITAL, event, payload, TRAIT, { id: principal })));
    tail = next.catch(() => undefined);
    return next;
  };

  return {
    root,
    async open(workspace: string, context: IntegrationCallContext): Promise<WorkspacePort> {
      const principal = context.principal;
      if (principal === undefined || principal === '') throw new Error('A workspace needs a signed-in caller');
      return {
        workDir: join(root, workspaceOwnerSegment(principal), workspaceOwnerSegment(workspace)),
        writeFile: (path, content) =>
          run(principal, 'WORKSPACE_WRITE_FILE', { workspace, path, content }, (r) => {
            if (emitPayload(r, 'WORKSPACE_FILE_WRITTEN', (p) => p.written) !== true) throw failure(r, 'WORKSPACE_WRITE_FAILED', `write of ${path}`);
          }),
        snapshot: (reason) =>
          run(principal, 'WORKSPACE_SNAPSHOT', { workspace, reason }, (r) => {
            const taken = emitPayload(r, 'WORKSPACE_SNAPSHOT_TAKEN', (p) => ({ committed: p.committed === true, oid: typeof p.oid === 'string' ? p.oid : '' }));
            if (taken === undefined) throw failure(r, 'WORKSPACE_SNAPSHOT_FAILED', 'snapshot');
            return taken.committed ? { oid: taken.oid } : null;
          }),
        listSnapshots: (opts) =>
          run(principal, 'WORKSPACE_HISTORY', { workspace, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) }, (r) => {
            const found = emitPayload(r, 'WORKSPACE_HISTORY_LOADED', snapshots);
            if (found === undefined) throw failure(r, 'WORKSPACE_HISTORY_FAILED', 'history');
            return found;
          }),
      };
    },
  };
}
