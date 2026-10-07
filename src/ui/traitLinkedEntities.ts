/**
 * Trait → linked record for entity-schema enrichment. A page binding's record (call-site rebind)
 * comes first; every other resolved trait — an embedded one is on no page — maps to its own.
 *
 * @packageDocumentation
 */
import type { ResolvedIR } from '@almadar/core';

export function buildTraitLinkedEntities(ir: Pick<ResolvedIR, 'traits' | 'pages'>): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of ir.pages.values()) {
    for (const binding of page.traits) {
      if (binding.linkedEntity) map.set(binding.trait.name, binding.linkedEntity);
    }
  }
  for (const trait of ir.traits.values()) {
    if (trait.linkedEntity && !map.has(trait.name)) map.set(trait.name, trait.linkedEntity);
  }
  return map;
}
