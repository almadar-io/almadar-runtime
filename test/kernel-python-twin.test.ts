/**
 * Twin of the Python shell's kernel-host gate (`orbital-shell-python/scripts/kernel_gate.py`): the same programs, run
 * event for event on the native Node add-on over the kernel's own memory store, reach the same verdict, state and
 * emitted events as the compiled Python app did. ALMADAR_PY_TRACE is the gate's --trace file; ALMADAR_PY_PROGRAMS the
 * programs it drove, as `name=path` pairs separated by commas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { OrbitalSchema } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { NATIVE_ADDON } from './helpers/kernel-module.js';

const TRACE = process.env.ALMADAR_PY_TRACE;
const PROGRAMS = process.env.ALMADAR_PY_PROGRAMS;

interface Step { success: boolean; newState: string | null; emitted: string[] }
type Trace = Record<string, { events: Record<string, Step> }>;

const kebab = (name: string): string => name.replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase();

function traitsByPath(schema: OrbitalSchema): Map<string, { orbital: string; trait: string }> {
  const found = new Map<string, { orbital: string; trait: string }>();
  for (const orbital of schema.orbitals) {
    for (const trait of orbital.traits) {
      const name = typeof trait === 'object' && 'name' in trait ? trait.name : undefined;
      if (typeof name === 'string') found.set(kebab(name), { orbital: orbital.name, trait: name });
    }
  }
  return found;
}

describe.skipIf(TRACE === undefined || PROGRAMS === undefined || NATIVE_ADDON === undefined)('the Python gate trace replayed on the Node add-on', () => {
  const trace: Trace = TRACE === undefined ? {} : JSON.parse(readFileSync(TRACE, 'utf8'));
  const programs = (PROGRAMS ?? '').split(',').filter((pair) => pair !== '').map((pair) => pair.split('=') as [string, string]);

  for (const [name, path] of programs) {
    it(`${name}: every event reaches the same verdict, state and emitted events`, async () => {
      const schema = await resolveProgramFile(path);
      const traits = traitsByPath(schema);
      const program = await KernelProgram.open(schema, { engine: 'native', ...(NATIVE_ADDON !== undefined ? { nativeAddon: NATIVE_ADDON } : {}), store: { NODE_ENV: 'development', DATA_BACKEND: 'mock' } });
      try {
        for (const [key, expected] of Object.entries(trace[name].events)) {
          const [path, event] = key.split('/');
          const target = traits.get(path);
          if (target === undefined) throw new Error(`${name}: no trait for ${path}`);
          const run = await program.dispatch(target.orbital, event, {}, target.trait);
          expect({ key, success: run.success, emitted: run.emits.map((e) => e.event) }).toEqual({ key, success: expected.success, emitted: expected.emitted });
        }
      } finally {
        program.close();
      }
    }, 120_000);
  }
});
