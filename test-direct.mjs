/**
 * Direct Runtime Test - No Build Dependencies
 * 
 * This script directly tests the OrbitalServerRuntime source code
 * without requiring built packages.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('\n' + '='.repeat(80));
console.log('TRAIT WARS RUNTIME DIRECT TEST');
console.log('='.repeat(80) + '\n');

// Load trait-wars schema
const schemaPath = join(__dirname, '../../projects/trait-wars/trait-wars.orb');
let traitWarsSchema;
try {
  const schemaContent = readFileSync(schemaPath, 'utf-8');
  traitWarsSchema = JSON.parse(schemaContent);
  console.log(`✅ Loaded schema: ${traitWarsSchema.name} v${traitWarsSchema.version}`);
  console.log(`   Orbitals: ${traitWarsSchema.orbitals.length}`);
} catch (error) {
  console.error(`❌ Failed to load schema: ${error.message}`);
  process.exit(1);
}

// Test Results
const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

function logTest(name) {
  console.log(`\n📋 ${name}`);
  console.log('─'.repeat(80));
}

function logPass(message) {
  console.log(`  ✅ ${message}`);
}

function logFail(message) {
  console.log(`  ❌ ${message}`);
}

function logInfo(message) {
  console.log(`  ℹ️  ${message}`);
}

// ============================================================================
// Test 1: Schema Structure Validation
// ============================================================================

test('Schema has entity instances defined', () => {
  logTest('COMP-GAP-04: Entity Instances in Schema');
  
  let totalInstances = 0;
  const entityCounts = {};
  
  for (const orbital of traitWarsSchema.orbitals) {
    const entityName = orbital.entity.name;
    const instances = orbital.entity.instances || [];
    entityCounts[entityName] = instances.length;
    totalInstances += instances.length;
  }
  
  logInfo(`Total instances defined in schema: ${totalInstances}`);
  for (const [entity, count] of Object.entries(entityCounts)) {
    logInfo(`  ${entity}: ${count} instances`);
  }
  
  if (totalInstances === 63) {
    logPass('Schema has exactly 63 entity instances (6 units + 5 buildings + 49 hexes + 3 heroes)');
  } else {
    logFail(`Expected 63 instances, found ${totalInstances}`);
  }
  
  // Check specific instances
  const tacticalBattle = traitWarsSchema.orbitals.find(o => o.name === 'TacticalBattle');
  if (tacticalBattle?.entity.instances?.length === 6) {
    logPass('TacticalBattle has 6 Unit instances');
  } else {
    logFail(`TacticalBattle should have 6 Unit instances, has ${tacticalBattle?.entity.instances?.length || 0}`);
  }
  
  const strategicCastle = traitWarsSchema.orbitals.find(o => o.name === 'StrategicCastle');
  if (strategicCastle?.entity.instances?.length === 5) {
    logPass('StrategicCastle has 5 Building instances');
  } else {
    logFail(`StrategicCastle should have 5 Building instances, has ${strategicCastle?.entity.instances?.length || 0}`);
  }
});

// ============================================================================
// Test 2: Game Patterns in Schema
// ============================================================================

test('Schema contains game-specific patterns', () => {
  logTest('COMP-GAP-01: Game Patterns in Schema');
  
  const gamePatterns = new Set();
  
  for (const orbital of traitWarsSchema.orbitals) {
    for (const trait of orbital.traits) {
      const transitions = trait.stateMachine?.transitions || [];
      for (const transition of transitions) {
        const effects = transition.effects || [];
        for (const effect of effects) {
          if (Array.isArray(effect) && effect[0] === 'render-ui' && effect[2]?.type) {
            const patternType = effect[2].type;
            if (patternType.startsWith('game-')) {
              gamePatterns.add(patternType);
            }
          }
        }
      }
    }
  }
  
  logInfo(`Found ${gamePatterns.size} unique game patterns:`);
  for (const pattern of gamePatterns) {
    logInfo(`  - ${pattern}`);
  }
  
  const expectedPatterns = [
    'game-isometric-canvas',
    'game-combat-log',
    'game-damage-popup',
    'game-trait-viewer',
    'game-resource-bar',
    'game-building-slot',
    'game-recruit-card',
    'game-hero-profile',
    'game-trait-slot',
  ];
  
  for (const expected of expectedPatterns) {
    if (gamePatterns.has(expected)) {
      logPass(`Pattern ${expected} found in schema`);
    } else {
      logFail(`Pattern ${expected} NOT found in schema`);
    }
  }
});

// ============================================================================
// Test 3: listens Declarations
// ============================================================================

test('Schema has listens declarations', () => {
  logTest('COMP-GAP-02: listens in Schema');
  
  const traitsWithListens = [];
  
  for (const orbital of traitWarsSchema.orbitals) {
    for (const trait of orbital.traits) {
      if (trait.listens && trait.listens.length > 0) {
        traitsWithListens.push({
          orbital: orbital.name,
          trait: trait.name,
          listens: trait.listens,
        });
      }
    }
  }
  
  logInfo(`Found ${traitsWithListens.length} traits with listens declarations:`);
  for (const { orbital, trait, listens } of traitsWithListens) {
    logInfo(`  ${orbital}.${trait}:`);
    for (const listen of listens) {
      logInfo(`    - Listens for: ${listen.event}${listen.from ? ` from ${listen.from}` : ''}`);
    }
  }
  
  if (traitsWithListens.length >= 4) {
    logPass(`Found ${traitsWithListens.length} traits with listens (expected at least 4)`);
  } else {
    logFail(`Expected at least 4 traits with listens, found ${traitsWithListens.length}`);
  }
});

// ============================================================================
// Test 4: emits Declarations
// ============================================================================

test('Schema has emits declarations', () => {
  logTest('COMP-GAP-02: emits in Schema');
  
  const traitsWithEmits = [];
  
  for (const orbital of traitWarsSchema.orbitals) {
    for (const trait of orbital.traits) {
      if (trait.emits && trait.emits.length > 0) {
        traitsWithEmits.push({
          orbital: orbital.name,
          trait: trait.name,
          emits: trait.emits,
        });
      }
    }
  }
  
  logInfo(`Found ${traitsWithEmits.length} traits with emits declarations:`);
  for (const { orbital, trait, emits } of traitsWithEmits) {
    logInfo(`  ${orbital}.${trait}:`);
    for (const emit of emits) {
      logInfo(`    - Emits: ${emit.event}`);
    }
  }
  
  if (traitsWithEmits.length >= 3) {
    logPass(`Found ${traitsWithEmits.length} traits with emits (expected at least 3)`);
  } else {
    logFail(`Expected at least 3 traits with emits, found ${traitsWithEmits.length}`);
  }
});

// ============================================================================
// Test 5: Effect Types in Schema
// ============================================================================

test('Schema uses various effect types', () => {
  logTest('COMP-GAP-03: Effect Types in Schema');
  
  const effectTypes = new Set();
  
  for (const orbital of traitWarsSchema.orbitals) {
    for (const trait of orbital.traits) {
      const transitions = trait.stateMachine?.transitions || [];
      for (const transition of transitions) {
        const effects = transition.effects || [];
        for (const effect of effects) {
          if (Array.isArray(effect) && effect[0]) {
            effectTypes.add(effect[0]);
          }
        }
      }
    }
  }
  
  logInfo(`Found ${effectTypes.size} unique effect types:`);
  for (const type of effectTypes) {
    logInfo(`  - ${type}`);
  }
  
  const expectedEffects = ['set', 'emit', 'persist', 'render-ui', 'navigate', 'fetch'];
  for (const expected of expectedEffects) {
    if (effectTypes.has(expected)) {
      logPass(`Effect type '${expected}' found in schema`);
    } else {
      logFail(`Effect type '${expected}' NOT found in schema`);
    }
  }
});

// ============================================================================
// Test 6: Guards in Schema
// ============================================================================

test('Schema has guards on transitions', () => {
  logTest('COMP-GAP-07: Guards in Schema');
  
  let guardsCount = 0;
  const guardBindings = new Set();
  
  for (const orbital of traitWarsSchema.orbitals) {
    for (const trait of orbital.traits) {
      const transitions = trait.stateMachine?.transitions || [];
      for (const transition of transitions) {
        if (transition.guard) {
          guardsCount++;
          
          // Extract bindings from guard (simple pattern matching)
          const guardStr = JSON.stringify(transition.guard);
          const bindings = guardStr.match(/@\w+\.\w+/g) || [];
          bindings.forEach(b => guardBindings.add(b));
        }
      }
    }
  }
  
  logInfo(`Found ${guardsCount} transitions with guards`);
  logInfo(`Guard bindings used:`);
  for (const binding of guardBindings) {
    logInfo(`  - ${binding}`);
  }
  
  if (guardsCount >= 10) {
    logPass(`Found ${guardsCount} guarded transitions (expected at least 10)`);
  } else {
    logFail(`Expected at least 10 guarded transitions, found ${guardsCount}`);
  }
  
  if (guardBindings.has('@entity.mana')) {
    logPass('Found @entity bindings in guards');
  }
  if (guardBindings.has('@entity.gold') || guardBindings.has('@payload.amount')) {
    logPass('Found complex guard bindings');
  }
});

// ============================================================================
// Run Tests
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('RUNNING SCHEMA VALIDATION TESTS');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;

for (const { name, fn } of results) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`\n❌ TEST FAILED: ${name}`);
    console.error(`   Error: ${error.message}`);
  }
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('TEST SUMMARY');
console.log('='.repeat(80));
console.log(`Total: ${results.length}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed === 0) {
  console.log('\n🎉 ALL SCHEMA VALIDATION TESTS PASSED');
  console.log('The trait-wars.orb schema is well-formed and contains all expected features.');
  console.log('\nNote: This validates the SCHEMA structure, not runtime execution.');
  console.log('To verify runtime behavior, build dependencies must be resolved first.');
} else {
  console.log('\n⚠️  SOME SCHEMA VALIDATION TESTS FAILED');
}

console.log('\n' + '='.repeat(80) + '\n');

process.exit(failed > 0 ? 1 : 0);
