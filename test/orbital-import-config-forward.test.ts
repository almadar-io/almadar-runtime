import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInlineTrait, type OrbitalDefinition, type OrbitalSchema } from '@almadar/core';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';

describe('orbital import config reaches imported trait forwards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-config-forward-'));
  const atom: OrbitalSchema = {
    name: 'atom',
    orbitals: [{
      name: 'Atom', entity: { name: 'State', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] }, pages: [],
      traits: [{
        name: 'Loop', scope: 'instance', config: { tools: { type: 'array', default: [] } },
        stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      }],
    }],
  };
  const upstream: OrbitalSchema = {
    name: 'upstream',
    orbitals: [{
      name: 'Assistant', entity: { name: 'State', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] }, pages: [],
      uses: [{ from: './atom.orb', as: 'Atom' }],
      config: { tools: { type: 'array', default: [{ scope: 'declared' }] } },
      traits: [
        { name: 'Forwarded', ref: 'Atom.traits.Loop', config: { tools: '@config.tools' } },
        { name: 'Literal', ref: 'Atom.traits.Loop', config: { tools: [{ read: 'Fixed' }] } },
      ],
    }],
  };
  writeFileSync(join(dir, 'atom.orb'), JSON.stringify(atom));
  writeFileSync(join(dir, 'upstream.orb'), JSON.stringify(upstream));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps default, explicit empty, and independent allowlists without overriding trait literals', async () => {
    const cases = [
      { name: 'Default', tools: undefined, expected: [{ scope: 'declared' }] },
      { name: 'Restricted', tools: [{ read: 'Task' }], expected: [{ read: 'Task' }] },
      { name: 'Empty', tools: [], expected: [] },
    ];
    const orbitals: OrbitalDefinition[] = cases.map(({ name, tools }) => ({
      name, entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] }, traits: [], pages: [],
      uses: [{ from: './upstream.orb', as: 'Upstream' }],
      reference: {
        ref: 'Upstream.orbitals.Assistant',
        ...(tools ? { config: { tools: { type: 'array', default: tools } } } : {}),
      },
    }));
    const result = await new ReferenceResolver({ basePath: dir }).resolveOrbitalImports({ name: 'consumer', orbitals });
    expect(result.success, result.success ? undefined : result.errors.join('\n')).toBe(true);
    if (!result.success) return;
    for (const entry of cases) {
      const traits = result.data.find((orbital) => orbital.name === entry.name)?.traits.filter(isInlineTrait);
      expect(traits?.find((trait) => trait.name === `${entry.name}Forwarded`)?.config?.tools?.default).toEqual(entry.expected);
      expect(traits?.find((trait) => trait.name === `${entry.name}Literal`)?.config?.tools?.default).toEqual([{ read: 'Fixed' }]);
    }
  });
});
