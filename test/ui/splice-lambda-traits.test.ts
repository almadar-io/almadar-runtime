/**
 * Lambda-scope splice — JS-interpreter twin of the compiler's
 * `orbital-compiler/src/phases/inline/splice.rs`.
 *
 * A render-only `@trait.X` reference inside a `["fn", …]` render subtree
 * (data-list `renderItem`) is spliced in place with the wrapper's config
 * applied, its emits merged onto the host, and the consumed wrapper dropped
 * from the resolved traits + pages. Outside a lambda the reference is left for
 * the normal embed path. These tests pin the same five behaviours the Rust
 * `#[cfg(test)]` suite pins, plus a per-item binding-resolution check proving
 * the spliced expressions resolve in the lambda's per-item scope.
 */

import { describe, it, expect } from 'vitest';
import type { Effect, Page, SExpr, Trait } from '@almadar/core';
import {
  spliceLambdaTraitRefs,
  LambdaSpliceError,
  type SpliceResolvedTrait,
  type SpliceResolvedPage,
} from '../../src/ui/splice-lambda-traits.js';
import { interpolateValue, createContextFromBindings } from '../../src/BindingResolver.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface RenderOnlyOpts {
  emits?: Trait['emits'];
  config?: Trait['config'];
  extraState?: boolean;
}

function renderOnlyTrait(name: string, pattern: SExpr, opts: RenderOnlyOpts = {}): Trait {
  const states = [{ name: 'idle', isInitial: true }];
  if (opts.extraState) states.push({ name: 'open', isInitial: false });
  return {
    name,
    scope: 'collection',
    linkedEntity: 'Item',
    emits: opts.emits,
    config: opts.config,
    stateMachine: {
      states,
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', pattern]] as Effect[],
        },
      ],
    },
  } as Trait;
}

function resolved(trait: Trait): SpliceResolvedTrait & { source: { type: 'inline' } } {
  return { trait, source: { type: 'inline' } };
}

function lambdaRenderPattern(children: SExpr[]): SExpr {
  return {
    type: 'data-list',
    items: '@entity.parties',
    renderItem: ['fn', 'party', { type: 'stack', children }],
  };
}

function hostPatternOf(traits: SpliceResolvedTrait[], name: string): SExpr {
  const t = traits.find((r) => r.trait.name === name);
  if (!t) throw new Error(`trait ${name} not found`);
  const effects = t.trait.stateMachine?.transitions[0].effects as SExpr[];
  return (effects[0] as SExpr[])[2] as SExpr;
}

function traitNames(traits: SpliceResolvedTrait[]): string[] {
  return traits.map((r) => r.trait.name);
}

function makePage(name: string, traitRefs: string[]): SpliceResolvedPage {
  return {
    page: {
      name,
      path: `/${name.toLowerCase()}`,
      traits: traitRefs.map((ref) => ({ ref })),
    } as Page,
  };
}

// ---------------------------------------------------------------------------
// (1) Splice + config substitution + per-item resolution
// ---------------------------------------------------------------------------

describe('spliceLambdaTraitRefs — render-only wrapper in a lambda', () => {
  it('splices the wrapper pattern with config applied, removes it from traits + pages, and resolves per item', () => {
    const wrapper = renderOnlyTrait(
      'InlineW1',
      { type: 'text', text: '@config.content' },
      { config: { content: { type: 'string', default: '@party.title' } } },
    );
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineW1']));
    const traits = [resolved(host), resolved(wrapper)];
    const pages = [makePage('Main', ['Host', 'InlineW1'])];

    spliceLambdaTraitRefs(traits, pages);

    const json = JSON.stringify(hostPatternOf(traits, 'Host'));
    expect(json).toContain('@party.title');
    expect(json).not.toContain('@trait.InlineW1');
    expect(json).not.toContain('@config.content');

    // Wrapper consumed: gone from the orbital + the page list (page not emptied).
    expect(traitNames(traits)).toEqual(['Host']);
    expect(pages[0].page.traits?.map((t) => t.ref)).toEqual(['Host']);

    // Per-item: the spliced expression resolves in the lambda's per-item scope.
    const pattern = hostPatternOf(traits, 'Host') as { renderItem: SExpr[] };
    const body = pattern.renderItem[2] as { children: SExpr[] };
    const spliced = body.children[0];
    for (const title of ['Alpha', 'Beta']) {
      const ctx = createContextFromBindings({
        entity: {},
        payload: {},
        state: 'idle',
        locals: new Map([['party', { title }]]),
      });
      const out = interpolateValue(spliced, ctx) as { text: string };
      expect(out.text).toBe(title);
    }
  });

  it('never empties a page: a page listing only the wrapper keeps it', () => {
    const wrapper = renderOnlyTrait('InlineW1', { type: 'text', text: '@config.content' }, {
      config: { content: { type: 'string', default: '@party.title' } },
    });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineW1']));
    const traits = [resolved(host), resolved(wrapper)];
    // The wrapper is the sole trait on its own page — removal would empty it.
    const pages = [makePage('Main', ['Host']), makePage('Solo', ['InlineW1'])];

    spliceLambdaTraitRefs(traits, pages);

    // Splice still happened on the host pattern…
    expect(JSON.stringify(hostPatternOf(traits, 'Host'))).toContain('@party.title');
    // …but the wrapper survives because dropping it would empty the Solo page.
    expect(traitNames(traits)).toContain('InlineW1');
    expect(pages[1].page.traits?.map((t) => t.ref)).toEqual(['InlineW1']);
  });
});

// ---------------------------------------------------------------------------
// (2) Emit merge — dedup + conflict
// ---------------------------------------------------------------------------

describe('spliceLambdaTraitRefs — emit merge', () => {
  const emit = (event: string, field: string): Trait['emits'] => [
    { event, payloadSchema: [{ name: field, type: 'string' }] },
  ];

  it('merges the wrapper emits onto the host, deduped by event name', () => {
    const wrapper = renderOnlyTrait('InlineW1', { type: 'button', action: 'ACTION' }, {
      emits: emit('ACTION', 'id'),
    });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineW1']));
    // Host already declares an identical ACTION emit → dedup, no duplicate.
    host.emits = emit('ACTION', 'id');
    const traits = [resolved(host), resolved(wrapper)];

    spliceLambdaTraitRefs(traits, []);

    const hostTrait = traits.find((t) => t.trait.name === 'Host')!.trait;
    const actionEmits = (hostTrait.emits ?? []).filter((e) => e.event === 'ACTION');
    expect(actionEmits).toHaveLength(1);
    expect(traitNames(traits)).toEqual(['Host']);
  });

  it('adds a wrapper emit the host does not have', () => {
    const wrapper = renderOnlyTrait('InlineW1', { type: 'button', action: 'ACTION' }, {
      emits: emit('ACTION', 'id'),
    });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineW1']));
    const traits = [resolved(host), resolved(wrapper)];

    spliceLambdaTraitRefs(traits, []);

    const hostTrait = traits.find((t) => t.trait.name === 'Host')!.trait;
    expect((hostTrait.emits ?? []).some((e) => e.event === 'ACTION')).toBe(true);
  });

  it('throws EMIT_MERGE_CONFLICT when the same event has a different payload shape', () => {
    const wrapper = renderOnlyTrait('InlineW1', { type: 'button', action: 'ACTION' }, {
      emits: emit('ACTION', 'id'),
    });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineW1']));
    host.emits = emit('ACTION', 'differentField');
    const traits = [resolved(host), resolved(wrapper)];

    try {
      spliceLambdaTraitRefs(traits, []);
      expect.unreachable('expected EMIT_MERGE_CONFLICT');
    } catch (e) {
      expect(e).toBeInstanceOf(LambdaSpliceError);
      expect((e as LambdaSpliceError).code).toBe('EMIT_MERGE_CONFLICT');
    }
  });
});

// ---------------------------------------------------------------------------
// (3) Stateful wrapper in a lambda — hard error
// ---------------------------------------------------------------------------

describe('spliceLambdaTraitRefs — stateful wrapper in lambda', () => {
  it('throws LAMBDA_STATEFUL_TRAIT', () => {
    const stateful = renderOnlyTrait('Modal', { type: 'modal' }, { extraState: true });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.Modal']));
    const traits = [resolved(host), resolved(stateful)];

    try {
      spliceLambdaTraitRefs(traits, []);
      expect.unreachable('expected LAMBDA_STATEFUL_TRAIT');
    } catch (e) {
      expect(e).toBeInstanceOf(LambdaSpliceError);
      expect((e as LambdaSpliceError).code).toBe('LAMBDA_STATEFUL_TRAIT');
      expect((e as Error).message).toContain('Modal');
    }
  });
});

// ---------------------------------------------------------------------------
// (4) Reference outside a lambda — untouched embed path (regression pin)
// ---------------------------------------------------------------------------

describe('spliceLambdaTraitRefs — reference outside a lambda', () => {
  it('leaves the @trait.X reference and the wrapper in place', () => {
    const wrapper = renderOnlyTrait('InlineW1', { type: 'badge' });
    const host = renderOnlyTrait('Host', { type: 'stack', children: ['@trait.InlineW1'] });
    const traits = [resolved(host), resolved(wrapper)];
    const pages = [makePage('Main', ['Host', 'InlineW1'])];

    spliceLambdaTraitRefs(traits, pages);

    expect(JSON.stringify(hostPatternOf(traits, 'Host'))).toContain('@trait.InlineW1');
    expect(traitNames(traits)).toEqual(['Host', 'InlineW1']);
    expect(pages[0].page.traits?.map((t) => t.ref)).toEqual(['Host', 'InlineW1']);
  });
});

// ---------------------------------------------------------------------------
// (5) Nested wrappers + cycle guard
// ---------------------------------------------------------------------------

describe('spliceLambdaTraitRefs — recursion', () => {
  it('splices nested wrapper children recursively', () => {
    const inner = renderOnlyTrait('InlineInner', { type: 'icon' });
    const outer = renderOnlyTrait('InlineOuter', {
      type: 'badge',
      children: ['@trait.InlineInner'],
    });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.InlineOuter']));
    const traits = [resolved(host), resolved(outer), resolved(inner)];

    spliceLambdaTraitRefs(traits, []);

    const json = JSON.stringify(hostPatternOf(traits, 'Host'));
    expect(json).not.toContain('@trait.');
    expect(json).toContain('icon');
    expect(traitNames(traits)).toEqual(['Host']);
  });

  it('terminates on a wrapper reference cycle without looping', () => {
    const a = renderOnlyTrait('CycleA', { type: 'stack', children: ['@trait.CycleB'] });
    const b = renderOnlyTrait('CycleB', { type: 'stack', children: ['@trait.CycleA'] });
    const host = renderOnlyTrait('Host', lambdaRenderPattern(['@trait.CycleA']));
    const traits = [resolved(host), resolved(a), resolved(b)];

    // Must return; the cycle edge stays a reference for the validator.
    expect(() => spliceLambdaTraitRefs(traits, [])).not.toThrow();
  });
});
