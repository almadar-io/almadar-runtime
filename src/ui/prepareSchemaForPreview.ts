/**
 * prepareSchemaForPreview
 *
 * Single source of truth for the "give an Orbital schema a runnable preview"
 * pipeline. Used by both:
 *   * `<OrbPreview autoMock />` (the docs / MDX path)
 *   * `PlaygroundContent` (the interactive playground)
 *
 * Type signature in `@almadar/core` terms:
 *
 *   buildMockData          : OrbitalSchema → EntityData
 *   adjustSchemaForMockData: (OrbitalSchema, EntityData) → OrbitalSchema
 *   prepareSchemaForPreview: OrbitalSchema → { schema: OrbitalSchema, mockData: EntityData }
 *
 * Steps:
 *   1. `buildMockData` — for each orbital, generate (or pick up from
 *     `entity.instances`) `EntityRow[]` for that entity.
 *   2. `adjustSchemaForMockData` — flip two-state INIT machines so the data
 *      state is initial (e.g. `empty -> hasItems` becomes `hasItems` initial).
 *
 * @packageDocumentation
 */

import { isEntityCall } from '@almadar/core';
import { perfStart, perfEnd } from './perf';
import type {
  OrbitalSchema,
  Orbital,
  OrbitalEntity,
  EntityField,
  EntityRow,
  EntityData,
  FieldValue,
  Trait,
  TraitRef,
  StateMachine,
  State,
  Transition,
} from '@almadar/core';

// ---------------------------------------------------------------------------
// buildMockData
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic `EntityRow` for one entity at the given index.
 *
 * @internal
 */
function generateEntityRow(entity: OrbitalEntity, idx: number): EntityRow {
  const row: EntityRow = { id: String(idx) };
  for (const f of entity.fields) {
    if (f.name === undefined || f.name === 'id') continue;
    row[f.name] = generateFieldValue(entity.name, f, idx);
  }
  return row;
}

/**
 * Generate a `FieldValue` for one entity field at the given index.
 *
 * @internal
 */
function generateFieldValue(
  entityName: string,
  field: EntityField,
  idx: number,
): FieldValue {
  if ('values' in field && field.values && field.values.length > 0) {
    return field.values[(idx - 1) % field.values.length];
  }
  const fieldName = field.name ?? '';
  switch (field.type) {
    case 'string':
      return `${entityName} ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} ${idx}`;
    case 'number':
      return idx * 10;
    case 'boolean':
      return idx % 2 === 0;
    default:
      return (field.default as FieldValue | undefined) ?? null;
  }
}

/**
 * Build mock entity rows (`EntityData`) for every orbital in the schema.
 *
 * @public
 */
export function buildMockData(schema: OrbitalSchema): EntityData {
  const t = perfStart('build-mock-data');
  const result: EntityData = {};
  for (const orbital of schema.orbitals) {
    const entity = orbital.entity;
    if (!entity || typeof entity === 'string') continue;
    if (isEntityCall(entity)) continue;
    const entityName = entity.name;
    if (!entityName) continue;

    if (entity.instances && entity.instances.length > 0) {
      result[entityName] = entity.instances;
      continue;
    }

    const rows: EntityRow[] = Array.from({ length: 10 }, (_, i) =>
      generateEntityRow(entity, i + 1),
    );
    result[entityName] = rows;
  }

  for (const orbital of schema.orbitals) {
    for (const traitRef of orbital.traits ?? []) {
      if (!isInlineTrait(traitRef)) continue;
      const trait = traitRef;
      const sourceEntity = trait.sourceEntityDefinition;
      if (!sourceEntity || isEntityCall(sourceEntity)) continue;
      const sourceName = sourceEntity.name;
      if (!sourceName) continue;

      if (!result[sourceName]) {
        result[sourceName] =
          sourceEntity.instances && sourceEntity.instances.length > 0
            ? sourceEntity.instances
            : Array.from({ length: 10 }, (_, i) =>
                generateEntityRow(sourceEntity, i + 1),
              );
      }

      const reboundName = trait.linkedEntity;
      if (!reboundName || reboundName === sourceName) continue;
      const reboundRows = result[reboundName];
      if (!reboundRows || reboundRows.length === 0) continue;

      reboundRows.forEach((row, i) => {
        for (const f of sourceEntity.fields) {
          if (f.name === undefined || f.name === 'id') continue;
          if (row[f.name] !== undefined) continue;
          row[f.name] = generateFieldValue(sourceName, f, i + 1);
        }
      });
    }
  }

  perfEnd('build-mock-data', t, { orbitalCount: schema.orbitals.length, entityCount: Object.keys(result).length });
  return result;
}

// ---------------------------------------------------------------------------
// adjustSchemaForMockData
// ---------------------------------------------------------------------------

/**
 * Type guard: a TraitRef is an inline `Trait` when it has a `stateMachine` field.
 *
 * @internal
 */
function isInlineTrait(traitRef: TraitRef): traitRef is Trait {
  return (
    typeof traitRef === 'object' &&
    traitRef !== null &&
    'stateMachine' in traitRef
  );
}

/**
 * Find a non-initial state in `sm` that handles INIT.
 *
 * @internal
 */
function findDataState(sm: StateMachine, initialStateName: string): State | undefined {
  return sm.states.find((s) => {
    if (s.name === initialStateName) return false;
    return sm.transitions.some(
      (t: Transition) =>
        t.event === 'INIT' &&
        (t.from === s.name ||
          (Array.isArray(t.from) && (t.from as string[]).includes(s.name))),
    );
  });
}

/**
 * Rewrite a single trait so the "data state" becomes initial.
 *
 * @internal
 */
function rewriteTraitInitialState(trait: Trait, mockData: EntityData): Trait {
  const sm = trait.stateMachine;
  if (!sm) return trait;

  const linkedEntity = trait.linkedEntity;
  if (!linkedEntity || !mockData[linkedEntity]?.length) return trait;

  const initialStateName =
    sm.states.find((s) => s.isInitial)?.name ?? sm.states[0]?.name;
  if (!initialStateName) return trait;

  const dataState = findDataState(sm, initialStateName);
  if (!dataState) return trait;

  const updatedStates: State[] = sm.states.map((s) => {
    if (s.name === initialStateName) return { ...s, isInitial: false };
    if (s.name === dataState.name) return { ...s, isInitial: true };
    return s;
  });

  return { ...trait, stateMachine: { ...sm, states: updatedStates } };
}

/**
 * When mock data exists for a trait's linked entity, swap the state
 * machine's initial state to the state that also handles INIT.
 *
 * @public
 */
export function adjustSchemaForMockData(
  schema: OrbitalSchema,
  mockData: EntityData,
): OrbitalSchema {
  let changed = false;
  const updatedOrbitals: Orbital[] = schema.orbitals.map((orbital) => {
    const traits = orbital.traits ?? [];
    const updatedTraits: TraitRef[] = traits.map((traitRef) => {
      if (!isInlineTrait(traitRef)) return traitRef;
      const updated = rewriteTraitInitialState(traitRef, mockData);
      if (updated !== traitRef) changed = true;
      return updated;
    });
    return changed ? { ...orbital, traits: updatedTraits } : orbital;
  });

  return changed ? { ...schema, orbitals: updatedOrbitals } : schema;
}

// ---------------------------------------------------------------------------
// prepareSchemaForPreview
// ---------------------------------------------------------------------------

/**
 * Result of `prepareSchemaForPreview`.
 *
 * @public
 */
export interface PreparedPreviewSchema {
  /** Schema with state machines flipped so data states are initial. */
  schema: OrbitalSchema;
  /** Mock entity rows keyed by entity name — pass to `OrbPreview.mockData`. */
  mockData: EntityData;
}

/**
 * Run the full preview prep pipeline on a schema.
 *
 * Accepts either an already-parsed `OrbitalSchema` or a JSON string.
 *
 * @public
 */
export function prepareSchemaForPreview(
  input: OrbitalSchema | string,
): PreparedPreviewSchema {
  const parsed: OrbitalSchema =
    typeof input === 'string' ? (JSON.parse(input) as OrbitalSchema) : input;
  const mockData = buildMockData(parsed);
  const schema = adjustSchemaForMockData(parsed, mockData);
  return { schema, mockData };
}
