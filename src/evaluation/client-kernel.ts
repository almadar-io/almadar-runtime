/**
 * The contract of a client kernel: what a view dispatches into and what it gets back. `@almadar/ui`'s kernel client
 * (over `@almadar/kernel/client`) implements it.
 */
import type { DispatchMode, MountSeed, OrbitalEventRequest, OrbitalEventResponse, TransitionRejection } from '@almadar/core';
import type { CircuitStore } from './circuit-store.js';

/** One `ClientKernel.dispatch()` call's settled outcome. */
export interface ClientKernelOutcome {
  response: OrbitalEventResponse;
  mode: DispatchMode;
  /**
   * True when `onLocal` already received the local arm's response (the leg
   * was posted). `serverEffects` then holds only what the server's fold
   * added — the local ones were painted before the round trip.
   */
  localPainted?: boolean;
  serverEffects?: Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'>;
  /**
   * A tick-lane dispatch: what its post's fold added on top of the local run,
   * once the post settles (undefined when a newer firing superseded it). The
   * drain never waits on it; the caller paints it when it lands.
   */
  tickSettled?: Promise<Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'> | undefined>;
}

/** Per-dispatch hooks: `onLocal` sees the locally-evaluated response before its server leg is sent. */
export interface ClientDispatchHooks {
  onLocal?: (local: OrbitalEventResponse) => void;
}

/** Mount hooks: `onLocal` sees each seed's local response before the mount leg is sent. */
export interface ClientMountHooks {
  onLocal?: (trait: string, local: OrbitalEventResponse) => void;
}

/** One `ClientKernel.dispatchMount()` call's settled outcome. */
export interface ClientMountOutcome {
  /** Each seed's local run, in seed order (already painted through `onLocal`). */
  seeds: Array<{ trait: string; event: string; mode: DispatchMode; local: OrbitalEventResponse }>;
  /** Whether any mount leg was posted. */
  posted: boolean;
  success: boolean;
  error?: string;
  /** Per-trait effect failures the posted legs reported (`effect-failed`). */
  rejections: TransitionRejection[];
  /** What the posted legs added: the server's effects and the emits the client had not run. */
  serverEffects: Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'>;
  emittedEvents: OrbitalEventResponse['emittedEvents'];
}

export interface ClientKernel {
  /**
   * Enqueue one event. FIFO per kernel: this entry's local dispatch → post
   * (per the posting rule) → fold → `store.notify()` all complete before the
   * next queued entry's local dispatch begins — the twin of orbital-client's
   * `ClientKernel::dispatch` being called serially off one queue, ported to
   * JS's single-threaded-but-concurrent-microtask model where two `dispatch`
   * calls made back to back would otherwise interleave.
   *
   * A `request.tick`-stamped entry coalesces onto a pending entry with the
   * SAME `(event, targetTrait)` that is itself tick-stamped — same contract
   * as `@almadar/ui`'s `lib/event-queue-coalesce.ts` `enqueueEvent` (see
   * that file's tests, mirrored in `client-kernel.test.ts`): only the
   * pending entry's `payload` is replaced (its FIFO slot and every other
   * field are kept), a sourceless/non-tick entry is never coalesced, and an
   * entry already shifted off the queue (in flight) is never a coalesce
   * target. Every caller coalesced onto the same pending entry resolves to
   * that ONE entry's eventual outcome.
   *
   * A tick-stamped entry resolves after its LOCAL dispatch; its post goes
   * out on a per-(event, trait) newest-wins lane outside the FIFO, with no
   * rollback, so a tick round trip never delays a command.
   */
  dispatch(request: OrbitalEventRequest, hooks?: ClientDispatchHooks): Promise<ClientKernelOutcome>;
  /**
   * Dispatch a server-pushed live message of THIS client's own running
   * request (`PushTarget` `origin`). Outside the FIFO, because the request
   * producing it is the entry the FIFO is waiting on; progress dispatches run
   * one at a time, in push order, and never mark traits awaiting.
   */
  dispatchProgress(request: OrbitalEventRequest): Promise<ClientKernelOutcome>;
  /**
   * Show the result of a dispatch the host ran on its own (`EventTransport.subscribeHostDispatches`):
   * the host's states, rows and render land in this view. Nothing runs here and nothing is posted,
   * so the dispatch's effects happen once, on the host. Host dispatches fold one at a time, in order.
   */
  foldHostDispatch(request: OrbitalEventRequest, response: OrbitalEventResponse): Promise<ClientKernelOutcome>;
  /**
   * Mount several traits in ONE FIFO entry: every seed's local arm runs and
   * paints, then one `mount` leg per owning orbital is posted and folded.
   */
  dispatchMount(
    seeds: readonly MountSeed[],
    hooks?: ClientMountHooks,
    base?: Pick<OrbitalEventRequest, 'payload' | 'entityId' | 'clientId' | 'locale'>,
  ): Promise<ClientMountOutcome>;
  readonly store: CircuitStore;
}
