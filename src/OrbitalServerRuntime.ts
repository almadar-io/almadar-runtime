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
import {
  interpolateProps,
  createContextFromBindings,
} from "./BindingResolver.js";
import { evaluateGuard } from "@almadar/evaluator";
import type {
  TraitDefinition,
  TraitState,
  EffectHandlers,
  BindingContext,
  EffectContext,
  Effect,
} from "./types.js";
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

// ============================================================================
// Types
// ============================================================================

/**
 * Simplified OrbitalSchema for runtime registration
 * (Subset of full OrbitalSchema - just what's needed for execution)
 */
export interface RuntimeOrbitalSchema {
  name: string;
  version?: string;
  orbitals: RuntimeOrbital[];
}

export interface RuntimeOrbital {
  name: string;
  entity: {
    name: string;
    fields?: Array<{ name: string; type: string }>;
  };
  traits: RuntimeTrait[];
}

/**
 * Tick definition for scheduled effects
 */
export interface RuntimeTraitTick {
  /** Unique name for this tick */
  name: string;
  /** Interval in milliseconds, or cron expression string */
  interval: number | string;
  /** Guard condition (S-expression) - tick only executes if guard passes */
  guard?: unknown;
  /** Effects to execute when tick fires */
  effects: Effect[];
  /** Filter to specific entity IDs (optional) */
  appliesTo?: string[];
}

export interface RuntimeTrait {
  name: string;
  states: Array<{ name: string; isInitial?: boolean }>;
  transitions: Array<{
    from: string;
    to: string;
    event: string;
    guard?: unknown;
    effects?: Effect[];
  }>;
  listens?: Array<{
    event: string;
    triggers: string;
    payloadMapping?: Record<string, unknown>;
  }>;
  emits?: string[];
  /** Scheduled ticks for this trait */
  ticks?: RuntimeTraitTick[];
}

/**
 * Registered orbital with runtime state
 */
interface RegisteredOrbital {
  schema: RuntimeOrbital;
  manager: StateMachineManager;
  entityData: Map<string, Record<string, unknown>>; // entityId -> data
}

/**
 * Event sent from client to server
 */
export interface OrbitalEventRequest {
  event: string;
  payload?: Record<string, unknown>;
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
  data?: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
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
  effect: 'persist' | 'call-service' | 'set';
  /** Action performed (e.g., 'create', 'update', 'delete' for persist) */
  action?: string;
  /** Entity type affected (for persist/set) */
  entityType?: string;
  /** Result data from the effect */
  data?: Record<string, unknown>;
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
}

/**
 * Adapter for persisting entity data
 */
export interface PersistenceAdapter {
  create(
    entityType: string,
    data: Record<string, unknown>,
  ): Promise<{ id: string }>;
  update(
    entityType: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  delete(entityType: string, id: string): Promise<void>;
  getById(
    entityType: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  list(entityType: string): Promise<Array<Record<string, unknown>>>;
}

// ============================================================================
// In-Memory Persistence (Default)
// ============================================================================

/**
 * Simple in-memory persistence for development/testing
 */
class InMemoryPersistence implements PersistenceAdapter {
  private data = new Map<string, Map<string, Record<string, unknown>>>();
  private idCounter = 0;

  async create(
    entityType: string,
    data: Record<string, unknown>,
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
    data: Record<string, unknown>,
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
  ): Promise<Record<string, unknown> | null> {
    return this.data.get(entityType)?.get(id) || null;
  }

  async list(entityType: string): Promise<Array<Record<string, unknown>>> {
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
  private orbitals = new Map<string, RegisteredOrbital>();
  private eventBus: EventBus;
  private config: OrbitalServerRuntimeConfig;
  private persistence: PersistenceAdapter;
  private listenerCleanups: Array<() => void> = [];
  private tickBindings: TickBinding[] = [];
  private loader: SchemaLoader | null = null;
  private preprocessedCache = new Map<string, PreprocessedSchema>();
  private entitySharingMap: EntitySharingMap = {};
  private eventNamespaceMap: EventNamespaceMap = {};

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
  async register(schema: RuntimeOrbitalSchema): Promise<void> {
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
  registerSync(schema: RuntimeOrbitalSchema): void {
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
    schema: RuntimeOrbitalSchema,
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
      this.register(cached.schema as unknown as RuntimeOrbitalSchema);
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
    const result = await preprocessSchema(schema as unknown as import("@almadar/core").OrbitalSchema, {
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
    this.register(result.data.schema as unknown as RuntimeOrbitalSchema);

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
  private async registerOrbitalAsync(orbital: RuntimeOrbital): Promise<void> {
    // Convert traits to TraitDefinition - handle both flat and stateMachine structures
    const traitDefs: TraitDefinition[] = (orbital.traits || []).map((t) => {
      // Support both: t.states (flat) and t.stateMachine.states (OrbitalSchema structure)
      const stateMachine = (t as { stateMachine?: { states?: unknown[]; transitions?: unknown[] } }).stateMachine;
      const states = t.states || stateMachine?.states || [];
      const transitions = t.transitions || stateMachine?.transitions || [];

      return {
        name: t.name,
        states: states as TraitDefinition['states'],
        transitions: transitions as TraitDefinition['transitions'],
        listens: t.listens,
      };
    });

    const manager = new StateMachineManager(traitDefs);

    this.orbitals.set(orbital.name, {
      schema: orbital,
      manager,
      entityData: new Map(),
    });

    const entity = orbital.entity;
    
    // Seed entity instances from schema if they exist
    if (entity?.name && (entity as any).instances && Array.isArray((entity as any).instances)) {
      const instances = (entity as any).instances as Array<Record<string, unknown>>;
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
  private registerOrbital(orbital: RuntimeOrbital): void {
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
      for (const trait of registered.schema.traits) {
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
                  (mappedPayload as Record<string, unknown>)[key] = (
                    event.payload as Record<string, unknown>
                  )[field];
                } else {
                  (mappedPayload as Record<string, unknown>)[key] = expr;
                }
              }
            }

            // Trigger the mapped event
            await this.processOrbitalEvent(orbitalName, {
              event: listener.triggers,
              payload: mappedPayload as Record<string, unknown>,
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
      for (const trait of registered.schema.traits) {
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
    const entityType = registered.schema.entity.name;
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
            });

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
          const fetchedData: Record<string, Record<string, unknown> | Record<string, unknown>[]> = {};
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
    const fetchedData: Record<string, Record<string, unknown> | Record<string, unknown>[]> = {};
    // Collect client-side effects (render-ui, navigate, notify)
    const clientEffects: Array<unknown> = [];
    // Collect server-side effect results (persist, call-service, set)
    const effectResults: EffectResult[] = [];

    // Extract active traits filter from payload (sent by client for page-specific execution)
    const activeTraits = (payload as Record<string, unknown> | undefined)?._activeTraits as string[] | undefined;
    // Remove _activeTraits from payload before processing (internal use only)
    const cleanPayload = payload ? { ...payload } : undefined;
    if (cleanPayload) {
      delete (cleanPayload as Record<string, unknown>)._activeTraits;
    }

    // Get entity data if entityId provided
    let entityData: Record<string, unknown> = {};
    if (entityId) {
      const stored = await this.persistence.getById(
        registered.schema.entity.name,
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
    payload: Record<string, unknown> | undefined,
    entityData: Record<string, unknown>,
    entityId: string | undefined,
    emittedEvents: Array<{ event: string; payload?: unknown }>,
    fetchedData: Record<string, Record<string, unknown> | Record<string, unknown>[]>,
    clientEffects: Array<unknown>,
    effectResults: EffectResult[],
    user?: OrbitalEventRequest["user"],
  ): Promise<void> {
    const entityType = registered.schema.entity.name;

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
            await this.persistence.update(entityType, id, { [field]: value });
            effectResults.push({
              effect: 'set',
              entityType,
              data: { id, field, value },
              success: true,
            });
          } catch (err) {
            effectResults.push({
              effect: 'set',
              entityType,
              data: { id, field, value },
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },

      persist: async (action, targetEntityType, data) => {
        const type = targetEntityType || entityType;
        let resultData: Record<string, unknown> | undefined;

        try {
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
            data: result as Record<string, unknown> | undefined,
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
          let result: Record<string, unknown> | Record<string, unknown>[] | null = null;

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

          return result;
        } catch (error) {
          console.error(`[OrbitalRuntime] Fetch error for ${fetchEntityType}:`, error);
          return null;
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
    const bindings: BindingContext = {
      entity: entityData,
      payload,
      state: state?.currentState || "unknown",
      user, // @user bindings from Firebase auth
    };

    const context: EffectContext = {
      traitName,
      state: state?.currentState || "unknown",
      transition: "unknown",
      entityId,
    };

    const executor = new EffectExecutor({
      handlers,
      bindings,
      context,
      debug: this.config.debug,
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
  private async populateRelations(
    entities: Record<string, unknown>[],
    entityType: string,
    include: string[],
  ): Promise<void> {
    // Find the orbital that owns this entity type
    let entityFields: Array<{ name: string; type: string; relation?: { entity: string; cardinality?: string } }> | undefined;

    for (const [, registered] of this.orbitals) {
      if (registered.schema.entity.name === entityType) {
        entityFields = registered.schema.entity.fields;
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
      const foreignKeyIds = new Set<string>();
      for (const entity of entities) {
        const fkValue = entity[foreignKeyField];
        if (fkValue && typeof fkValue === 'string') {
          foreignKeyIds.add(fkValue);
        }
      }

      if (foreignKeyIds.size === 0) continue;

      // Fetch all related entities (ideally this would be a batch query)
      const relatedEntities = new Map<string, Record<string, unknown>>();
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
        const fkValue = entity[foreignKeyField] as string;
        if (fkValue && relatedEntities.has(fkValue)) {
          if (cardinality === 'one') {
            entity[populatedFieldName] = relatedEntities.get(fkValue);
          } else {
            // For many relations, we'd need a different approach
            // (reverse lookup from the related entity's foreign key)
            // For now, just set to array with single item
            entity[populatedFieldName] = [relatedEntities.get(fkValue)];
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
          entity: reg.schema.entity.name,
          traits: reg.schema.traits.map((t) => t.name),
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
          entity: registered.schema.entity,
          traits: registered.schema.traits.map((t) => ({
            name: t.name,
            currentState: states[t.name],
            states: t.states.map((s) => s.name),
            events: [...new Set(t.transitions.map((tr) => tr.event))],
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
          const firebaseUser = (req as Request & { firebaseUser?: Record<string, unknown> }).firebaseUser;
          const user = firebaseUser ? {
            uid: firebaseUser.uid as string,
            email: firebaseUser.email as string | undefined,
            displayName: firebaseUser.name as string | undefined,
            ...firebaseUser,
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
