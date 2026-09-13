/**
 * `trait`-typed config knob `none` (owner ruling 2026-09-13).
 *
 * The compiler leaves a `trait`-typed `@config.<knob>` UNSUBSTITUTED in a
 * guard/condition position (`orbital-compiler/src/phases/inline/{trait,
 * rewrite}.rs`'s `canonicalize_unbound_trait_override`/field-type exclusion),
 * so the runtime's generic `if`-effect handling is what actually decides
 * "unbound → falsy": no trait-specific code in `EffectExecutor` — plain JS
 * truthiness of the resolved `@config.<knob>` value (`null` for `none`, a
 * non-empty `@trait.<Name>` string when bound) does the whole job. This test
 * pins that contract directly against the real binding resolver + effect
 * executor, so a future change to either can't silently break it.
 */

import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import type { TraitConfigObject } from '@almadar/core';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';

function makeExecutor(config: TraitConfigObject) {
    const set = vi.fn();
    const handlers = stubEffectHandlers({ emit: vi.fn(), set });
    const bindings: BindingContext = {
        entity: { id: 'ent-1' },
        config,
    };
    const context: EffectContext = {
        traitName: 'ServiceDriveDrive',
        state: 'idle',
        transition: 'INIT->idle',
    };
    return { set, executor: new EffectExecutor({ handlers, bindings, context }) };
}

describe('unbound trait-typed config knob guard truthiness', () => {
    it('an unbound (none -> null) uiTrait is falsy — the (if @config.uiTrait ...) guard takes the else branch', async () => {
        const { set, executor } = makeExecutor({ uiTrait: null });
        await executor.execute([
            'if',
            '@config.uiTrait',
            ['set', '@entity.rendered', 'bound-form'],
            ['set', '@entity.rendered', 'cleared'],
        ]);
        expect(set).toHaveBeenCalledWith('ent-1', 'rendered', 'cleared');
        expect(set).not.toHaveBeenCalledWith('ent-1', 'rendered', 'bound-form');
    });

    it('a bound uiTrait (a @trait.<Name> string) is truthy — the guard takes the then branch', async () => {
        const { set, executor } = makeExecutor({ uiTrait: '@trait.ServiceDriveDefaultForm' });
        await executor.execute([
            'if',
            '@config.uiTrait',
            ['set', '@entity.rendered', 'bound-form'],
            ['set', '@entity.rendered', 'cleared'],
        ]);
        expect(set).toHaveBeenCalledWith('ent-1', 'rendered', 'bound-form');
        expect(set).not.toHaveBeenCalledWith('ent-1', 'rendered', 'cleared');
    });
});
