/**
 * Row-level entity access — the single owner of every declared `@read`/
 * `@create`/`@update`/`@delete` directive AND the call-site fetch `filter:`.
 *
 * The JS twin of `orbital-core/src/runtime/entity_access.rs`. An access
 * directive is a per-row predicate evaluated with `@entity` bound to the
 * candidate row (or, for `@create`, the incoming data — no row exists yet)
 * and `@user` bound to the viewer. Every fetch/persist path applies it
 * through here, so the ownership-scoped result narrows identically no
 * matter which trait issued it — the un-bypassable twin of a call-site
 * `filter:`, which a sibling trait can skip simply by not declaring one
 * (R-FETCH-SCOPE-SIBLING-BYPASS).
 *
 * @packageDocumentation
 */

import { evaluate } from '@almadar/evaluator';
import type { SExpr, UserContext, EntityRow, EventPayload } from '@almadar/core';
import type { TraitConfigObject } from '@almadar/core';
import { createContextFromBindings } from './BindingResolver.js';

/** Bind shape every access check evaluates against. */
export interface AccessBindings {
  user?: UserContext;
  payload?: EventPayload;
  /**
   * The issuing trait's call-site config. Required so a policy/filter that
   * reads `@config.*` (e.g. std-browse's blank-scope guard
   * `["=", @config.scopeField, ""]`) resolves the knob instead of getting
   * `undefined` — which a bare `=` comparison never treats as "unset", so
   * the guard fails closed and every row is dropped
   * (R-ENTITY-ACCESS-CONFIG-DROPPED-IN-ROW-CTX).
   */
  config?: TraitConfigObject;
  /**
   * Called when a predicate throws. Evaluation still fails closed (the row is
   * dropped / the mutation denied) — this only surfaces the cause, because a
   * fail-closed policy and a genuinely-empty result look identical from the
   * outside, which is exactly how R-ENTITY-ACCESS-CONFIG-DROPPED-IN-ROW-CTX
   * hid for as long as it did.
   */
  onPredicateError?: (error: unknown) => void;
}

/** The three directives checked against a row before it is written. */
export type MutationOp = 'create' | 'update' | 'delete';

/**
 * The one denial message. Three enforcement paths must produce it identically —
 * `OrbitalServerRuntime` (interpreter), `createServerEffectHandlers` (offline
 * preview), and the TypeScript that `orbital-shell-typescript` emits into a
 * generated app's server — because a consumer distinguishing "denied" from
 * "failed" reads this string. The Rust emitter holds a const mirroring it, and
 * a test asserts the two agree.
 */
export function accessDeniedMessage(op: MutationOp, entityType: string): string {
  return `@${op} denied: the declared access policy for '${entityType}' rejected this row`;
}

/**
 * Retain only the rows BOTH the declared `@read` policy and the call-site
 * `filter:` accept — the policy can only narrow what the call site sees,
 * never widen it. A no-op when neither is declared.
 *
 * A predicate that fails to evaluate drops its row: a filter/policy that
 * cannot be evaluated must never widen the result set.
 *
 * Generic in the row type so a caller's element type survives the call —
 * generated server code chains a typed `filter:` callback straight off the
 * result, and widening `Ticket[]` to `EntityRow[]` would collapse every field
 * to the index signature and break `tsc` on any arithmetic/date comparison.
 */
export function applyRowAccess<T extends EntityRow>(
  rows: T[],
  policy: SExpr | undefined,
  filter: SExpr | undefined,
  bindings: AccessBindings,
): T[] {
  if (policy === undefined && filter === undefined) {
    return rows;
  }
  const predicates = [policy, filter].filter((p): p is SExpr => p !== undefined);
  return rows.filter((entity) => {
    const ctx = createContextFromBindings(
      { entity, payload: bindings.payload, current: entity, user: bindings.user, config: bindings.config },
      false,
    );
    return predicates.every((predicate) => {
      try {
        return Boolean(evaluate(predicate, ctx));
      } catch (err) {
        bindings.onPredicateError?.(err);
        return false;
      }
    });
  });
}

/**
 * Check a declared `@create`/`@update`/`@delete` directive against the row
 * the operation targets. `row` is the incoming data for `create` (no row
 * exists yet) or the EXISTING row fetched fresh for `update`/`delete`.
 *
 * Returns `true` when no policy is declared (today's behavior, unchanged)
 * or the policy evaluates truthy; `false` denies the mutation, including
 * when the predicate fails to evaluate (fail-closed, same rule as reads).
 */
export function checkMutationAccess(
  row: EntityRow,
  policy: SExpr | undefined,
  bindings: AccessBindings,
): boolean {
  if (policy === undefined) {
    return true;
  }
  const ctx = createContextFromBindings(
    { entity: row, payload: bindings.payload, current: row, user: bindings.user, config: bindings.config },
    false,
  );
  try {
    return Boolean(evaluate(policy, ctx));
  } catch (err) {
    bindings.onPredicateError?.(err);
    return false;
  }
}
