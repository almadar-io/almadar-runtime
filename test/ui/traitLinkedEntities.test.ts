/**
 * G-UI-086 (2026-10-07): a trait embedded by another (`@trait.NoteForm` inside a page composer) is
 * on no page, so a map built from page bindings alone missed it and its form lost entity-schema
 * enrichment (required markers, enum selects). Every resolved trait's binding is in the map.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyResolvedPage, createEmptyResolvedTrait, type ResolvedIR, type ResolvedTrait } from '@almadar/core';
import { buildTraitLinkedEntities } from '../../src/ui/traitLinkedEntities';

const trait = (name: string, linkedEntity?: string): ResolvedTrait => ({ ...createEmptyResolvedTrait(name, 'inline'), ...(linkedEntity !== undefined ? { linkedEntity } : {}) });

function ir(traits: ResolvedTrait[], pageBindings: Array<{ trait: ResolvedTrait; linkedEntity?: string }>): Pick<ResolvedIR, 'traits' | 'pages'> {
  const page = { ...createEmptyResolvedPage('Notes'), traits: pageBindings };
  return { traits: new Map(traits.map((t) => [t.name, t])), pages: new Map([['Notes', page]]) };
}

describe('buildTraitLinkedEntities', () => {
  it('an embedded trait on no page is mapped to its own binding', () => {
    const stage = trait('NotesStage', 'Note');
    const form = trait('NoteForm', 'Note');
    expect(buildTraitLinkedEntities(ir([stage, form], [{ trait: stage, linkedEntity: 'Note' }])).get('NoteForm')).toBe('Note');
  });

  it('a page binding\'s call-site record wins over the trait\'s own', () => {
    const list = trait('NoteList', 'Item');
    expect(buildTraitLinkedEntities(ir([list], [{ trait: list, linkedEntity: 'Note' }])).get('NoteList')).toBe('Note');
  });

  it('control: a trait with no binding anywhere is not mapped', () => {
    expect(buildTraitLinkedEntities(ir([trait('Clock')], [])).has('Clock')).toBe(false);
  });
});
