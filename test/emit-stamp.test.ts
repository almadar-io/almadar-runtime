/**
 * stampEmitSource — the one stamper (G-RUNTIME-030's hole stays closed:
 * every path fills the V4 triple identically, never overwrites).
 */
import { describe, it, expect } from 'vitest';
import { stampEmitSource } from '../src/emit-stamp.js';
import type { BusEventSource } from '@almadar/core';

describe('stampEmitSource', () => {
  it('synthesizes a name stamp from the lexical identity when no source is given', () => {
    const stamp = stampEmitSource(undefined, { orbitalName: 'App', traitName: 'Composer' });
    expect(stamp).toEqual({ orbital: 'App', trait: 'Composer' });
  });

  it('fills the V4 triple + originClientId onto a given source', () => {
    const source: BusEventSource = { orbital: 'App', trait: 'Composer' };
    const stamp = stampEmitSource(source, {
      orbitalName: 'App',
      traitName: 'Composer',
      orbitalId: 'orb_1' as BusEventSource['orbitalId'],
      traitId: 'trt_1' as BusEventSource['traitId'],
      emitContractEventId: 'evt_1' as BusEventSource['eventId'],
      originClientId: 'tab-1',
    });
    expect(stamp).toBe(source);
    expect(stamp).toEqual({
      orbital: 'App',
      trait: 'Composer',
      orbitalId: 'orb_1',
      traitId: 'trt_1',
      eventId: 'evt_1',
      originClientId: 'tab-1',
    });
  });

  it('never overwrites fields already set on the stamp', () => {
    const source: BusEventSource = {
      orbital: 'App',
      trait: 'Composer',
      traitId: 'trt_existing' as BusEventSource['traitId'],
      originClientId: 'tab-original',
    };
    const stamp = stampEmitSource(source, {
      orbitalName: 'App',
      traitName: 'Composer',
      traitId: 'trt_new' as BusEventSource['traitId'],
      originClientId: 'tab-new',
    });
    expect(stamp.traitId).toBe('trt_existing');
    expect(stamp.originClientId).toBe('tab-original');
  });

  it('absent ids stay absent (legacy name-only stamp)', () => {
    const stamp = stampEmitSource(undefined, { orbitalName: 'App', traitName: 'T' });
    expect(stamp.orbitalId).toBeUndefined();
    expect(stamp.traitId).toBeUndefined();
    expect(stamp.eventId).toBeUndefined();
    expect(stamp.originClientId).toBeUndefined();
  });
});
