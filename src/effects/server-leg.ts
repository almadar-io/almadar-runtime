/**
 * The JS twin of `orbital-core`'s `RuntimeEnvironment::Client` +
 * `KernelConfig.delegate` (`orbital-rust/crates/orbital-core/src/runtime/server_leg.rs`).
 *
 * An `EffectExecutor` configured with `environment: 'client'` routes every
 * server-only effect (`persist`/`fetch`/`call-service`) to the configured
 * `delegate` instead of executing it — see `EffectExecutor`'s `persist`/
 * `fetch`/`call-service` cases (the twin of `executor.rs`'s `do_persist`/
 * `do_fetch`/`do_call_service`). `ServerLegCollector` just accumulates what
 * it's handed; a caller (P4, `dispatchWithServerLeg`) drains it right after
 * one dispatch to decide whether that dispatch produced a server leg —
 * `drain()` must be called once per dispatch, immediately after it, or
 * effects from an unrelated call bleed into the wrong server leg.
 *
 * @packageDocumentation
 */

import type { Effect } from '../types.js';

/**
 * Mirrors Rust's `RuntimeEnvironment` enum. JS never runs a server-role
 * executor that delegates back to a client, so `'server'` is the only
 * target an `EffectDelegate` is asked to route to today; the parameter is
 * kept (rather than dropped) to mirror `EffectDelegate::delegate`'s shape
 * field-for-field.
 */
export type DelegateTarget = 'server' | 'client';

/** The JS twin of `orbital-core`'s `EffectDelegate` trait. */
export interface EffectDelegate {
    delegate(effect: Effect, target: DelegateTarget): void;
}

/**
 * Collects effects delegated to the server environment. The JS twin of
 * Rust's `ServerLegCollector` (`runtime/server_leg.rs`).
 */
export class ServerLegCollector implements EffectDelegate {
    private effects: Effect[] = [];
    private source: string | undefined;
    private readonly sources = new Set<string>();

    /** Attribute every effect delegated while `run` executes to `trait`. */
    async attribute(trait: string, run: () => Promise<void>): Promise<void> {
        const previous = this.source;
        this.source = trait;
        try {
            await run();
        } finally {
            this.source = previous;
        }
    }

    /** Traits whose own effects were delegated to the server. */
    delegatingTraits(): ReadonlySet<string> {
        return this.sources;
    }

    delegate(effect: Effect, target: DelegateTarget): void {
        if (target === 'server') {
            this.effects.push(effect);
            if (this.source !== undefined) this.sources.add(this.source);
        }
    }

    /** Take every effect collected since the last drain, leaving the collector empty. */
    drain(): Effect[] {
        const drained = this.effects;
        this.effects = [];
        return drained;
    }
}
