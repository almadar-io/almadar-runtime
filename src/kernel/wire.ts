import type { KernelEvaluatorExports } from '@almadar/core';

/**
 * The server-role kernel's wire is `@almadar/core/kernel-wire` (generated from orbital-core `embed::wire`);
 * re-exported here for the kernel module's callers. Only the `Server` class surface lives in this file.
 */
export type {
  CallerWire,
  CallRoutesWire,
  CallSiteWire,
  HttpBody,
  HttpFailureWire,
  HttpRequestWire,
  HttpResponseWire,
  IoAnswerWire,
  IoReplyWire,
  IoRequestWire,
  PendingRequestWire,
  ResolveProgressWire,
  ServerProgressWire,
  Settled,
  SubstrateFailureWire,
} from '@almadar/core/kernel-wire';

/** The `Server` class of `@almadar/kernel` (wasm-bindgen), as the runtime uses it. */
export interface KernelServerHandle {
  start(orbital: string, requestJson: string): string;
  resume(flight: number, repliesJson: string): string;
  /** A row-set reference resolved for a viewer through the host-answered store; a `ResolveProgressWire` as JSON. */
  resolveRows(refJson: string, viewerJson: string): string;
  resumeResolve(flight: number, repliesJson: string): string;
  abandon(flight: number): boolean;
  /** `OsGrants::allows` over the grants the registered program declares; `requirementJson` is an `OsRequirement`. */
  osAllows(requirementJson: string): boolean;
  inFlight(): number;
  getState(traitName: string, entityId?: string): string;
  setDefaultUser(userJson: string): void;
  mount(traitsJson: string): void;
  remount(traitsJson: string): void;
  setTickMount(traitsJson: string): void;
  /** Mock-seed the `[runtime]` entities the kernel holds itself, owner columns stamped with `viewerId` (a preview host). */
  seedRuntimeMock(viewerId?: string): void;
  setCapabilities(entityType: string, queryJson: string, writeJson: string): void;
  setMessages(localesJson: string, catalogsJson: string): void;
  lastError(): string;
  free(): void;
}

/** The `Server` constructor of a kernel module. `withStore` exists on the native add-on only. */
export interface KernelServerClass {
  new (resolvedSchemaJson: string): KernelServerHandle;
  /**
   * A server that answers its own row asks from the store `envJson` (a JSON object of environment variables:
   * `DATA_BACKEND`, `NODE_ENV`, `DATABASE_URL`, `COUCHDB_URL`, the Firebase variables) selects, so the host is asked
   * only for the rest. Absent on the wasm module, which has no sockets.
   */
  withStore?(resolvedSchemaJson: string, envJson: string): KernelServerHandle;
}

/** An initialised `@almadar/kernel` module: what `OrbitalServerRuntime({ engine: 'kernel' })` is handed. */
export interface KernelModule extends KernelEvaluatorExports {
  Server: KernelServerClass;
  /** Whether the absolute `glob` matches `path`, as the one-grant matcher `os/glob` filters with. */
  osGlobMatches(glob: string, path: string): boolean;
  /** `is_public_address`: the rule an outbound host name must pass. */
  isPublicAddress(ip: string): boolean;
  /** The `os/` operations whose keyed call may defer its completion (`OsOp::defers_completion`), as a JSON array of names. */
  osDeferringOps(): string;
  /** The `{ event, payload }` JSON a deferred keyed `os/` call's outcome fires on its call site, or `null` when it declares no route. */
  osCompletionEvent(siteJson: string, key: string, outcomeJson: string): string;
  /** Whether the Chrome match pattern matches the URL: the one rule a browser-tab host filters tabs with. */
  tabUrlMatches(pattern: string, url: string): boolean;
  /** `credential_admin::seed_plan_json`: the declared credentials a `store`-source boot copies from the env, as `[{ service, envVar }]` JSON. */
  credentialSeedPlan(declaredJson: string, heldJson: string, presentJson: string): string;
}
