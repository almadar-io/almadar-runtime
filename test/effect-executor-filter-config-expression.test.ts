/**
 * std-browse's `initialFilterValue` knob holds an EXPRESSION
 * (`@entity.activeChannel` — the issuing trait's own frame). The Rust resolver
 * splices knob defaults into the filter at resolve time; the JS interpreted
 * path keeps `@config.X` in the filter, so the per-row evaluation compared
 * `row.channel` against the literal string "@entity.activeChannel" and
 * std-realtime-chat's thread never listed a message. A config leaf in a filter
 * resolves against the trait's config, and an `@entity.*` value it yields
 * resolves against the trait's frame — exactly as a spliced default would.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SExpr } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type EffectHandlers } from '../src/index.js';

describe('EffectExecutor fetch filter — config leaves', () => {
  it('resolves @config knobs (field names and expression values) against the issuing trait', async () => {
    const seen: Array<SExpr | undefined> = [];
    const fetch: EffectHandlers['fetch'] = async (_entity, options) => {
      const filter = options?.filter;
      seen.push(Array.isArray(filter) || typeof filter === 'string' ? filter : undefined);
      return null;
    };
    const handlers = stubEffectHandlers({ emit: vi.fn(), fetch });
    const bindings: BindingContext = {
      entity: { id: 'e1', activeChannel: 'Channel Id 6' },
      config: { initialFilterField: 'channel', initialFilterValue: '@entity.activeChannel' },
    };
    const context: EffectContext = { traitName: 'ChatThread', state: 'loading', transition: 'loading->loading' };
    const executor = new EffectExecutor({ handlers, bindings, context });
    await executor.execute(['fetch', 'ChatMessage', {
      filter: ['=', ['object/get', '@entity', '@config.initialFilterField'], '@config.initialFilterValue'],
    }]);
    expect(seen[0]).toEqual(['=', ['object/get', '@entity', 'channel'], 'Channel Id 6']);
  });
});
