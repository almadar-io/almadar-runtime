/**
 * `@entity` / `$<TypeParam>` payload-sentinel resolution — JS twin of
 * `orbital-compiler/phases/inline/rewrite.rs`'s `resolve_type_param_sentinels`
 * + `flatten_bare_entity_payload` + `resolve_type_arg_value` +
 * `resolve_sentinel_fields` (C1-J1). The JS resolver never ran a sentinel
 * pass at all — `TraitReference.typeArgs` / `Trait.typeParams` existed in
 * `@almadar/core` but nothing consumed them, so a surviving `@entity`/`$<p>`
 * payload field went straight through to codegen unresolved.
 *
 * This module resolves every sentinel a DECLARED trait sees: a call-site
 * `:: p SomeType` type-arg (`TraitReference.typeArgs`, threaded in by
 * `reference-resolver.ts` onto `ResolvedTrait.typeArgs` at trait-ref
 * resolution — the twin of Rust's `trait_def.type_args`, stashed at the
 * same point and consumed here), the `@entity` self-reference, an
 * Entity-kind type param's own default (the trait's `linkedEntity`) when no
 * arg was supplied, and the legacy (Increment 3-I) bare-alias sentinel with
 * no matching declared param (C1-J3).
 */
import type { Entity, EntityField, EventPayloadField, Trait } from "@almadar/core";

/** Mirrors Rust's `PRIMITIVE_TYPE_ARG_NAMES` — the primitive vocabulary a
 * call-site/declared type-param default may name. */
const PRIMITIVE_TYPE_ARG_NAMES = new Set<string>([
  "string",
  "money",
  "any",
  "icon",
  "component",
  "email",
  "url",
  "phone",
  "uuid",
  "image",
  "node",
  "json",
  "render-ui",
  "relation",
  "int",
  "float",
  "number",
  "duration",
  "bool",
  "boolean",
  "date",
  "datetime",
  "timestamp",
  "object",
  "sexpr",
  "scalar",
]);

/** The synthetic field name `orbital-lolo` gives a payload lowered from a
 * BARE type position — mirrors Rust's `BARE_PAYLOAD_CARRIER`. */
const BARE_PAYLOAD_CARRIER = "value";

/** A resolved substitution for one declared type param — mirrors Rust's `ParamSub`. */
export type ParamSub =
  | { readonly kind: "scalar"; readonly primitive: string }
  | { readonly kind: "entity"; readonly entity: Entity }
  | { readonly kind: "struct"; readonly shape: readonly EventPayloadField[] };

/**
 * Resolve a call-site/declared-default type-parameter argument's VALUE to a
 * substitution — twin of Rust's `resolve_type_arg_value`.
 */
export function resolveTypeArgValue(
  value: string,
  entitiesByName: ReadonlyMap<string, Entity>,
  typesByName: Readonly<Record<string, readonly EventPayloadField[]>>,
): ParamSub | undefined {
  if (PRIMITIVE_TYPE_ARG_NAMES.has(value)) {
    return { kind: "scalar", primitive: value };
  }
  const entity = entitiesByName.get(value);
  if (entity) {
    return { kind: "entity", entity };
  }
  const shape = typesByName[value];
  if (shape) {
    return { kind: "struct", shape };
  }
  return undefined;
}

/**
 * Flatten an entity's field list into the `EventPayloadField` shape a
 * substituted sentinel carries — twin of Rust's `entity_fields_to_payload_fields`
 * (delegating to `sigil_types::payload_field_of`). Flat, one field per entity
 * field; no recursion into relations.
 */
function entityFieldToPayloadField(f: EntityField): EventPayloadField {
  if (f.type === "object" && f.items) {
    const valueType = fieldTypeTagOf(f.items);
    return {
      name: f.name ?? "",
      type: `Map<string,${valueType}>`,
      ...(f.required !== undefined ? { required: f.required } : {}),
    };
  }
  let properties: EventPayloadField[] | undefined;
  if (f.type === "object" && f.properties) {
    properties = Object.values(f.properties).map(entityFieldToPayloadField);
  } else if (f.type === "union" && f.properties) {
    const ordered = f.values ?? Object.keys(f.properties);
    properties = ordered
      .map((k) => f.properties?.[k])
      .filter((v): v is EntityField => v !== undefined)
      .map(entityFieldToPayloadField);
  } else if (f.type === "array" && f.items) {
    properties = entityFieldToPayloadField(f.items).properties as EventPayloadField[] | undefined;
  }
  const isArrayOfStruct = f.type === "array" && properties !== undefined;
  return {
    name: f.name ?? "",
    type: isArrayOfStruct ? "[object]" : fieldTypeTagOf(f),
    ...(f.required !== undefined ? { required: f.required } : {}),
    ...(properties && properties.length > 0 ? { properties } : {}),
  };
}

function fieldTypeTagOf(f: EntityField): string {
  return f.type;
}

/** The bound entity's fields as `EventPayloadField[]` — twin of Rust's
 * `entity_fields_to_payload_fields`. */
export function entityFieldsToPayloadFields(entity: Entity): EventPayloadField[] {
  return entity.fields.map(entityFieldToPayloadField);
}

/**
 * Canonicalize a BARE entity payload (the single synthetic `"value"` field a
 * bare-typed `Event @entity` / `Event $E` lowers to) so it matches the flat
 * shape a concrete `Event Note` produces — twin of Rust's
 * `flatten_bare_entity_payload`. Mutates `fields` in place when it flattens;
 * returns whether it did.
 */
export function flattenBareEntityPayload(
  fields: EventPayloadField[],
  entityDef: Entity | undefined,
  subs: ReadonlyMap<string, ParamSub>,
): boolean {
  if (fields.length !== 1) return false;
  const field = fields[0];
  if (field.name !== BARE_PAYLOAD_CARRIER) return false;

  let entity: Entity | undefined;
  if (field.type === "@entity") {
    entity = entityDef;
  } else if (field.type === "object" && field.properties) {
    entity = entityDef;
  } else if (field.type.startsWith("$")) {
    const sub = subs.get(field.type.slice(1));
    entity = sub?.kind === "entity" ? sub.entity : undefined;
  }
  if (!entity) return false;

  fields.length = 0;
  fields.push(...entityFieldsToPayloadFields(entity));
  return true;
}

/**
 * Recursive worker — a field whose `type` is `"@entity"`/`"[@entity]"` (the
 * self-reference) or `"$<param>"`/`"[$<param>]"` (a declared type param) is
 * the sentinel; every other field's `properties` (if any) is walked for a
 * nested sentinel. Twin of Rust's `resolve_sentinel_fields`. Mutates `fields`
 * in place; returns whether anything changed.
 */
export function resolveSentinelFields(
  fields: EventPayloadField[],
  entityDef: Entity | undefined,
  subs: ReadonlyMap<string, ParamSub>,
  declaredNames: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const field of fields) {
    const isSelfRef = field.type === "@entity" || field.type === "[@entity]";
    if (isSelfRef) {
      if (entityDef) {
        const isArray = field.type.startsWith("[");
        field.type = isArray ? "[object]" : "object";
        field.properties = entityFieldsToPayloadFields(entityDef);
        field.entity = entityDef.name;
        changed = true;
      }
      continue;
    }

    const isArraySentinel = field.type.startsWith("[$") && field.type.endsWith("]");
    const isBareSentinel = !isArraySentinel && field.type.startsWith("$");
    if (isBareSentinel || isArraySentinel) {
      const paramName = isArraySentinel
        ? field.type.slice(2, -1)
        : field.type.slice(1);
      const sub = subs.get(paramName);
      if (sub) {
        switch (sub.kind) {
          case "scalar":
            field.type = isArraySentinel ? `[${sub.primitive}]` : sub.primitive;
            field.properties = undefined;
            break;
          case "entity":
            field.type = isArraySentinel ? "[object]" : "object";
            field.properties = entityFieldsToPayloadFields(sub.entity);
            field.entity = sub.entity.name;
            break;
          case "struct":
            field.type = isArraySentinel ? "[object]" : "object";
            field.properties = [...sub.shape];
            break;
        }
        changed = true;
        continue;
      }
      if (declaredNames.has(paramName)) {
        // A declared param with no resolvable substitution — leave the
        // sentinel for the validator's ORB_T_UNRESOLVED_TYPE_PARAM sweep.
        // Never falls through to the unconditional legacy-alias default
        // below (reserved for sentinels with NO matching declared param).
        continue;
      }
      // Legacy (Increment 3-I) bare-alias sentinel — no declared trait
      // param of this name — unconditional default to `entityDef`. Stamps
      // `field.entity` too (the arm-4 asymmetry fix, Stage C): the
      // self-ref and declared-param-entity arms above already stamp it.
      if (entityDef) {
        field.type = isArraySentinel ? "[object]" : "object";
        field.properties = entityFieldsToPayloadFields(entityDef);
        field.entity = entityDef.name;
        changed = true;
      }
      continue;
    }

    if (field.properties) {
      const mutableProps = field.properties as EventPayloadField[];
      changed = resolveSentinelFields(mutableProps, entityDef, subs, declaredNames) || changed;
    }
  }
  return changed;
}

/**
 * Resolve every sentinel on ONE trait's `emits`/`stateMachine.events`
 * payload schemas — twin of Rust's `resolve_type_param_sentinels`. For each
 * declared type param: a call-site `typeArgs` entry (`ResolvedTrait.typeArgs`,
 * `reference-resolver.ts`'s twin of `trait_def.type_args`) wins outright when
 * present; otherwise an Entity-kind param defaults to `entityDef` (the
 * trait's own `linkedEntity`); otherwise the param's own declared `= <name>`
 * default is tried. Mutates `trait` in place; returns whether anything
 * changed.
 */
export function resolveTraitTypeParamSentinels(
  trait: Trait,
  entityDef: Entity | undefined,
  entitiesByName: ReadonlyMap<string, Entity>,
  typesByName: Readonly<Record<string, readonly EventPayloadField[]>>,
  typeArgs?: Readonly<Record<string, string>>,
): boolean {
  const declared = trait.typeParams ?? [];
  const subs = new Map<string, ParamSub>();
  const declaredNames = new Set<string>();
  for (const p of declared) {
    declaredNames.add(p.name);
    const argValue = typeArgs?.[p.name];
    let sub: ParamSub | undefined;
    if (argValue !== undefined) {
      sub = resolveTypeArgValue(argValue, entitiesByName, typesByName);
    } else if (p.kind === "Entity" && entityDef) {
      sub = { kind: "entity", entity: entityDef };
    } else if (p.default) {
      sub = resolveTypeArgValue(p.default, entitiesByName, typesByName);
    }
    if (sub) subs.set(p.name, sub);
  }

  let changed = false;
  for (const emit of trait.emits ?? []) {
    if (!emit.payloadSchema) continue;
    const schema = emit.payloadSchema as EventPayloadField[];
    if (flattenBareEntityPayload(schema, entityDef, subs)) {
      changed = true;
    } else {
      changed = resolveSentinelFields(schema, entityDef, subs, declaredNames) || changed;
    }
  }
  for (const ev of trait.stateMachine?.events ?? []) {
    if (!ev.payloadSchema) continue;
    const schema = ev.payloadSchema as EventPayloadField[];
    if (flattenBareEntityPayload(schema, entityDef, subs)) {
      changed = true;
    } else {
      changed = resolveSentinelFields(schema, entityDef, subs, declaredNames) || changed;
    }
  }
  return changed;
}

/**
 * Run sentinel resolution for every trait of ONE resolved orbital, looking
 * up each trait's FINAL `linkedEntity` against the orbital's own (post-
 * resolve) entity set — primary + auxiliary. Twin of Rust's
 * `resolve_orbital_type_param_sentinels`, called once per orbital after
 * `resolve()` fully resolves it (traits, sibling-pull, splice all done).
 */
export function resolveOrbitalTypeParamSentinels(
  traits: readonly { trait: Trait; typeArgs?: Readonly<Record<string, string>> }[],
  primaryEntity: Entity,
  auxiliaryEntities: readonly Entity[],
  orbitalTypes: Readonly<Record<string, readonly EventPayloadField[]>> | undefined,
): void {
  const entitiesByName = new Map<string, Entity>();
  entitiesByName.set(primaryEntity.name, primaryEntity);
  for (const e of auxiliaryEntities) entitiesByName.set(e.name, e);
  const typesByName = orbitalTypes ?? {};
  for (const rt of traits) {
    const entityDef = rt.trait.linkedEntity ? entitiesByName.get(rt.trait.linkedEntity) : undefined;
    resolveTraitTypeParamSentinels(rt.trait, entityDef, entitiesByName, typesByName, rt.typeArgs);
  }
}
