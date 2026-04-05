/**
 * OrbitalServerRuntime - Dynamic Server-Side Orbital Execution
 *
 * This runtime takes an OrbitalSchema and dynamically:
 * 1. Registers all orbitals and their traits
 * 2. Creates Express routes for trait communication
 * 3. Executes state machines server-side
 * 4. Handles cross-orbital event propagation
 *
 * This is the "interpreted" mode - no compilation needed.
 * The compiler generates equivalent static code for production.
 *
 * @example
 * ```typescript
 * import { OrbitalServerRuntime } from '@kflow-builder/shared/runtime';
 * import express from 'express';
 *
 * const app = express();
 * const runtime = new OrbitalServerRuntime();
 *
 * // Register schema (can be loaded from file, API, etc.)
 * runtime.register(orbitalSchema);
 *
 * // Mount orbital routes
 * app.use('/api/orbitals', runtime.router());
 *
 * // Client can now:
 * // POST /api/orbitals/:orbital/events  - Send event to orbital
 * // GET  /api/orbitals/:orbital/state   - Get current state
 * // GET  /api/orbitals                  - List registered orbitals
 * ```
 *
 * @packageDocumentation
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { EventBus } from "./EventBus.js";
import {
  StateMachineManager,
  processEvent,
  createInitialTraitState,
} from "./StateMachineCore.js";
import { EffectExecutor } from "./EffectExecutor.js";
import { LocalPersistenceAdapter } from "./LocalPersistenceAdapter.js";
export { LocalPersistenceAdapter } from "./LocalPersistenceAdapter.js";
import {
  interpolateProps,
  createContextFromBindings,
} from "./BindingResolver.js";
import { evaluate, evaluateGuard } from "@almadar/evaluator";
import type {
  TraitDefinition,
  TraitState,
  EffectHandlers,
  BindingContext,
  EffectContext,
  Effect,
  EntityRow,
  EventPayload,
  EvaluationContextExtensions,
} from "./types.js";
import type {
  FieldValue,
  OrbitalSchema,
  OrbitalDefinition,
  Entity,
  Trait,
  TraitTick,
} from "@almadar/core";
import { isInlineTrait } from "@almadar/core";
import { MockPersistenceAdapter } from "./MockPersistenceAdapter.js";
import {
  preprocessSchema,
  type PreprocessedSchema,
  type EntitySharingMap,
  type EventNamespaceMap,
} from "./UsesIntegration.js";
import {
  type SchemaLoader,
  createUnifiedLoader,
} from "./loader/index.js";
import { createOsHandlers, type OsHandlerResult } from "./createOsHandlers.js";

// ============================================================================
// Types
// ============================================================================

// Uses OrbitalSchema, OrbitalDefinition, Trait, TraitTick from @almadar/core directly.
// No redundant runtime-specific types.

/** @deprecated Use OrbitalSchema from @almadar/core */
export type RuntimeOrbitalSchema = OrbitalSchema;
/** @deprecated Use OrbitalDefinition from @almadar/core */
export type RuntimeOrbital = OrbitalDefinition;
/** @deprecated Use Trait from @almadar/core */
export type RuntimeTrait = Trait;
/** @deprecated Use TraitTick from @almadar/core */
export type RuntimeTraitTick = TraitTick;

/**
 * Registered orbital with runtime state
 */
export interface RegisteredOrbital {
  schema: OrbitalDefinition;
  /** Resolved entity (never a string ref at runtime) */
  entity: Entity;
  /** Resolved inline traits (string refs filtered out) */
  traits: Trait[];
  manager: StateMachineManager;
  entityData: Map<string, EntityRow>; // entityId -> data
}

/**
 * Event sent from client to server
 */
export interface OrbitalEventRequest {
  event: string;
  payload?: EventPayload;
  entityId?: string;
  /** User context for @user bindings (from Firebase auth) */
  user?: {
    uid: string;
    email?: string;
    displayName?: string;
    [key: string]: unknown;
  };
}

/**
 * Response from event processing
 */
export interface OrbitalEventResponse {
  success: boolean;
  transitioned: boolean;
  states: Record<string, string>;
  emittedEvents: Array<{ event: string; payload?: unknown }>;
  /** Entity data fetched by `fetch` effects - keyed by entity type */
  data?: { [entityType: string]: EntityRow | EntityRow[] };
  /** Client-side effects to execute (render-ui, navigate, notify) */
  clientEffects?: Array<unknown>;
  /** Results from server-side effects (persist, call-service, set) */
  effectResults?: EffectResult[];
  error?: string;
}

/**
 * Result of a server-side effect execution.
 * Closes the circuit by returning effect outcomes to the client.
 */
export interface EffectResult {
  /** Effect type that was executed */
  effect: 'persist' | 'call-service' | 'set' | 'ref' | 'deref' | 'swap' | 'atomic';
  /** Action performed (e.g., 'create', 'update', 'delete' for persist) */
  action?: string;
  /** Entity type affected (for persist/set/ref/deref/swap) */
  entityType?: string;
  /** Result data from the effect (entity row for CRUD, summary for batch) */
  data?: EntityRow | { operations: EntityRow[]; completedCount: number; totalCount: number };
  /** Whether the effect succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Loader configuration for resolving `uses` imports
 */
export interface LoaderConfig {
  /** Base path for schema files */
  basePath: string;
  /** Standard library path (filesystem or URL) */
  stdLibPath?: string;
  /** Scoped package paths */
  scopedPaths?: Record<string, string>;
  /** Custom loader instance (overrides basePath/stdLibPath) */
  loader?: SchemaLoader;
}

/**
 * Runtime configuration
 */
export interface OrbitalServerRuntimeConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom effect handlers (for integrating with your data layer) */
  effectHandlers?: Partial<EffectHandlers>;
  /** Persistence adapter for entity data */
  persistence?: PersistenceAdapter;
  /**
   * Data mode:
   * - 'mock': Use faker-generated mock data (default for preview)
   * - 'real': Use actual persistence layer
   */
  mode?: 'mock' | 'real';
  /** Seed for deterministic mock data generation */
  mockSeed?: number;
  /** Number of mock records to generate per entity */
  mockSeedCount?: number;
  /**
   * Loader configuration for resolving `uses` imports.
   * Required when using `registerWithPreprocess` or `autoPreprocess`.
   */
  loaderConfig?: LoaderConfig;
  /**
   * Automatically preprocess schemas on register() to resolve `uses` imports.
   * Requires `loaderConfig` to be set.
   * Default: false
   */
  autoPreprocess?: boolean;
  /**
   * Apply event namespacing to imported traits.
   * Default: true
   */
  namespaceEvents?: boolean;
  /**
   * Root directory for `persistence: "local"` entities.
   * Default: ~/.orb/data/
   */
  localStorageRoot?: string;
  /**
   * Additional fields to spread onto every EvaluationContext.
   * Use this to inject module contexts (e.g., { agent: AgentContext }).
   * The evaluator dispatches agent/* operators to ctx.agent.
   */
  contextExtensions?: EvaluationContextExtensions;
}

/**
 * Adapter for persisting entity data
 */
export interface PersistenceAdapter {
  create(
    entityType: string,
    data: EntityRow,
  ): Promise<{ id: string }>;
  update(
    entityType: string,
    id: string,
    data: EntityRow,
  ): Promise<void>;
  delete(entityType: string, id: string): Promise<void>;
  getById(
    entityType: string,
    id: string,
  ): Promise<EntityRow | null>;
  list(entityType: string): Promise<Array<EntityRow>>;
}

// ============================================================================
// In-Memory Persistence (Default)
// ============================================================================

/**
 * Simple in-memory persistence for development/testing
 */
class InMemoryPersistence implements PersistenceAdapter {
  private data = new Map<string, Map<string, EntityRow>>();
  private idCounter = 0;

  async create(
    entityType: string,
    data: EntityRow,
  ): Promise<{ id: string }> {
    // Use provided ID if it exists, otherwise generate one
    const id = (data.id as string) || `${entityType}-${++this.idCounter}`;
    if (!this.data.has(entityType)) {
      this.data.set(entityType, new Map());
    }
    this.data.get(entityType)!.set(id, { ...data, id });
    return { id };
  }

  async update(
    entityType: string,
    id: string,
    data: EntityRow,
  ): Promise<void> {
    const collection = this.data.get(entityType);
    if (collection?.has(id)) {
      const existing = collection.get(id)!;
      collection.set(id, { ...existing, ...data });
    }
  }

  async delete(entityType: string, id: string): Promise<void> {
    this.data.get(entityType)?.delete(id);
  }

  async getById(
    entityType: string,
    id: string,
  ): Promise<EntityRow | null> {
    return this.data.get(entityType)?.get(id) || null;
  }

  async list(entityType: string): Promise<Array<EntityRow>> {
    const collection = this.data.get(entityType);
    return collection ? Array.from(collection.values()) : [];
  }
}

// ============================================================================
// OrbitalServerRuntime
// ============================================================================

/**
 * Dynamic server-side orbital execution runtime
 */
/**
 * Internal tick binding for tracking active ticks
 */
interface TickBinding {
  orbitalName: string;
  traitName: string;
  tick: RuntimeTraitTick;
  timerId: ReturnType<typeof setInterval>;
}

export class OrbitalServerRuntime {
  protected orbitals = new Map<string, RegisteredOrbital>();
  private eventBus: EventBus;
  private config: OrbitalServerRuntimeConfig;
  private persistence: PersistenceAdapter;
  private listenerCleanups: Array<() => void> = [];
  private tickBindings: TickBinding[] = [];
  private loader: SchemaLoader | null = null;
  private preprocessedCache = new Map<string, PreprocessedSchema>();
  private entitySharingMap: EntitySharingMap = {};
  private eventNamespaceMap: EventNamespaceMap = {};
  private osHandlers: OsHandlerResult | null = null;
  private localPersistence: PersistenceAdapter | null = null;

  constructor(config: OrbitalServerRuntimeConfig = {}) {
    this.config = {
      mode: 'mock', // Default to mock mode for preview
      autoPreprocess: false,
      namespaceEvents: true,
      ...config,
    };
    this.eventBus = new EventBus();

    // Initialize loader if config provided
    if (config.loaderConfig) {
      this.loader = config.loaderConfig.loader ?? createUnifiedLoader({
        basePath: config.loaderConfig.basePath,
        stdLibPath: config.loaderConfig.stdLibPath,
        scopedPaths: config.loaderConfig.scopedPaths,
      });
    }

    // Use MockPersistenceAdapter for mock mode, otherwise use provided or InMemoryPersistence
    if (this.config.mode === 'mock' && !config.persistence) {
      this.persistence = new MockPersistenceAdapter({
        seed: config.mockSeed,
        defaultSeedCount: config.mockSeedCount ?? 6,
        debug: config.debug,
      });
      if (config.debug) {
        console.log('[OrbitalRuntime] Using mock persistence with faker data');
      }
    } else {
      this.persistence = config.persistence || new InMemoryPersistence();
    }

    // Initialize local persistence adapter for persistence: "local" entities
    if (config.localStorageRoot) {
      this.localPersistence = new LocalPersistenceAdapter(config.localStorageRoot);
    }

    // Auto-wire OS handlers (server-side only)
    this.osHandlers = createOsHandlers({
      emitEvent: (type, payload) => this.eventBus.emit(type, payload),
    });
    // Merge OS handlers under user-provided handlers (user can override)
    this.config.effectHandlers = {
      ...this.osHandlers.handlers,
      ...this.config.effectHandlers,
    };
  }

  // ==========================================================================
  // Schema Registration
  // ==========================================================================

  /**
   * Register an OrbitalSchema for execution.
   *
   * If `autoPreprocess` is enabled in config and schema has `uses` declarations,
   * it will be preprocessed first to resolve imports.
   *
   * For explicit preprocessing control, use `registerWithPreprocess()`.
   */
  async register(schema: OrbitalSchema): Promise<void> {
    if (this.config.debug) {
      console.log(`[OrbitalRuntime] Registering schema: ${schema.name}`);
    }

    // Register all orbitals (await to ensure instance seeding completes)
    for (const orbital of schema.orbitals) {
      await this.registerOrbitalAsync(orbital);
    }

    // Set up cross-orbital event listeners
    this.setupEventListeners();

    // Set up scheduled ticks
    this.setupTicks();
  }

  /**
   * Register an OrbitalSchema synchronously (for backward compatibility).
   * Note: This version doesn't wait for instance seeding to complete.
   * Use async register() for guaranteed instance seeding.
   */
  registerSync(schema: OrbitalSchema): void {
    if (this.config.debug) {
      console.log(`[OrbitalRuntime] Registering schema (sync): ${schema.name}`);
    }

    for (const orbital of schema.orbitals) {
      this.registerOrbital(orbital);
    }

    // Set up cross-orbital event listeners
    this.setupEventListeners();

    // Set up scheduled ticks
    this.setupTicks();
  }

  /**
   * Register an OrbitalSchema with preprocessing to resolve `uses` imports.
   *
   * This method:
   * 1. Loads all external orbitals referenced in `uses` declarations
   * 2. Expands entity/trait/page references to inline definitions
   * 3. Builds entity sharing and event namespace maps
   * 4. Caches the preprocessed result
   * 5. Registers the resolved schema
   *
   * @param schema - Schema with potential `uses` declarations
   * @param options - Optional preprocessing options
   * @returns Preprocessing result with entity sharing info
   *
   * @example
   * ```typescript
   * const runtime = new OrbitalServerRuntime({
   *   loaderConfig: {
   *     basePath: '/schemas',
   *     stdLibPath: '/std',
   *   },
   * });
   *
   * const result = await runtime.registerWithPreprocess(schema);
   * if (result.success) {
   *   console.log('Registered with', Object.keys(result.entitySharing).length, 'orbitals');
   * }
   * ```
   */
  async registerWithPreprocess(
    schema: OrbitalSchema,
    options?: { sourcePath?: string }
  ): Promise<{
    success: boolean;
    entitySharing?: EntitySharingMap;
    eventNamespaces?: EventNamespaceMap;
    warnings?: string[];
    errors?: string[];
  }> {
    // Check if preprocessing is possible
    if (!this.loader && !this.config.loaderConfig) {
      return {
        success: false,
        errors: ['Loader not configured. Set loaderConfig in OrbitalServerRuntimeConfig.'],
      };
    }

    // Ensure loader is initialized
    if (!this.loader && this.config.loaderConfig) {
      this.loader = this.config.loaderConfig.loader ?? createUnifiedLoader({
        basePath: this.config.loaderConfig.basePath,
        stdLibPath: this.config.loaderConfig.stdLibPath,
        scopedPaths: this.config.loaderConfig.scopedPaths,
      });
    }

    // Check cache
    const cacheKey = `${schema.name}:${schema.version || '1.0.0'}`;
    const cached = this.preprocessedCache.get(cacheKey);
    if (cached) {
      if (this.config.debug) {
        console.log(`[OrbitalRuntime] Using cached preprocessed schema: ${schema.name}`);
      }
      this.register(cached.schema);
      this.entitySharingMap = { ...this.entitySharingMap, ...cached.entitySharing };
      this.eventNamespaceMap = { ...this.eventNamespaceMap, ...cached.eventNamespaces };
      return {
        success: true,
        entitySharing: cached.entitySharing,
        eventNamespaces: cached.eventNamespaces,
        warnings: cached.warnings,
      };
    }

    if (this.config.debug) {
      console.log(`[OrbitalRuntime] Preprocessing schema: ${schema.name}`);
    }

    // Preprocess schema
    const result = await preprocessSchema(schema, {
      basePath: this.config.loaderConfig?.basePath || '.',
      stdLibPath: this.config.loaderConfig?.stdLibPath,
      scopedPaths: this.config.loaderConfig?.scopedPaths,
      loader: this.loader!,
      namespaceEvents: this.config.namespaceEvents,
    });

    if (!result.success) {
      return {
        success: false,
        errors: result.errors,
      };
    }

    // Cache the result
    this.preprocessedCache.set(cacheKey, result.data);

    // Store sharing maps
    this.entitySharingMap = { ...this.entitySharingMap, ...result.data.entitySharing };
    this.eventNamespaceMap = { ...this.eventNamespaceMap, ...result.data.eventNamespaces };

    // Register the preprocessed schema
    this.register(result.data.schema);

    return {
      success: true,
      entitySharing: result.data.entitySharing,
      eventNamespaces: result.data.eventNamespaces,
      warnings: result.data.warnings,
    };
  }

  /**
   * Get entity sharing information for registered orbitals.
   * Useful for determining entity isolation and collection names.
   */
  getEntitySharing(): EntitySharingMap {
    return { ...this.entitySharingMap };
  }

  /**
   * Get event namespace mapping for registered orbitals.
   * Useful for debugging cross-orbital event routing.
   */
  getEventNamespaces(): EventNamespaceMap {
    return { ...this.eventNamespaceMap };
  }

  /**
   * Clear the preprocessing cache.
   */
  clearPreprocessCache(): void {
    this.preprocessedCache.clear();
  }

  /**
   * Register a single orbital
   */
  private async registerOrbitalAsync(orbital: OrbitalDefinition): Promise<void> {
    // Convert traits to TraitDefinition - filter to inline traits only (skip string refs)
    const inlineTraits = (orbital.traits || []).filter(isInlineTrait);
    const traitDefs: TraitDefinition[] = inlineTraits.map((t: Trait) => {
      const sm = t.stateMachine;
      const states = sm?.states || [];
      const transitions = sm?.transitions || [];

      return {
        name: t.name,
        states: states as TraitDefinition['states'],
        transitions: transitions as TraitDefinition['transitions'],
        listens: t.listens,
      };
    });

    const manager = new StateMachineManager(traitDefs, {
      contextExtensions: this.config.contextExtensions,
    });

    const entityRef = orbital.entity;
    const entity: Entity = typeof entityRef === 'string'
      ? { name: entityRef, fields: [] }  // Fallback for string refs
      : entityRef;

    this.orbitals.set(orbital.name, {
      schema: orbital,
      entity,
      traits: inlineTraits,
      manager,
      entityData: new Map(),
    });

    // Seed entity instances from schema if they exist
    if (entity?.name && entity.instances && Array.isArray(entity.instances)) {
      const instances = entity.instances;
      if (instances.length > 0) {
        console.log(`[OrbitalRuntime] Seeding ${instances.length} instances for ${entity.name} from schema`);
        
        // Seed each instance (await to ensure they're created)
        const results = await Promise.all(
          instances.map(async (instance) => {
            try {
              const result = await this.persistence.create(entity.name, instance);
              console.log(`[OrbitalRuntime] Seeded instance: ${instance.id || 'no-id'}`);
              return result;
            } catch (err) {
              console.error(`[OrbitalRuntime] Failed to seed instance ${instance.id}:`, err);
              return null;
            }
          })
        );
        
        const successCount = results.filter(r => r !== null).length;
        console.log(`[OrbitalRuntime] Seeded ${successCount}/${instances.length} ${entity.name} instances from schema`);
      }
    } else if (this.config.mode === 'mock' && this.persistence instanceof MockPersistenceAdapter) {
      // Fall back to mock data generation if no instances defined
      if (this.config.debug) {
        console.log(`[OrbitalRuntime] No instances in schema, generating mock data for ${entity?.name}`);
      }
      if (entity?.name && entity.fields) {
        const fields = entity.fields.map((f: { name: string; type: string; required?: boolean; values?: string[]; default?: unknown }) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          values: f.values,
          default: f.default,
        }));
        this.persistence.registerEntity({ name: entity.name, fields });
        if (this.config.debug) {
          console.log(`[OrbitalRuntime] Seeded mock data for entity: ${entity.name}, count: ${this.persistence.count(entity.name)}`);
        }
      }
    }

    if (this.config.debug) {
      console.log(
        `[OrbitalRuntime] Registered orbital: ${orbital.name} with ${(orbital.traits || []).length} trait(s)`,
      );
    }
  }

  /**
   * Register a single orbital (sync wrapper for backward compatibility)
   */
  private registerOrbital(orbital: OrbitalDefinition): void {
    // Create a synchronous version by using a promise that we don't await
    // For truly async registration, use the async register() method
    this.registerOrbitalAsync(orbital).catch((err) => {
      console.error(`[OrbitalRuntime] Failed to register orbital:`, err);
    });
  }

  /**
   * Set up event listeners for cross-orbital communication
   */
  private setupEventListeners(): void {
    // Clean up existing listeners
    for (const cleanup of this.listenerCleanups) {
      cleanup();
    }
    this.listenerCleanups = [];

    // For each orbital's traits with `listens`
    for (const [orbitalName, registered] of this.orbitals) {
      for (const trait of registered.traits) {
        if (!trait.listens) continue;

        for (const listener of trait.listens) {
          const cleanup = this.eventBus.on(listener.event, async (event) => {
            if (this.config.debug) {
              console.log(
                `[OrbitalRuntime] ${orbitalName}.${trait.name} received: ${listener.event}`,
              );
            }

            // Apply payload mapping
            let mappedPayload = event.payload;
            if (listener.payloadMapping && event.payload) {
              mappedPayload = {};
              for (const [key, expr] of Object.entries(
                listener.payloadMapping,
              )) {
                if (typeof expr === "string" && expr.startsWith("@payload.")) {
                  const field = expr.slice("@payload.".length);
                  (mappedPayload as EventPayload)[key] = (
                    event.payload as EventPayload
                  )[field];
                } else {
                  (mappedPayload as EventPayload)[key] = expr as string;
                }
              }
            }

            // Trigger the mapped event
            await this.processOrbitalEvent(orbitalName, {
              event: listener.triggers,
              payload: mappedPayload as EventPayload,
            });
          });

          this.listenerCleanups.push(cleanup);
        }
      }
    }
  }

  /**
   * Set up scheduled ticks for all traits
   */
  private setupTicks(): void {
    // Clean up existing ticks
    this.cleanupTicks();

    // For each orbital's traits with `ticks`
    for (const [orbitalName, registered] of this.orbitals) {
      for (const trait of registered.traits || []) {
        if (!trait.ticks || trait.ticks.length === 0) continue;

        for (const tick of trait.ticks) {
          this.registerTick(orbitalName, trait.name, tick, registered);
        }
      }
    }

    if (this.config.debug && this.tickBindings.length > 0) {
      console.log(
        `[OrbitalRuntime] Registered ${this.tickBindings.length} tick(s)`,
      );
    }
  }

  /**
   * Register a single tick
   */
  private registerTick(
    orbitalName: string,
    traitName: string,
    tick: RuntimeTraitTick,
    registered: RegisteredOrbital,
  ): void {
    // Determine interval in milliseconds
    let intervalMs: number;
    if (typeof tick.interval === "number") {
      intervalMs = tick.interval;
    } else if (typeof tick.interval === "string") {
      // Parse cron-like interval strings (e.g., '5s', '1m', '1h')
      intervalMs = this.parseIntervalString(tick.interval);
    } else {
      intervalMs = 1000; // Default to 1 second
    }

    if (this.config.debug) {
      console.log(
        `[OrbitalRuntime] Registering tick: ${orbitalName}.${traitName}.${tick.name} (${intervalMs}ms)`,
      );
    }

    const timerId = setInterval(async () => {
      await this.executeTick(orbitalName, traitName, tick, registered);
    }, intervalMs);

    this.tickBindings.push({
      orbitalName,
      traitName,
      tick,
      timerId,
    });
  }

  /**
   * Parse interval string to milliseconds
   * Supports: '5s', '1m', '1h', '30000' (ms)
   */
  private parseIntervalString(interval: string): number {
    const match = interval.match(/^(\d+)(ms|s|m|h)?$/);
    if (!match) {
      console.warn(
        `[OrbitalRuntime] Invalid interval format: ${interval}, defaulting to 1000ms`,
      );
      return 1000;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || "ms";

    switch (unit) {
      case "ms":
        return value;
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      default:
        return value;
    }
  }

  /**
   * Execute a tick for all applicable entities
   */
  private async executeTick(
    orbitalName: string,
    traitName: string,
    tick: RuntimeTraitTick,
    registered: RegisteredOrbital,
  ): Promise<void> {
    const entityType = registered.entity.name;
    const emittedEvents: Array<{ event: string; payload?: unknown }> = [];

    try {
      // Get all entities (or filtered by appliesTo)
      let entities = await this.persistence.list(entityType);

      if (tick.appliesTo && tick.appliesTo.length > 0) {
        const appliesToSet = new Set(tick.appliesTo);
        entities = entities.filter((e) => appliesToSet.has(e.id as string));
      }

      if (this.config.debug && entities.length > 0) {
        console.log(
          `[OrbitalRuntime] Tick ${orbitalName}.${traitName}.${tick.name}: processing ${entities.length} entities`,
        );
      }

      for (const entity of entities) {
        // Evaluate guard if present
        if (tick.guard) {
          try {
            const ctx = createContextFromBindings({
              entity,
              payload: {},
              state:
                registered.manager.getState(traitName)?.currentState ||
                "unknown",
            }, false, this.config.contextExtensions);

            const guardPasses = evaluateGuard(
              tick.guard as Parameters<typeof evaluateGuard>[0],
              ctx,
            );

            if (!guardPasses) {
              if (this.config.debug) {
                console.log(
                  `[OrbitalRuntime] Tick ${tick.name}: guard failed for entity ${entity.id}`,
                );
              }
              continue;
            }
          } catch (error) {
            console.error(
              `[OrbitalRuntime] Tick ${tick.name}: guard evaluation error for entity ${entity.id}:`,
              error,
            );
            continue;
          }
        }

        // Execute effects for this entity
        if (tick.effects && tick.effects.length > 0) {
          const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
          const clientEffects: Array<unknown> = [];
          const tickEffectResults: EffectResult[] = [];
          await this.executeEffects(
            registered,
            traitName,
            tick.effects,
            {}, // No payload for ticks
            entity,
            entity.id as string,
            emittedEvents,
            fetchedData,
            clientEffects,
            tickEffectResults,
          );

          if (this.config.debug) {
            console.log(
              `[OrbitalRuntime] Tick ${tick.name}: executed effects for entity ${entity.id}`,
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `[OrbitalRuntime] Tick ${tick.name} execution error:`,
        error,
      );
    }
  }

  /**
   * Clean up all active ticks
   */
  private cleanupTicks(): void {
    for (const binding of this.tickBindings) {
      clearInterval(binding.timerId);
    }
    this.tickBindings = [];
  }

  /**
   * Unregister all orbitals and clean up
   */
  unregisterAll(): void {
    // Clean up ticks
    this.cleanupTicks();

    // Clean up event listeners
    for (const cleanup of this.listenerCleanups) {
      cleanup();
    }
    this.listenerCleanups = [];

    this.orbitals.clear();
    this.eventBus.clear();

    // Clean up OS handlers (close file watchers, intervals, signal listeners)
    if (this.osHandlers) {
      this.osHandlers.cleanup();
      this.osHandlers = null;
    }
  }

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  /**
   * Process an event for an orbital
   */
  async processOrbitalEvent(
    orbitalName: string,
    request: OrbitalEventRequest,
  ): Promise<OrbitalEventResponse> {
    const registered = this.orbitals.get(orbitalName);
    if (!registered) {
      return {
        success: false,
        transitioned: false,
        states: {},
        emittedEvents: [],
        error: `Orbital not found: ${orbitalName}`,
      };
    }

    const { event, payload, entityId, user } = request;
    const emittedEvents: Array<{ event: string; payload?: unknown }> = [];
    // Collect data fetched by `fetch` effects
    const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
    // Collect client-side effects (render-ui, navigate, notify)
    const clientEffects: Array<unknown> = [];
    // Collect server-side effect results (persist, call-service, set)
    const effectResults: EffectResult[] = [];

    // Extract active traits filter from payload (sent by client for page-specific execution)
    const activeTraits = (payload as EventPayload | undefined)?._activeTraits as string[] | undefined;
    // Remove _activeTraits from payload before processing (internal use only)
    const cleanPayload = payload ? { ...payload } : undefined;
    if (cleanPayload) {
      delete (cleanPayload as EventPayload & { _activeTraits?: unknown })._activeTraits;
    }

    // Get entity data if entityId provided
    let entityData: EntityRow = {};
    if (entityId) {
      const stored = await this.persistence.getById(
        registered.entity.name,
        entityId,
      );
      if (stored) {
        entityData = stored;
      }
    }

    // Process event through state machine
    const results = registered.manager.sendEvent(event, cleanPayload, entityData);

    // Filter results to only active traits (if specified)
    const filteredResults = activeTraits && activeTraits.length > 0
      ? results.filter(({ traitName }) => activeTraits.includes(traitName))
      : results;

    if (this.config.debug && activeTraits) {
      console.log(`[OrbitalRuntime] Filtering traits: ${results.length} total, ${filteredResults.length} active (${activeTraits.join(', ')})`);
    }

    // Execute effects only for active traits
    for (const { traitName, result } of filteredResults) {
      if (result.effects.length > 0) {
        await this.executeEffects(
          registered,
          traitName,
          result.effects as Effect[],
          cleanPayload,
          entityData,
          entityId,
          emittedEvents,
          fetchedData,
          clientEffects,
          effectResults,
          user,
        );
      }
    }

    // After all effects execute, auto-fetch entity types that have ref effects and were mutated
    const persistedTypes = new Set<string>();
    for (const er of effectResults) {
      if ((er.effect === 'persist' || er.effect === 'set' || er.effect === 'swap') && er.success && er.entityType) {
        persistedTypes.add(er.entityType as string);
      }
    }
    // Scan traits for ref effects to know which entity types are ref'd
    const refTypes = new Set<string>();
    for (const trait of registered.traits) {
      const transitions = trait.stateMachine?.transitions ?? [];
      for (const trans of transitions) {
        for (const eff of trans.effects ?? []) {
          if (Array.isArray(eff) && eff[0] === 'ref' && typeof eff[1] === 'string') {
            refTypes.add(eff[1]);
          }
        }
      }
    }
    // Only re-fetch entity types that were both mutated AND have ref subscribers
    for (const mutatedEntityType of persistedTypes) {
      if (refTypes.has(mutatedEntityType)) {
        try {
          const fresh = await this.persistence.list(mutatedEntityType);
          fetchedData[mutatedEntityType] = fresh;
        } catch { /* ignore */ }
      }
    }

    // Build current states
    const states: Record<string, string> = {};
    for (const [name, state] of registered.manager.getAllStates()) {
      states[name] = state.currentState;
    }

    const response: OrbitalEventResponse = {
      success: true,
      transitioned: results.length > 0,
      states,
      emittedEvents,
    };

    // Include fetched data if any
    if (Object.keys(fetchedData).length > 0) {
      response.data = fetchedData;
    }

    // Include client effects if any
    if (clientEffects.length > 0) {
      response.clientEffects = clientEffects;
    }

    // Include server effect results if any
    if (effectResults.length > 0) {
      response.effectResults = effectResults;
    }

    return response;
  }

  /**
   * Execute effects from a transition
   */
  private async executeEffects(
    registered: RegisteredOrbital,
    traitName: string,
    effects: Effect[],
    payload: EventPayload | undefined,
    entityData: EntityRow,
    entityId: string | undefined,
    emittedEvents: Array<{ event: string; payload?: unknown }>,
    fetchedData: { [entityType: string]: EntityRow | EntityRow[] },
    clientEffects: Array<unknown>,
    effectResults: EffectResult[],
    user?: OrbitalEventRequest["user"],
  ): Promise<void> {
    const entityType = registered.entity.name;

    // Forward refs - assigned after construction, used by fetch/atomic handlers
    let bindingsRef: BindingContext | null = null;
    let contextRef: EffectContext | null = null;

    const handlers: EffectHandlers = {
      emit: (event, eventPayload) => {
        if (this.config.debug) {
          console.log(`[OrbitalRuntime] Emitting: ${event}`, eventPayload);
        }
        this.eventBus.emit(event, eventPayload);
        emittedEvents.push({ event, payload: eventPayload });
      },

      set: async (targetId, field, value) => {
        const id = targetId || entityId;
        if (id) {
          try {
            await this.persistence.update(entityType, id, { [field]: value as FieldValue });
            effectResults.push({
              effect: 'set',
              entityType,
              data: { id, field, value: value as FieldValue },
              success: true,
            });
          } catch (err) {
            effectResults.push({
              effect: 'set',
              entityType,
              data: { id, field, value: value as FieldValue },
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },

      persist: async (action, targetEntityType, data) => {
        // ----------------------------------------------------------------
        // Batch mode: ["persist", "batch", [...operations]]
        // Each operation: ["create", "collection", {...data}],
        //                 ["update", "collection", "id", {...data}],
        //                 ["delete", "collection", "id"]
        // ----------------------------------------------------------------
        if (action === 'batch') {
          const operations = (data as EntityRow | undefined)?.operations as unknown[] | undefined;
          if (!Array.isArray(operations) || operations.length === 0) {
            effectResults.push({
              effect: 'persist',
              action: 'batch',
              success: false,
              error: 'Batch requires a non-empty operations array',
            });
            return;
          }

          const batchResults: Array<EntityRow> = [];
          // Track completed ops for rollback on failure (best-effort)
          const completed: Array<{ action: string; entityType: string; id?: string }> = [];
          let batchFailed = false;
          let batchError = '';

          for (const op of operations) {
            if (!Array.isArray(op) || op.length < 2) {
              batchFailed = true;
              batchError = `Invalid batch operation format: ${JSON.stringify(op)}`;
              break;
            }

            const [opAction, opEntityType, ...opRest] = op as [string, string, ...unknown[]];

            try {
              switch (opAction) {
                case 'create': {
                  const createData = (opRest[0] as EntityRow) || {};
                  const { id: newId } = await this.persistence.create(opEntityType, createData);
                  batchResults.push({ action: 'create', entityType: opEntityType, id: newId, ...createData });
                  completed.push({ action: 'create', entityType: opEntityType, id: newId });
                  break;
                }
                case 'update': {
                  const updateId = opRest[0] as string;
                  const updateData = (opRest[1] as EntityRow) || {};
                  await this.persistence.update(opEntityType, updateId, updateData);
                  const updated = await this.persistence.getById(opEntityType, updateId);
                  batchResults.push({ action: 'update', entityType: opEntityType, id: updateId, ...(updated || updateData) });
                  completed.push({ action: 'update', entityType: opEntityType, id: updateId });
                  break;
                }
                case 'delete': {
                  const deleteId = opRest[0] as string;
                  // Snapshot before delete for potential rollback info
                  await this.persistence.delete(opEntityType, deleteId);
                  batchResults.push({ action: 'delete', entityType: opEntityType, id: deleteId, deleted: true });
                  completed.push({ action: 'delete', entityType: opEntityType, id: deleteId });
                  break;
                }
                default:
                  batchFailed = true;
                  batchError = `Unknown batch operation action: ${opAction}`;
                  break;
              }
            } catch (err) {
              batchFailed = true;
              batchError = `Batch operation [${opAction}, ${opEntityType}] failed: ${err instanceof Error ? err.message : String(err)}`;
              break;
            }

            if (batchFailed) break;
          }

          effectResults.push({
            effect: 'persist',
            action: 'batch',
            data: {
              operations: batchResults,
              completedCount: completed.length,
              totalCount: operations.length,
            },
            success: !batchFailed,
            ...(batchFailed ? { error: batchError } : {}),
          });
          return;
        }

        // ----------------------------------------------------------------
        // Single operation mode: create / update / delete
        // ----------------------------------------------------------------
        const type = targetEntityType || entityType;
        let resultData: EntityRow | undefined;

        try {
          // Validate relation cardinality before create/update
          if (action === 'create' || action === 'update') {
            this.validateRelationCardinality(type, data || {});
          }

          switch (action) {
            case "create": {
              const { id } = await this.persistence.create(type, data || {});
              resultData = { id, ...(data || {}) };
              break;
            }
            case "update":
              if (data?.id || entityId) {
                const updateId = (data?.id as string) || entityId!;
                await this.persistence.update(type, updateId, data || {});
                // Return the updated entity
                const updated = await this.persistence.getById(type, updateId);
                resultData = updated || { id: updateId, ...(data || {}) };
              }
              break;
            case "delete":
              if (data?.id || entityId) {
                const deleteId = (data?.id as string) || entityId!;
                // Enforce onDelete relation rules before deleting
                await this.enforceOnDeleteRules(type, deleteId);
                await this.persistence.delete(type, deleteId);
                resultData = { id: deleteId, deleted: true };
              }
              break;
          }

          effectResults.push({
            effect: 'persist',
            action,
            entityType: type,
            data: resultData,
            success: true,
          });
        } catch (err) {
          effectResults.push({
            effect: 'persist',
            action,
            entityType: type,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      callService: async (service, action, params) => {
        try {
          let result = null;
          // Custom handlers can override this
          if (this.config.effectHandlers?.callService) {
            result = await this.config.effectHandlers.callService(
              service,
              action,
              params,
            );
          } else {
            console.warn(
              `[OrbitalRuntime] call-service not configured: ${service}.${action}`,
            );
          }

          effectResults.push({
            effect: 'call-service',
            action: `${service}.${action}`,
            data: result as EntityRow | undefined,
            success: true,
          });

          return result;
        } catch (err) {
          effectResults.push({
            effect: 'call-service',
            action: `${service}.${action}`,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      },

      fetch: async (fetchEntityType, options) => {
        try {
          let result: EntityRow | EntityRow[] | null = null;

          if (options?.id) {
            // Single entity fetch
            const entity = await this.persistence.getById(fetchEntityType, options.id);
            if (entity) {
              // Populate relations if include specified
              if (options?.include && options.include.length > 0) {
                await this.populateRelations([entity], fetchEntityType, options.include);
              }
              // Always store as array for consistent access via FetchedDataContext
              fetchedData[fetchEntityType] = [entity];
              result = entity;
            }
          } else {
            // Collection fetch
            let entities = await this.persistence.list(fetchEntityType);

            // Apply filter if provided (basic implementation - can be extended)
            // TODO: Implement proper filter evaluation using evaluateGuard

            // Apply pagination
            if (options?.offset && options.offset > 0) {
              entities = entities.slice(options.offset);
            }
            if (options?.limit && options.limit > 0) {
              entities = entities.slice(0, options.limit);
            }

            // Populate relations if include specified
            if (options?.include && options.include.length > 0) {
              await this.populateRelations(entities, fetchEntityType, options.include);
            }

            fetchedData[fetchEntityType] = entities;
            result = entities;
          }

          // Sync fetched data into bindings so @EntityName.field resolves
          // in subsequent render-ui effects
          if (bindingsRef && result) {
            const records = Array.isArray(result) ? result : [result];
            if (records.length > 0) {
              const merged = Object.assign([...records], records[0]);
              bindingsRef[fetchEntityType] = merged;
              if (fetchEntityType === entityType) {
                bindingsRef.entity = merged;
              }
            }
          }

          return result;
        } catch (error) {
          console.error(`[OrbitalRuntime] Fetch error for ${fetchEntityType}:`, error);
          return null;
        }
      },

      // Resource operators: ref, deref, swap, watch, atomic

      ref: async (refEntityType, options) => {
        // ref is identical to fetch on the server: query persistence, populate fetchedData
        try {
          return await handlers.fetch!(refEntityType, options);
        } catch (error) {
          console.error(`[OrbitalRuntime] ref error for ${refEntityType}:`, error);
          return null;
        }
      },

      deref: async (derefEntityType, options) => {
        // deref is identical to fetch on the server: one-shot read
        try {
          let result: EntityRow | EntityRow[] | null = null;

          if (options?.id) {
            const entity = await this.persistence.getById(derefEntityType, options.id);
            if (entity) {
              fetchedData[derefEntityType] = [entity];
              result = entity;
            }
          } else {
            const entities = await this.persistence.list(derefEntityType);
            fetchedData[derefEntityType] = entities;
            result = entities;
          }

          // Sync into bindings like fetch does
          if (bindingsRef && result) {
            const records = Array.isArray(result) ? result : [result];
            if (records.length > 0) {
              const merged = Object.assign([...records], records[0]);
              bindingsRef[derefEntityType] = merged;
              if (derefEntityType === entityType) {
                bindingsRef.entity = merged;
              }
            }
          }

          effectResults.push({
            effect: 'deref',
            entityType: derefEntityType,
            success: true,
          });

          return result;
        } catch (error) {
          effectResults.push({
            effect: 'deref',
            entityType: derefEntityType,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      swap: async (swapEntityType, swapEntityId, transform) => {
        // Read-modify-write: read entity, apply transform S-expression, write back
        try {
          const current = await this.persistence.getById(swapEntityType, swapEntityId);
          if (!current) {
            effectResults.push({
              effect: 'swap',
              entityType: swapEntityType,
              success: false,
              error: `Entity ${swapEntityType}/${swapEntityId} not found`,
            });
            return null;
          }

          // Evaluate the transform S-expression with @current binding
          const ctx = createContextFromBindings({
            current,
            entity: entityData,
            payload,
          }, false, this.config.contextExtensions);

          let newData: EntityRow;
          if (Array.isArray(transform)) {
            // S-expression transform: evaluate with @current bound to the entity
            const result = evaluate(
              transform as Parameters<typeof evaluate>[0],
              ctx,
            );
            // The result should be a record (the transformed entity)
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              newData = result as EntityRow;
            } else {
              // If transform returned a non-object, treat it as a partial update
              newData = current;
            }
          } else if (typeof transform === 'object' && transform !== null) {
            // Plain object merge: simple field updates
            newData = { ...current, ...(transform as EntityRow) };
          } else {
            effectResults.push({
              effect: 'swap',
              entityType: swapEntityType,
              success: false,
              error: 'swap! transform must be an S-expression or object',
            });
            return null;
          }

          // Write back (without version check for now, full OCC in future pass)
          await this.persistence.update(swapEntityType, swapEntityId, newData);

          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            data: { id: swapEntityId, ...newData },
            success: true,
          });

          return newData;
        } catch (error) {
          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      watch: (_watchEntityType, _watchOptions) => {
        // Watch is a no-op on server. Client subscribes to real-time updates.
        if (this.config.debug) {
          console.log(`[OrbitalRuntime] watch is a no-op on server: ${_watchEntityType}`);
        }
      },

      atomic: async (atomicEffects) => {
        // Execute inner effects sequentially. If any fails, mark all as failed.
        // Full transaction/rollback support is a future enhancement.
        let atomicFailed = false;
        let atomicError = '';

        const atomicExecutor = new EffectExecutor({
          handlers,
          bindings: bindingsRef ?? {},
          context: contextRef ?? { traitName, state: 'unknown', transition: 'unknown' },
          debug: this.config.debug,
          contextExtensions: this.config.contextExtensions,
        });

        for (const innerEffect of atomicEffects) {
          if (atomicFailed) break;
          try {
            await atomicExecutor.execute(innerEffect);
          } catch (err) {
            atomicFailed = true;
            atomicError = err instanceof Error ? err.message : String(err);
          }
        }

        if (atomicFailed) {
          // Mark the atomic block as failed
          effectResults.push({
            effect: 'atomic',
            success: false,
            error: `Atomic block failed: ${atomicError}`,
          });
        } else {
          effectResults.push({
            effect: 'atomic',
            success: true,
            data: { innerCount: atomicEffects.length },
          });
        }
      },

      // Client-side effects - collect for forwarding to client
      renderUI: (slot, pattern, props, priority) => {
        clientEffects.push(['render-ui', slot, pattern, props, priority]);
      },
      navigate: (path, params) => {
        clientEffects.push(['navigate', path, params]);
      },

      notify: (message, type) => {
        if (this.config.debug) {
          console.log(`[OrbitalRuntime] Notification (${type}): ${message}`);
        }
        // Forward notify to client as a client effect
        clientEffects.push(['notify', message, { type }]);
      },

      log: (message, level) => {
        const logFn =
          level === "error"
            ? console.error
            : level === "warn"
              ? console.warn
              : console.log;
        logFn(`[OrbitalRuntime] ${message}`);
      },

      // Allow custom handlers to override
      ...this.config.effectHandlers,
    };

    const state = registered.manager.getState(traitName);
    // Build binding context with @entity AND @EntityName aliases.
    // @entity is the standard binding root. @EntityName (e.g., @SpriteEntity)
    // is used by some behaviors for explicit entity references in render-ui patterns.
    // The compiled app resolves @EntityName at compile time; the interpreter
    // needs it in the runtime binding context.
    //
    // NOTE: fetchedData is populated by fetch effects DURING execution.
    // The syncFetchedBindings() helper is called from the fetch handler
    // to update bindings after each fetch, so render-ui effects that
    // run after fetch see the correct @EntityName.field values.
    const bindings: BindingContext = {
      entity: entityData,
      payload,
      state: state?.currentState || "unknown",
      user, // @user bindings from Firebase auth
    };

    // Add initial named entity binding
    if (entityType) {
      bindings[entityType] = entityData;
    }

    // Wire forward refs so fetch/atomic handlers can access bindings and context
    bindingsRef = bindings;

    const context: EffectContext = {
      traitName,
      state: state?.currentState || "unknown",
      transition: "unknown",
      entityId,
    };
    contextRef = context;

    const executor = new EffectExecutor({
      handlers,
      bindings,
      context,
      debug: this.config.debug,
      contextExtensions: this.config.contextExtensions,
    });

    await executor.executeAll(effects);
  }

  // ==========================================================================
  // Relation Population
  // ==========================================================================

  /**
   * Populate relation fields on entities
   *
   * For each field in `include`, find the relation field configuration and
   * fetch the related entity, attaching it to the parent entity.
   *
   * @param entities - Entities to populate
   * @param entityType - Entity type name
   * @param include - Relation field names to populate
   */
  /**
   * Validate that relation field values match their declared cardinality.
   * Called before create/update to ensure data integrity.
   */
  private validateRelationCardinality(
    entityType: string,
    data: EntityRow,
  ): void {
    // Find the entity schema
    for (const [, registered] of this.orbitals) {
      if (registered.entity.name !== entityType) continue;

      for (const field of registered.entity.fields ?? []) {
        if (field.type !== 'relation') continue;
        const value = data[field.name];
        if (value === undefined || value === null) continue;

        const cardinality = field.relation?.cardinality || 'one';

        if (cardinality === 'one' || cardinality === 'many-to-one') {
          // Single cardinality: value must be a string, not an array
          if (Array.isArray(value)) {
            throw new Error(
              `Cardinality violation: ${entityType}.${field.name} has cardinality '${cardinality}' but received an array. Expected a single string ID.`
            );
          }
        } else if (cardinality === 'many' || cardinality === 'many-to-many' || cardinality === 'one-to-many') {
          // Many cardinality: value must be an array of strings
          if (typeof value === 'string') {
            // Auto-correct: wrap single string in array (permissive)
            data[field.name] = [value];
          } else if (Array.isArray(value)) {
            // Validate all elements are strings
            const nonStrings = value.filter((v: unknown) => typeof v !== 'string');
            if (nonStrings.length > 0) {
              throw new Error(
                `Cardinality violation: ${entityType}.${field.name} has cardinality '${cardinality}' but array contains non-string values.`
              );
            }
          }
        }
      }
      break;
    }
  }

  /**
   * Enforce onDelete rules for relation fields pointing to the entity being deleted.
   * Scans all registered entities for relation fields targeting the given entity type,
   * finds records referencing the ID being deleted, and applies cascade/nullify/restrict.
   */
  private async enforceOnDeleteRules(
    entityType: string,
    deletedId: string,
  ): Promise<void> {
    for (const [, registered] of this.orbitals) {
      const entity = registered.entity;
      const fields = entity.fields ?? [];

      for (const field of fields) {
        if (field.type !== 'relation') continue;
        if (field.relation?.entity !== entityType) continue;

        const onDelete = field.relation.onDelete || 'restrict';
        const referringEntityType = entity.name;

        // Find all records in the referring entity that reference the deleted ID
        const allRecords = await this.persistence.list(referringEntityType);
        const affectedRecords = allRecords.filter(record => {
          const fkValue = record[field.name];
          if (typeof fkValue === 'string') return fkValue === deletedId;
          if (Array.isArray(fkValue)) return fkValue.includes(deletedId);
          return false;
        });

        if (affectedRecords.length === 0) continue;

        switch (onDelete) {
          case 'restrict':
            throw new Error(
              `Cannot delete ${entityType} ${deletedId}: ${affectedRecords.length} ${referringEntityType} record(s) reference it via ${field.name}. Rule: restrict.`
            );

          case 'cascade':
            for (const record of affectedRecords) {
              const recordId = record.id as string;
              if (recordId) {
                await this.persistence.delete(referringEntityType, recordId);
              }
            }
            if (this.config.debug) {
              console.log(`[OrbitalRuntime] Cascade deleted ${affectedRecords.length} ${referringEntityType} records`);
            }
            break;

          case 'nullify':
            for (const record of affectedRecords) {
              const recordId = record.id as string;
              if (recordId) {
                const update: EntityRow = {};
                const fkValue = record[field.name];
                if (Array.isArray(fkValue)) {
                  update[field.name] = fkValue.filter((id: unknown) => id !== deletedId);
                } else {
                  update[field.name] = null;
                }
                await this.persistence.update(referringEntityType, recordId, update);
              }
            }
            if (this.config.debug) {
              console.log(`[OrbitalRuntime] Nullified ${field.name} on ${affectedRecords.length} ${referringEntityType} records`);
            }
            break;
        }
      }
    }
  }

  private async populateRelations(
    entities: EntityRow[],
    entityType: string,
    include: string[],
    depth: number = 0,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    // Circular reference protection: stop if depth exceeded or entity type already visited
    const maxDepth = 2;
    if (depth >= maxDepth || visited.has(entityType)) {
      if (this.config.debug) {
        console.log(`[OrbitalRuntime] Skipping populateRelations for ${entityType}: depth=${depth}, visited=${visited.has(entityType)}`);
      }
      return;
    }
    visited.add(entityType);
    // Find the orbital that owns this entity type
    let entityFields: Array<{ name: string; type: string; relation?: { entity?: string; cardinality?: string; onDelete?: string } }> | undefined;

    for (const [, registered] of this.orbitals) {
      if (registered.entity.name === entityType) {
        entityFields = registered.entity.fields;
        break;
      }
    }

    if (!entityFields) {
      if (this.config.debug) {
        console.warn(`[OrbitalRuntime] No entity definition found for ${entityType}`);
      }
      return;
    }

    // Process each include field
    for (const includeField of include) {
      // Find the relation field (check both "fieldName" and "fieldNameId" patterns)
      const relationField = entityFields.find(f => {
        if (f.type !== 'relation') return false;
        // Match "company" against "company" or "companyId"
        return f.name === includeField ||
               f.name === `${includeField}Id` ||
               f.name.replace(/Id$/, '') === includeField;
      });

      if (!relationField?.relation?.entity) {
        if (this.config.debug) {
          console.warn(`[OrbitalRuntime] No relation field found for '${includeField}' on ${entityType}`);
        }
        continue;
      }

      const foreignKeyField = relationField.name;
      const relatedEntityType = relationField.relation.entity;
      const cardinality = relationField.relation.cardinality || 'one';

      // Collect all foreign key IDs to batch fetch
      // Handles both single ID (string) and array of IDs (string[]) for many cardinalities
      const foreignKeyIds = new Set<string>();
      for (const entity of entities) {
        const fkValue = entity[foreignKeyField];
        if (fkValue && typeof fkValue === 'string') {
          foreignKeyIds.add(fkValue);
        } else if (Array.isArray(fkValue)) {
          for (const id of fkValue) {
            if (id && typeof id === 'string') {
              foreignKeyIds.add(id);
            }
          }
        }
      }

      if (foreignKeyIds.size === 0) continue;

      // Batch fetch all related entities
      const relatedEntities = new Map<string, EntityRow>();
      for (const fkId of foreignKeyIds) {
        try {
          const related = await this.persistence.getById(relatedEntityType, fkId);
          if (related) {
            relatedEntities.set(fkId, related);
          }
        } catch (error) {
          if (this.config.debug) {
            console.error(`[OrbitalRuntime] Error fetching related ${relatedEntityType}:`, error);
          }
        }
      }

      // Attach related entities to parent entities
      // Use the base name without "Id" suffix for the populated field
      const populatedFieldName = includeField.endsWith('Id')
        ? includeField.slice(0, -2)
        : includeField;

      for (const entity of entities) {
        const fkValue = entity[foreignKeyField];
        // Population attaches related EntityRow objects to the entity at runtime.
        // This mutates beyond the EntityRow type, so we use Object.defineProperty.
        if (cardinality === 'one' || cardinality === 'many-to-one') {
          if (typeof fkValue === 'string' && relatedEntities.has(fkValue)) {
            Object.defineProperty(entity, populatedFieldName, {
              value: relatedEntities.get(fkValue),
              writable: true, enumerable: true, configurable: true,
            });
          }
        } else {
          if (Array.isArray(fkValue)) {
            const fkIds = (fkValue as string[]).filter((id): id is string => typeof id === 'string');
            Object.defineProperty(entity, populatedFieldName, {
              value: fkIds.map(id => relatedEntities.get(id)).filter(Boolean),
              writable: true, enumerable: true, configurable: true,
            });
          } else if (typeof fkValue === 'string' && relatedEntities.has(fkValue)) {
            Object.defineProperty(entity, populatedFieldName, {
              value: [relatedEntities.get(fkValue)],
              writable: true, enumerable: true, configurable: true,
            });
          }
        }
      }

      if (this.config.debug) {
        console.log(`[OrbitalRuntime] Populated '${populatedFieldName}' on ${entities.length} ${entityType} entities`);
      }
    }
  }

  // ==========================================================================
  // Express Router
  // ==========================================================================

  /**
   * Create Express router for orbital API endpoints
   *
   * All data access goes through trait events with guards.
   * No direct CRUD routes - use events with `fetch` effects.
   *
   * Routes:
   * - GET  /              - List registered orbitals
   * - GET  /:orbital      - Get orbital info and current states
   * - POST /:orbital/events - Send event to orbital (includes data from `fetch` effects)
   */
  router(): Router {
    const router = Router();

    // List orbitals
    router.get("/", (_req: Request, res: Response) => {
      const orbitals = Array.from(this.orbitals.entries()).map(
        ([name, reg]) => ({
          name,
          entity: reg.entity?.name,
          traits: (reg.traits || []).map((t) => t.name),
        }),
      );
      res.json({ success: true, orbitals });
    });

    // Get orbital info
    router.get("/:orbital", (req: Request, res: Response) => {
      const orbitalName = req.params.orbital as string;
      const registered = this.orbitals.get(orbitalName);
      if (!registered) {
        res.status(404).json({ success: false, error: "Orbital not found" });
        return;
      }

      const states: Record<string, string> = {};
      for (const [name, state] of registered.manager.getAllStates()) {
        states[name] = state.currentState;
      }

      res.json({
        success: true,
        orbital: {
          name: orbitalName,
          entity: registered.entity,
          traits: registered.traits.map((t) => ({
            name: t.name,
            currentState: states[t.name],
            states: (t.stateMachine?.states || []).map((s) => s.name),
            events: [...new Set((t.stateMachine?.transitions || []).map((tr) => tr.event))],
          })),
        },
      });
    });

    // Send event to orbital - this is the ONLY data access point
    // All reads go through `fetch` effects with guard enforcement
    // All writes go through `persist` effects with guard enforcement
    router.post(
      "/:orbital/events",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const orbitalName = req.params.orbital as string;
          // Extract user from request (set by authenticateFirebase middleware)
          const firebaseUser = (req as Request & { firebaseUser?: OrbitalEventRequest["user"] }).firebaseUser;
          const user = firebaseUser ? {
            ...firebaseUser,
            displayName: (firebaseUser.name as string | undefined) ?? firebaseUser.displayName,
          } : undefined;

          const result = await this.processOrbitalEvent(orbitalName, {
            ...req.body,
            user,
          });
          res.json(result);
        } catch (error) {
          next(error);
        }
      },
    );

    // No direct CRUD routes - all data access goes through events
    // This ensures guards are always evaluated for both reads and writes

    return router;
  }

  // ==========================================================================
  // Direct API (for programmatic use)
  // ==========================================================================

  /**
   * Get the event bus for manual event emission
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get state for a specific orbital/trait
   */
  getState(
    orbitalName: string,
    traitName?: string,
  ): TraitState | Record<string, TraitState> | undefined {
    const registered = this.orbitals.get(orbitalName);
    if (!registered) return undefined;

    if (traitName) {
      return registered.manager.getState(traitName);
    }

    // Return all states for the orbital
    const states: Record<string, TraitState> = {};
    for (const [name, state] of registered.manager.getAllStates()) {
      states[name] = state;
    }
    return states;
  }

  /**
   * List registered orbitals
   */
  listOrbitals(): string[] {
    return Array.from(this.orbitals.keys());
  }

  /**
   * Check if an orbital is registered
   */
  hasOrbital(name: string): boolean {
    return this.orbitals.has(name);
  }

  /**
   * Get information about active ticks
   */
  getActiveTicks(): Array<{
    orbital: string;
    trait: string;
    tick: string;
    interval: number | string;
    hasGuard: boolean;
  }> {
    return this.tickBindings.map((binding) => ({
      orbital: binding.orbitalName,
      trait: binding.traitName,
      tick: binding.tick.name,
      interval: binding.tick.interval,
      hasGuard: !!binding.tick.guard,
    }));
  }
}

/**
 * Factory function to create a runtime instance
 */
export function createOrbitalServerRuntime(
  config?: OrbitalServerRuntimeConfig,
): OrbitalServerRuntime {
  return new OrbitalServerRuntime(config);
}
