/**
 * stage-runner — the bridge between a `TraitIndex` and the shared effect
 * stage: an `EvaluateEffectRunner` that resolves each trait's own stage
 * deps from the index and calls `runServerEffectStage`.
 *
 * This is the runner an index-based host supplies to
 * `evaluateOrbitalEvent` — the stateless per-request handler (fresh
 * manager/frames per request) and any embedded/headless host that has no
 * `OrbitalServerRuntime` session. The stateful server keeps its own
 * runner (it has schema-wide relation/on-delete machinery to inject);
 * everything either host can share lives here, not in two spellings.
 *
 * @packageDocumentation
 */
import type { EntityField, EntityRow, OrbitalSchema, TraitConfig } from '@almadar/core';
import { runServerEffectStage, type DeliverEmit, type ServerEffectStageArgs } from './effect-stage.js';
import { findEntityAmongOrbitals } from './OrbitalTraitParsing.js';
import type { EvaluateEffectRunner } from './evaluateOrbitalEvent.js';
import type { EffectHandlers } from './types.js';
import type { PersistenceAdapter } from './PersistenceAdapter.js';
import type { TraitIndex } from './trait-index.js';
import type { StateMachineManager } from './StateMachineCore.js';

export interface IndexStageRunnerOptions {
  traitIndex: TraitIndex;
  persistence: PersistenceAdapter;
  /** The host's entity-frame map (long-lived `traitFieldStates`, or a
   *  fresh per-request map seeded from the client's round-trip). */
  frames: Map<string, EntityRow>;
  manager: StateMachineManager;
  /** The resolved schema, for access-policy checks (`entityAccessPolicies`).
   *  Null/omitted skips policy evaluation — the pre-unification stateless
   *  path had none (recorded convergence gap, not a behavior change). */
  schema?: OrbitalSchema | null;
  extraEffectHandlers?: Partial<EffectHandlers>;
  deliverEmit?: DeliverEmit;
  debug?: boolean;
  mockMode?: boolean;
}

/**
 * Build the per-trait effect runner for an index-based host. Per trait,
 * the stage deps are resolved from its `IndexedTrait` entry — its host
 * orbital's name/id, its IR trait (emits contracts, payload schemas), its
 * resolved entity, its frame key. The schema-wide relation machinery
 * (`validateRelationCardinality`, `enforceOnDeleteRules`,
 * `populateRelations`) is deliberately NOT supplied — an index-based host
 * has no session-level relation registry; the stage treats them as
 * optional (see `ServerEffectStageDeps`).
 */
export function createIndexStageRunner(options: IndexStageRunnerOptions): EvaluateEffectRunner {
  const { traitIndex, persistence, frames, manager } = options;
  const entityFieldsFor = (entityType: string): EntityField[] =>
    findEntityAmongOrbitals(traitIndex.allEntities, entityType)?.fields ?? [];

  return async (traitName, args: Omit<ServerEffectStageArgs, 'traitName'>) => {
    const entry = traitIndex.byName.get(traitName);
    if (!entry) {
      // The composition skips unknown traits before reaching the runner;
      // this is defense in depth for direct runner callers.
      return;
    }
    await runServerEffectStage(
      {
        persistence,
        frames,
        frameKeyFor: (t) => traitIndex.byName.get(t)?.frameKey ?? t,
        orbitalName: entry.orbitalName,
        ...(entry.orbitalId !== undefined ? { orbitalId: entry.orbitalId } : {}),
        irTraits: [entry.irTrait],
        entity: entry.entity,
        configByTrait: new Map<string, TraitConfig>(
          entry.config !== undefined ? [[traitName, entry.config]] : [],
        ),
        resolvedTraitConfigs: {},
        resolvedSchema: options.schema ?? null,
        registeredOrbitals: traitIndex.orbitals,
        getTraitState: (t) => manager.getState(t),
        intrinsicFieldNames: (entityType) =>
          entityFieldsFor(entityType)
            .filter((field): field is EntityField & { name: string } =>
              field.intrinsic === true && typeof field.name === 'string')
            .map((field) => field.name),
        entityFieldsFor,
        sigilPages: [],
        sigilTheme: 'default',
        ...(options.extraEffectHandlers !== undefined
          ? { extraEffectHandlers: options.extraEffectHandlers }
          : {}),
        ...(options.deliverEmit !== undefined ? { deliverEmit: options.deliverEmit } : {}),
        ...(options.debug !== undefined ? { debug: options.debug } : {}),
        ...(options.mockMode !== undefined ? { mockMode: options.mockMode } : {}),
      },
      { ...args, traitName },
    );
  };
}
