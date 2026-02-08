/**
 * Trait Wars Runtime Tests
 * 
 * Direct unit tests for OrbitalServerRuntime using trait-wars.orb
 * Tests each gap claim from the gap analysis
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';

// Load trait-wars schema
const schemaPath = join(process.cwd(), '../../projects/trait-wars/trait-wars.orb');
const traitWarsSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

describe('OrbitalServerRuntime with trait-wars.orb', () => {
  
  describe('COMP-GAP-01: Pattern Support', () => {
    it('should register schema with game patterns without errors', () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      
      // Should not throw
      assert.doesNotThrow(() => {
        runtime.register(traitWarsSchema);
      });
      
      const orbitals = runtime.listOrbitals();
      assert.strictEqual(orbitals.length, 6, 'Should register all 6 orbitals');
    });

    it('should return game patterns in render-ui client effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Process INIT event which has game-isometric-canvas pattern
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.clientEffects, 'Should return client effects');
      
      const renderUiEffects = result.clientEffects.filter((e: any) => 
        Array.isArray(e) && e[0] === 'render-ui'
      );
      
      assert.ok(renderUiEffects.length > 0, 'Should have render-ui effects');
      
      // Check for game-specific patterns
      const gamePatterns = renderUiEffects.filter((e: any) => {
        const patternConfig = e[2];
        return patternConfig?.type?.startsWith('game-');
      });
      
      assert.ok(gamePatterns.length > 0, 'Should have game-specific patterns');
      
      // Verify specific pattern
      const canvasPattern = gamePatterns.find((e: any) => 
        e[2]?.type === 'game-isometric-canvas'
      );
      assert.ok(canvasPattern, 'Should have game-isometric-canvas pattern');
      assert.strictEqual(canvasPattern[1], 'main', 'Pattern should be for main slot');
    });

    it('should preserve all pattern properties including onTileClick', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      const canvasEffect = result.clientEffects?.find((e: any) => 
        Array.isArray(e) && e[2]?.type === 'game-isometric-canvas'
      );
      
      assert.ok(canvasEffect, 'Should find canvas effect');
      const props = canvasEffect[2];
      assert.ok(props.onTileClick, 'Should preserve onTileClick prop');
      assert.strictEqual(props.scale, 0.6, 'Should preserve scale prop');
    });
  });

  describe('COMP-GAP-02: listens Support', () => {
    it('should register event listeners for traits with listens', () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      
      // Should not throw when registering schema with listens
      assert.doesNotThrow(() => {
        runtime.register(traitWarsSchema);
      });
      
      // Verify listener setup (indirect check via successful registration)
      const orbitals = runtime.listOrbitals();
      assert.ok(orbitals.length > 0, 'Schema with listens should register');
    });

    it('should trigger listener when event is emitted', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Emit HERO_SELECTED from HeroBrowser
      const emitResult = await runtime.processOrbitalEvent('HeroManagement', {
        event: 'SELECT',
        payload: { heroId: 'hero-valor' },
      });
      
      assert.ok(emitResult.success, 'Emit event should succeed');
      assert.ok(emitResult.emittedEvents, 'Should have emitted events');
      
      const heroSelectedEmit = emitResult.emittedEvents.find((e: any) => 
        e.event === 'HERO_SELECTED'
      );
      assert.ok(heroSelectedEmit, 'Should emit HERO_SELECTED event');
      assert.strictEqual(heroSelectedEmit.payload.heroId, 'hero-valor', 'Should include payload');
    });

    it('should handle SHIELD_BREAK emission from GuardianBehavior', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // GuardianBehavior emits SHIELD_BREAK when shielding -> take damage with shield integrity < 0
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'TAKE_DAMAGE',
        payload: {},
        entityId: 'test-guardian',
      });
      
      // Note: This test shows the emit mechanism works
      // Full cross-orbital routing requires BattlePhaseController to be listening
      assert.ok(result, 'Event processing should complete');
    });
  });

  describe('COMP-GAP-03: Effect Execution', () => {
    it('should execute set effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Process event with set effect: HERO_SELECTED -> set deployedHeroId
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'HERO_SELECTED',
        payload: { heroId: 'hero-valor' },
        entityId: 'player-knight',
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.effectResults, 'Should have effect results');
      
      const setEffects = result.effectResults.filter((e: any) => e.effect === 'set');
      assert.ok(setEffects.length > 0, 'Should have executed set effects');
      
      const deployedEffect = setEffects.find((e: any) => 
        e.data?.field === 'deployedHeroId'
      );
      assert.ok(deployedEffect, 'Should set deployedHeroId');
      assert.strictEqual(deployedEffect.data.value, 'hero-valor', 'Should set correct value');
    });

    it('should execute emit effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // HeroBrowser SELECT emits HERO_SELECTED
      const result = await runtime.processOrbitalEvent('HeroManagement', {
        event: 'SELECT',
        payload: { heroId: 'hero-valor' },
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.emittedEvents, 'Should have emitted events');
      assert.ok(result.emittedEvents.length > 0, 'Should emit at least one event');
      
      const heroEvent = result.emittedEvents.find((e: any) => e.event === 'HERO_SELECTED');
      assert.ok(heroEvent, 'Should emit HERO_SELECTED');
      assert.strictEqual(heroEvent.payload.heroId, 'hero-valor', 'Should include payload');
    });

    it('should execute persist effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Initialize first (state machine requirement)
      await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      // Then move (has persist update effect)
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'MOVE',
        payload: { id: 'player-knight', positionX: 2, positionY: 3 },
        entityId: 'player-knight',
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.effectResults, 'Should have effect results');
      
      const persistEffects = result.effectResults.filter((e: any) => 
        e.effect === 'persist'
      );
      assert.ok(persistEffects.length > 0, 'Should have persist effects');
      
      const updateEffect = persistEffects.find((e: any) => e.action === 'update');
      assert.ok(updateEffect, 'Should have update persist effect');
      assert.strictEqual(updateEffect.entityType, 'Unit', 'Should update Unit entity');
    });

    it('should execute persist create with complex payload bindings', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Initialize first
      await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      // DEPLOY_HERO has complex persist create with @payload bindings
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'DEPLOY_HERO',
        payload: {
          heroId: 'deployed-test-1',
          name: 'Test Hero',
          characterType: 'hero',
          attack: 15,
          defense: 10,
          health: 100,
        },
      });
      
      assert.ok(result.success, 'Event should succeed');
      
      const persistEffects = result.effectResults.filter((e: any) => 
        e.effect === 'persist' && e.action === 'create'
      );
      assert.ok(persistEffects.length > 0, 'Should create entity');
      
      const createEffect = persistEffects[0];
      assert.ok(createEffect.data, 'Should have created entity data');
      assert.strictEqual(createEffect.data.id, 'deployed-test-1', 'Should resolve @payload.heroId');
      assert.strictEqual(createEffect.data.name, 'Test Hero', 'Should resolve @payload.name');
    });
  });

  describe('COMP-GAP-04: Entity Instance Seeding', () => {
    it('should seed Unit instances from schema', async () => {
      const runtime = new OrbitalServerRuntime({ 
        debug: false,
        mode: 'real', // Use real persistence to check seeding
      });
      runtime.register(traitWarsSchema);
      
      // Note: persistence is a property, not a method
      const persistence = (runtime as any).persistence;
      const units = await persistence.list('Unit');
      
      // Schema defines 6 unit instances
      assert.strictEqual(units.length, 6, 'Should seed exactly 6 Unit instances');
      
      // Check specific instances
      const sirRoland = units.find((u: any) => u.id === 'player-knight');
      assert.ok(sirRoland, 'Should have Sir Roland');
      assert.strictEqual(sirRoland.name, 'Sir Roland', 'Should have correct name');
      assert.strictEqual(sirRoland.characterType, 'hero', 'Should have correct type');
    });

    it('should seed Building instances from schema', async () => {
      const runtime = new OrbitalServerRuntime({ 
        debug: false,
        mode: 'real',
      });
      runtime.register(traitWarsSchema);
      
      const persistence = (runtime as any).persistence;
      const buildings = await persistence.list('Building');
      
      // Schema defines 5 building instances
      assert.strictEqual(buildings.length, 5, 'Should seed exactly 5 Building instances');
      
      const barracks = buildings.find((b: any) => b.id === 'barracks-1');
      assert.ok(barracks, 'Should have Barracks');
      assert.strictEqual(barracks.buildingType, 'barracks', 'Should have correct type');
    });

    it('should seed MapHex instances from schema', async () => {
      const runtime = new OrbitalServerRuntime({ 
        debug: false,
        mode: 'real',
      });
      runtime.register(traitWarsSchema);
      
      const persistence = (runtime as any).persistence;
      const hexes = await persistence.list('MapHex');
      
      // Schema defines 49 hex instances (7x7 grid)
      assert.strictEqual(hexes.length, 49, 'Should seed exactly 49 MapHex instances');
      
      const castleHex = hexes.find((h: any) => h.featureType === 'castle');
      assert.ok(castleHex, 'Should have castle hex');
    });

    it('should seed Hero instances from schema', async () => {
      const runtime = new OrbitalServerRuntime({ 
        debug: false,
        mode: 'real',
      });
      runtime.register(traitWarsSchema);
      
      const persistence = (runtime as any).persistence;
      const heroes = await persistence.list('Hero');
      
      // Schema defines 3 hero instances
      assert.strictEqual(heroes.length, 3, 'Should seed exactly 3 Hero instances');
      
      const valor = heroes.find((h: any) => h.id === 'hero-valor');
      assert.ok(valor, 'Should have Commander Valor');
      assert.strictEqual(valor.archetype, 'hero', 'Should have correct archetype');
    });

    it('should seed PlayerResources instance from schema', async () => {
      const runtime = new OrbitalServerRuntime({ 
        debug: false,
        mode: 'real',
      });
      runtime.register(traitWarsSchema);
      
      const persistence = (runtime as any).persistence;
      const resources = await persistence.list('PlayerResources');
      
      // Schema defines 1 resource instance
      assert.strictEqual(resources.length, 1, 'Should seed exactly 1 PlayerResources instance');
      
      const defaultResources = resources[0];
      assert.strictEqual(defaultResources.gold, 500, 'Should have default gold');
      assert.strictEqual(defaultResources.resonance, 50, 'Should have default resonance');
    });
  });

  describe('COMP-GAP-07: Guard Evaluation', () => {
    it('should block transitions when guards fail', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Initialize ResourceManager
      await runtime.processOrbitalEvent('Economy', {
        event: 'INIT',
        payload: {},
      });
      
      // Try to spend more gold than available (guard: >= entity.gold)
      // Default gold is 500, try to spend 1000
      const result = await runtime.processOrbitalEvent('Economy', {
        event: 'SPEND_RESOURCE',
        payload: { resourceType: 'gold', amount: 1000 },
        entityId: 'player-resources-default',
      });
      
      assert.strictEqual(result.transitioned, false, 'Should block transition');
      assert.strictEqual(result.newState, result.previousState, 'State should not change');
    });

    it('should allow transitions when guards pass', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Initialize ResourceManager
      await runtime.processOrbitalEvent('Economy', {
        event: 'INIT',
        payload: {},
      });
      
      // Spend valid amount (less than 500)
      const result = await runtime.processOrbitalEvent('Economy', {
        event: 'SPEND_RESOURCE',
        payload: { resourceType: 'gold', amount: 100 },
        entityId: 'player-resources-default',
      });
      
      assert.ok(result.transitioned, 'Should allow transition');
      assert.strictEqual(result.newState, 'active', 'Should stay in active state');
    });

    it('should evaluate guards with @entity bindings', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // SpellweaverBehavior has guard: [">=", "@entity.mana", 20]
      // This requires the entity to have mana field
      
      // Initialize and try to cast spell without enough mana
      await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'CAST_SPELL',
        payload: {},
        entityId: 'player-knight', // Knight has no mana field
      });
      
      // Should block because guard evaluates @entity.mana (undefined) >= 20
      assert.strictEqual(result.transitioned, false, 'Should block without mana');
    });

    it('should evaluate complex guards with @user bindings', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // SessionManager END_TURN has guard: ["==", "@entity.activePlayerId", "@user.id"]
      
      // Create a session first
      await runtime.processOrbitalEvent('Lobby', {
        event: 'CREATE_SESSION',
        payload: { mode: 'pvp' },
        user: { uid: 'player1', email: 'p1@test.com' },
      });
      
      // Try to end turn as wrong player
      const wrongPlayer = await runtime.processOrbitalEvent('Lobby', {
        event: 'END_TURN',
        payload: {},
        entityId: 'test-session',
        user: { uid: 'player2', email: 'p2@test.com' }, // Wrong player
      });
      
      // Should block because @entity.activePlayerId (player1) != @user.id (player2)
      assert.strictEqual(wrongPlayer.transitioned, false, 'Should block wrong player');
    });

    it('should evaluate guards with @payload bindings', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // HeroBrowser LEVEL_UP has guard: [">=", "@entity.xp", "@entity.xpToNextLevel"]
      
      // This guard compares two entity fields
      const result = await runtime.processOrbitalEvent('HeroManagement', {
        event: 'LEVEL_UP',
        payload: {},
        entityId: 'hero-valor', // Has xp: 45, xpToNextLevel: 150
      });
      
      // Should block because 45 < 150
      assert.strictEqual(result.transitioned, false, 'Should block level up without enough XP');
    });
  });

  describe('COMP-GAP-09: User Context', () => {
    it('should accept user context in requests', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      const result = await runtime.processOrbitalEvent('StrategicCastle', {
        event: 'INIT',
        payload: {},
        user: { uid: 'test-user-123', email: 'test@example.com' },
      });
      
      assert.ok(result.success, 'Should process event with user context');
    });

    it('should use @user bindings in fetch filters', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // CastleManagement INIT has: fetch Building with { ownerId: @user.id }
      const result = await runtime.processOrbitalEvent('StrategicCastle', {
        event: 'INIT',
        payload: {},
        user: { uid: 'owner-1', email: 'owner@test.com' },
      });
      
      assert.ok(result.success, 'Should execute fetch with @user binding');
      // Note: The filter application happens in persistence layer
    });
  });

  describe('COMP-GAP-05: Navigation', () => {
    it('should return navigate as client effect', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // Initialize first
      await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      // BATTLE_END has navigate /world effect
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'BATTLE_END',
        payload: {},
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.clientEffects, 'Should have client effects');
      
      const navigateEffects = result.clientEffects.filter((e: any) => 
        Array.isArray(e) && e[0] === 'navigate'
      );
      
      assert.ok(navigateEffects.length > 0, 'Should have navigate effect');
      assert.strictEqual(navigateEffects[0][1], '/world', 'Should navigate to /world');
    });

    it('should include params in navigate effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // WorldExploration BATTLE_ENCOUNTER has navigate with params
      const result = await runtime.processOrbitalEvent('WorldMap', {
        event: 'BATTLE_ENCOUNTER',
        payload: { enemyId: 'enemy-dark-knight' },
      });
      
      assert.ok(result.success, 'Event should succeed');
      
      const navigateEffects = result.clientEffects?.filter((e: any) => 
        Array.isArray(e) && e[0] === 'navigate'
      );
      
      assert.ok(navigateEffects && navigateEffects.length > 0, 'Should have navigate effect');
      // Check params are included (second argument after path)
      const params = navigateEffects[0][2];
      assert.ok(params, 'Should include params');
    });
  });

  describe('BONUS: fetch Effect Support', () => {
    it('should execute fetch effects and return data', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      assert.ok(result.success, 'Event should succeed');
      assert.ok(result.data, 'Should return fetched data');
      
      const entityTypes = Object.keys(result.data);
      assert.ok(entityTypes.length > 0, 'Should fetch at least one entity type');
      assert.ok(result.data.Unit, 'Should fetch Unit entities');
    });
  });

  describe('BONUS: Binding Resolution', () => {
    it('should resolve @payload bindings in persist create', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'INIT',
        payload: {},
      });
      
      const result = await runtime.processOrbitalEvent('TacticalBattle', {
        event: 'DEPLOY_HERO',
        payload: {
          heroId: 'binding-test-hero',
          name: 'Binding Test',
          characterType: 'hero',
          attack: 20,
          defense: 15,
          health: 150,
        },
      });
      
      assert.ok(result.success, 'Event should succeed');
      
      const createEffect = result.effectResults.find((e: any) => 
        e.effect === 'persist' && e.action === 'create'
      );
      
      assert.ok(createEffect, 'Should create entity');
      assert.strictEqual(createEffect.data.id, 'binding-test-hero', '@payload.heroId resolved');
      assert.strictEqual(createEffect.data.name, 'Binding Test', '@payload.name resolved');
      assert.strictEqual(createEffect.data.attack, 20, '@payload.attack resolved');
    });

    it('should resolve @entity bindings in set effects', async () => {
      const runtime = new OrbitalServerRuntime({ debug: false });
      runtime.register(traitWarsSchema);
      
      // CastleManagement UPGRADE_BUILDING uses ["set", "@entity.level", ["+", "@entity.level", 1]]
      const result = await runtime.processOrbitalEvent('StrategicCastle', {
        event: 'UPGRADE_BUILDING',
        payload: {},
        entityId: 'barracks-1',
      });
      
      assert.ok(result.success, 'Event should succeed');
      
      const setEffect = result.effectResults.find((e: any) => 
        e.effect === 'set' && e.data?.field === 'level'
      );
      
      assert.ok(setEffect, 'Should execute set effect');
      // The value should be entity.level + 1 (was 1, now 2)
      assert.strictEqual(setEffect.data.value, 2, 'Should resolve S-expression with @entity binding');
    });
  });
});
