/**
 * A compiled client's browser leg evaluates `i18n/t` like any server: with the
 * program's catalogs and the viewer locale the request carries. Without them a
 * leg whose effects translate failed and the client rolled the step back.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { openBundledBrowserStore } from '../src/evaluation/browser-store-transport';

function bundled(): OrbitalSchema {
  return {
    name: `Greet-${Math.random()}`,
    locales: ['en', 'ar'],
    orbitals: [{
      name: 'Greet',
      entity: {
        name: 'Note', persistence: 'persistent', collection: 'notes', local: true,
        fields: [{ name: 'id', type: 'string', required: true }],
        instances: [{ id: 'n1' }],
      },
      traits: [{
        name: 'Greeter', linkedEntity: 'Note', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'SAY', name: 'SAY' }, { key: 'SAID', name: 'SAID' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'SAY', effects: [['emit', 'SAID', { text: ['i18n/t', 'greet:hello'] }]] },
          ],
        },
      }],
      pages: [],
    }],
  };
}

const MESSAGES = { en: { 'greet:hello': 'Hello' }, ar: { 'greet:hello': 'مرحبا' } };

function saidText(response: OrbitalEventResponse): string | undefined {
  const text = response.emittedEvents.find((e) => e.event === 'SAID')?.payload?.text;
  return typeof text === 'string' ? text : undefined;
}

describe('a bundled browser store translates with the catalogs it is given', () => {
  it('uses the request locale\'s message', async () => {
    const transport = await openBundledBrowserStore(JSON.parse(JSON.stringify(bundled())), 'ar', undefined, MESSAGES);
    const response = await transport.send('Greet', { event: 'SAY', locale: 'ar', traits: [{ trait: 'Greeter', from: 'idle' }] });
    expect(response.success).toBe(true);
    expect(saidText(response)).toBe('مرحبا');
  });

  it('a request without a locale uses the program\'s first locale', async () => {
    const transport = await openBundledBrowserStore(JSON.parse(JSON.stringify(bundled())), 'en', undefined, MESSAGES);
    const response = await transport.send('Greet', { event: 'SAY', traits: [{ trait: 'Greeter', from: 'idle' }] });
    expect(saidText(response)).toBe('Hello');
  });

  it('control: without catalogs the translating leg fails', async () => {
    const transport = await openBundledBrowserStore(JSON.parse(JSON.stringify(bundled())), 'en');
    const response = await transport.send('Greet', { event: 'SAY', traits: [{ trait: 'Greeter', from: 'idle' }] });
    // A failing effect stops only its transition (G-UI-097): the missing message is reported, not thrown.
    expect(response.rejections).toEqual([expect.objectContaining({ code: 'effect-failed', trait: 'Greeter', error: expect.stringMatching(/no `en` message/) })]);
    expect(saidText(response)).toBeUndefined();
  });
});
