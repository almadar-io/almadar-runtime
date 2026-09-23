import { describe, it, expect } from 'vitest';
import { ServerLegCollector } from '../src/server-leg.js';
import type { Effect } from '../src/types.js';

// The JS twin of orbital-core's `runtime::server_leg` unit tests
// (`collects_and_drains`, `ignores_non_server_targets`) — see
// `orbital-rust/crates/orbital-core/src/runtime/server_leg.rs`.

function persistEffect(): Effect {
    return ['persist', 'create', 'Note', { title: 'x' }];
}

describe('ServerLegCollector', () => {
    it('collects and drains', () => {
        const collector = new ServerLegCollector();
        collector.delegate(persistEffect(), 'server');
        collector.delegate(persistEffect(), 'server');
        const drained = collector.drain();
        expect(drained).toHaveLength(2);
        // Drain leaves it empty for the next dispatch.
        expect(collector.drain()).toEqual([]);
    });

    it('ignores non-server targets', () => {
        const collector = new ServerLegCollector();
        collector.delegate(persistEffect(), 'client');
        expect(collector.drain()).toEqual([]);
    });

    it('preserves collection order', () => {
        const collector = new ServerLegCollector();
        const first: Effect = ['persist', 'create', 'Note', { title: 'first' }];
        const second: Effect = ['fetch', 'Note', { id: 'n-1' }];
        collector.delegate(first, 'server');
        collector.delegate(second, 'server');
        expect(collector.drain()).toEqual([first, second]);
    });
});
