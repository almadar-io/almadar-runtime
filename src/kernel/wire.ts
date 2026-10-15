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
  inFlight(): number;
  getState(traitName: string, entityId?: string): string;
  setDefaultUser(userJson: string): void;
  mount(traitsJson: string): void;
  remount(traitsJson: string): void;
  setTickMount(traitsJson: string): void;
  setCapabilities(entityType: string, queryJson: string, writeJson: string): void;
  setMessages(localesJson: string, catalogsJson: string): void;
  lastError(): string;
  free(): void;
}

/** An initialised `@almadar/kernel` module: what `OrbitalServerRuntime({ engine: 'kernel' })` is handed. */
export interface KernelModule {
  Server: new (resolvedSchemaJson: string) => KernelServerHandle;
}
