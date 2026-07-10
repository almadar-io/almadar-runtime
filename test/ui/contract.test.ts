import { describe, it, expect, vi } from 'vitest';
import type { AnyPatternConfig } from '@almadar/core';
import {
  assertIsSlotManager,
  assertIsMultiSourceSlotManager,
  validateSlotContent,
  RendererContractViolationError,
  type SlotManager,
  type MultiSourceSlotManager,
  type SlotContent,
} from '../../src/ui';

describe('@almadar/runtime/ui contract validators', () => {
  it('assertIsSlotManager accepts a valid manager', () => {
    const manager: SlotManager = {
      getContent: vi.fn(),
      setContent: vi.fn(),
      clearSlot: vi.fn(),
      getAllSlots: vi.fn(),
      subscribe: vi.fn(),
    };

    expect(() => assertIsSlotManager(manager)).not.toThrow();
  });

  it('assertIsSlotManager rejects non-objects', () => {
    expect(() => assertIsSlotManager(null)).toThrow(RendererContractViolationError);
    expect(() => assertIsSlotManager(undefined)).toThrow(RendererContractViolationError);
    expect(() => assertIsSlotManager('string')).toThrow(RendererContractViolationError);
  });

  it('assertIsSlotManager rejects missing methods', () => {
    const partial = {
      getContent: vi.fn(),
      setContent: vi.fn(),
    };

    expect(() => assertIsSlotManager(partial)).toThrow(RendererContractViolationError);
  });

  it('assertIsMultiSourceSlotManager accepts a valid manager', () => {
    const manager: MultiSourceSlotManager = {
      getContent: vi.fn(),
      setContent: vi.fn(),
      clearSlot: vi.fn(),
      getAllSlots: vi.fn(),
      subscribe: vi.fn(),
      getTraitContent: vi.fn(),
      subscribeTrait: vi.fn(),
      updateTraitContent: vi.fn(),
    };

    expect(() => assertIsMultiSourceSlotManager(manager)).not.toThrow();
  });

  it('assertIsMultiSourceSlotManager rejects base SlotManager', () => {
    const manager: SlotManager = {
      getContent: vi.fn(),
      setContent: vi.fn(),
      clearSlot: vi.fn(),
      getAllSlots: vi.fn(),
      subscribe: vi.fn(),
    };

    expect(() => assertIsMultiSourceSlotManager(manager)).toThrow(
      RendererContractViolationError,
    );
  });

  it('validateSlotContent reports missing slot', () => {
    // Intentionally malformed runtime input; validator must catch it.
    // @ts-expect-error testing runtime validation of an invalid SlotContent
    const content: SlotContent = {
      pattern: null,
    };

    const errors = validateSlotContent(content);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path === 'slot')).toBe(true);
  });

  it('validateSlotContent passes valid content', () => {
    const pattern: AnyPatternConfig = { type: 'button', label: 'Click' };
    const content: SlotContent = {
      slot: 'main',
      pattern,
    };

    expect(validateSlotContent(content)).toEqual([]);
  });
});
