/**
 * The kernel-backed implementation of `evaluateOrbitalEvent` / `OrbitalServerRuntime`: the Rust kernel
 * (`@almadar/kernel`, WebAssembly) decides every execution step; this host answers the I/O it asks for
 * and nothing else. The continuation of a stopped dispatch never leaves the wasm instance.
 */
import { installKernelEvaluator, isEntityReferenceAny, type EventPayload, type MessageCatalogs, type OrbitalEventRequest, type OrbitalEventResponse, type OrbitalSchema, type RowQueryPage, type RowSetRef, type UserContext } from '@almadar/core';
import { decodeProgress, decodeResolveProgress } from './decode.js';
import { answerRequest, declareCapabilities, type KernelAnswerScope, type KernelHostPorts } from './host.js';
import type { IoReplyWire, KernelModule, KernelServerHandle } from './wire.js';

export class KernelEngine {
  private handle: KernelServerHandle;
  private tickMount: string[] = [];
  private messages: { locales: readonly string[]; catalogs: MessageCatalogs } = { locales: [], catalogs: {} };

  constructor(
    private readonly kernel: KernelModule,
    private readonly schemaJson: string,
    private readonly ports: KernelHostPorts,
    private readonly entityTypes: readonly string[] = [],
    private readonly store?: Readonly<Record<string, string>>,
    forkedFrom?: KernelServerHandle,
  ) {
    installKernelEvaluator(kernel);
    this.handle = forkedFrom?.fork() ?? this.openServer();
    this.declare();
  }

  /**
   * A kernel on the same program, registered once, holding none of this one's session: every trait at its initial
   * state, no rows the kernel held, its locales and mounted ticks kept. A stateless host serves each request a
   * fork (EXEC-DIST-5), `ports` answering it.
   */
  fork(ports: KernelHostPorts = this.ports): KernelEngine {
    const forked = new KernelEngine(this.kernel, this.schemaJson, ports, this.entityTypes, this.store, this.handle);
    forked.tickMount = this.tickMount;
    forked.messages = this.messages;
    return forked;
  }

  /** A server over the host's ports, or over the kernel's own store when `store` selects one (native add-on only). */
  private openServer(): KernelServerHandle {
    if (this.store === undefined) return new this.kernel.Server(this.schemaJson);
    const withStore = this.kernel.Server.withStore;
    if (withStore === undefined) throw new Error("a kernel store needs the native add-on (engine: 'native'); this kernel module has none");
    return withStore.call(this.kernel.Server, this.schemaJson, JSON.stringify(this.store));
  }

  private declare(): void {
    if (this.store !== undefined) return;
    const handle = this.handle;
    declareCapabilities(this.ports.persistence, (entityType, queryJson, writeJson) => handle.setCapabilities(entityType, queryJson, writeJson), this.entityTypes);
  }

  static open(kernel: KernelModule, schema: OrbitalSchema, ports: KernelHostPorts, store?: Readonly<Record<string, string>>): KernelEngine {
    return new KernelEngine(kernel, JSON.stringify(schema), ports, schema.orbitals.flatMap((orbital) => (isEntityReferenceAny(orbital.entity) ? [] : [orbital.entity.name])), store);
  }

  /** A fresh kernel on the same program: every trait back at its initial state. */
  reset(): void {
    this.handle.free();
    this.handle = this.openServer();
    this.declare();
    this.handle.setTickMount(JSON.stringify(this.tickMount));
    this.handle.setMessages(JSON.stringify(this.messages.locales), JSON.stringify(this.messages.catalogs));
  }

  /** The program's declared locales and merged catalogs (a lazy page's behavior contributes its namespaced keys). */
  setMessages(locales: readonly string[], catalogs: MessageCatalogs): void {
    this.messages = { locales, catalogs };
    this.handle.setMessages(JSON.stringify(locales), JSON.stringify(catalogs));
  }

  /** The traits some client has mounted: a tick that is not `[background]` fires only for these. */
  setTickMount(traits: string[]): void {
    this.tickMount = traits;
    this.handle.setTickMount(JSON.stringify(traits));
  }

  /** Mock-seed the `[runtime]` entities the kernel holds itself, owner columns stamped with `viewerId`. */
  seedRuntimeMock(viewerId: string | undefined): void {
    this.handle.seedRuntimeMock(viewerId);
  }

  dispose(): void {
    this.handle.free();
  }

  /** `OsGrants::allows` over the grants of the program this kernel runs. */
  osAllows(requirementJson: string): boolean {
    return this.handle.osAllows(requirementJson);
  }

  /** The current state of a trait instance, `''` when it has none. */
  stateOf(traitName: string, entityId?: string): string {
    return this.handle.getState(traitName, entityId);
  }

  /**
   * `reference` resolved for `scope.user` against the host-answered store (EXEC-RENDER-3): the rows that still
   * match its query and the viewer's `@read` in the reference's order, a missing or hidden row omitted, and `total`
   * re-counted (a `total: none` reference is not re-counted: the total is the resolved window). Each read the
   * kernel makes is answered here, as in `evaluate`.
   */
  async resolveRows(reference: RowSetRef, scope: KernelAnswerScope): Promise<RowQueryPage> {
    const handle = this.handle;
    let progress = decodeResolveProgress(handle.resolveRows(JSON.stringify(reference), JSON.stringify(scope.user ?? null)));
    while (progress.status === 'await') {
      const { flight, requests } = progress;
      let replies: IoReplyWire[];
      try {
        replies = await Promise.all(
          requests.map(async (pending) => ({ id: pending.id, answer: await answerRequest(this.ports, pending.request, scope) })),
        );
      } catch (error) {
        handle.abandon(flight);
        throw error;
      }
      progress = decodeResolveProgress(handle.resumeResolve(flight, JSON.stringify(replies)));
    }
    return { rows: progress.rows, total: progress.total };
  }

  /** Run `request` against `orbital`: start it, answer every request the kernel asks for, resume until done. */
  async evaluate(orbital: string, request: OrbitalEventRequest, scope: KernelAnswerScope): Promise<OrbitalEventResponse> {
    const handle = this.handle;
    let progress = decodeProgress(handle.start(orbital, JSON.stringify(request)));
    while (progress.status === 'await') {
      const { flight, requests } = progress;
      let replies: IoReplyWire[];
      try {
        replies = await Promise.all(
          requests.map(async (pending) => ({ id: pending.id, answer: await answerRequest(this.ports, pending.request, scope) })),
        );
      } catch (error) {
        handle.abandon(flight);
        throw error;
      }
      progress = decodeProgress(handle.resume(flight, JSON.stringify(replies)));
    }
    return progress.response;
  }
}

/** What `evaluateOrbitalEvent` needs to run a request on the kernel instead of the JS composition. */
export interface KernelEvaluation {
  engine: KernelEngine;
  /** The orbital the request is addressed to. */
  orbital: string;
  outsideEventQueue?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * The request as the kernel takes it: the viewer and locale the host resolved, the `_targetTrait` sidecar
 * promoted to `targetTrait`, and the `_activeTraits` sidecar dropped (the kernel's mounted set is explicit,
 * not carried per request).
 */
export function kernelRequest(request: OrbitalEventRequest, user: UserContext | undefined, locale: string | undefined): OrbitalEventRequest {
  const { _activeTraits: _dropped, _targetTrait: sidecarTarget, ...rest }: EventPayload = request.payload ?? {};
  const payload: EventPayload = rest;
  const target = request.targetTrait ?? (typeof sidecarTarget === 'string' ? sidecarTarget : undefined);
  const { payload: _payload, ...others } = request;
  return {
    ...others,
    ...(request.payload !== undefined ? { payload } : {}),
    ...(target !== undefined ? { targetTrait: target } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(locale !== undefined ? { locale } : {}),
  };
}

/** The requesting client stamped on each emit, as the JS host's emit stamp does: a client-driven cascade is told apart from a headless one. */
function withOriginClient(response: OrbitalEventResponse, clientId: string | undefined): OrbitalEventResponse {
  if (clientId === undefined) return response;
  return {
    ...response,
    emittedEvents: response.emittedEvents.map((emitted) =>
      emitted.source === undefined ? emitted : { ...emitted, source: { ...emitted.source, originClientId: emitted.source.originClientId ?? clientId } }),
  };
}

export async function evaluateOnKernel(
  kernel: KernelEvaluation,
  request: OrbitalEventRequest,
  user: UserContext | undefined,
  locale: string | undefined,
): Promise<OrbitalEventResponse> {
  return withOriginClient(await kernel.engine.evaluate(kernel.orbital, kernelRequest(request, user, locale), {
    orbital: kernel.orbital,
    ...(user !== undefined ? { user } : {}),
    ...(request.clientId !== undefined ? { originClientId: request.clientId } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(request.entityId !== undefined ? { entityId: request.entityId } : {}),
    ...(kernel.outsideEventQueue !== undefined ? { outsideEventQueue: kernel.outsideEventQueue } : {}),
  }), request.clientId);
}
