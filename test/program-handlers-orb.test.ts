// createProgramHandlers against the real `orb`: program/read then program/eval through the executor.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeValue, EntityRow } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor } from '../src/index.js';
import { createProgramHandlers } from '../src/effects/createProgramHandlers.js';

const ORB = process.env['ORBITAL_BIN'] ?? join(process.env['HOME'] ?? '', 'bin', 'orb');
const TMP_ROOT = join(import.meta.dirname, '.tmp-program-handlers');

function stdReachable(from: string): boolean {
    for (let dir = from; ; dir = dirname(dir)) {
        if (existsSync(join(dir, 'node_modules', '@almadar', 'std', 'package.json'))) return true;
        if (dirname(dir) === dir) return false;
    }
}
const hasOrb = existsSync(ORB) && stdReachable(import.meta.dirname);

const VALID = `orbital Hello {
  entity Greeting [runtime] {
    id : string!
  }

  trait Greet -> Greeting [interaction] {
    initial: idle

    state idle {
      INIT -> idle
        (render-ui main { type: typography, content: "hi" })
    }
  }

  page "/" -> Greet
}
`;

const EMIT = { emit: { success: 'OK', failure: 'FAILED' } };

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

function harness() {
    mkdirSync(TMP_ROOT, { recursive: true });
    const cwd = mkdtempSync(join(TMP_ROOT, 'p-'));
    const emit = vi.fn();
    const handlers = stubEffectHandlers({ emit, ...createProgramHandlers({ cwd, orbBin: ORB }) });
    const entity: EntityRow = { id: 'e-1' };
    const executor = new EffectExecutor({
        handlers,
        bindings: { entity },
        context: { traitName: 'T', state: 'idle', transition: 'idle->idle' },
        environment: 'server',
    });
    const payloads = (event: string): RuntimeValue[] => emit.mock.calls.filter(([e]) => e === event).map(([, p]) => p);
    return { cwd, entity, executor, payloads };
}

describe.skipIf(!hasOrb)('program handlers (real orb) through the executor', () => {
    it('program/read lowers .lolo text, then program/eval writes it and returns trait values', async () => {
        const { cwd, entity, executor, payloads } = harness();
        await executor.execute(['program/read', VALID, EMIT]);
        const [read] = payloads('OK');
        expect(read).toMatchObject({ result: { orbitals: [{ name: 'Hello' }] } });
        expect(payloads('FAILED')).toHaveLength(0);

        // Programs travel as bound data: a literal program in the effect would be evaluated as S-expressions.
        entity['program'] = { ...(read as { result: Record<string, RuntimeValue> }).result, name: 'HelloApp' };
        await executor.execute(['program/eval', '@entity.program', EMIT]);
        expect(payloads('FAILED')).toHaveLength(0);
        expect(payloads('OK')[1]).toEqual({
            result: { behavior: './orbitals/HelloApp', traits: [{ behavior: './orbitals/HelloApp', trait: 'Greet' }], value: { behavior: './orbitals/HelloApp' } },
        });
        expect(existsSync(join(cwd, 'orbitals', 'HelloApp.orb'))).toBe(true);
        expect(JSON.parse(readFileSync(join(cwd, 'orbitals', 'HelloApp.orb'), 'utf-8')).name).toBe('HelloApp');
    });

    it('control: unparsable .lolo text fires emit.failure and writes nothing', async () => {
        const { cwd, executor, payloads } = harness();
        await executor.execute(['program/read', 'orbital {{{ nope', EMIT]);
        expect(payloads('OK')).toHaveLength(0);
        expect(payloads('FAILED')).toHaveLength(1);
        expect(existsSync(join(cwd, 'orbitals'))).toBe(false);
    });

    it('control: an invalid program fires emit.failure with the validator issues as data', async () => {
        const { cwd, entity, executor, payloads } = harness();
        await executor.execute(['program/read', VALID, EMIT]);
        const read = (payloads('OK')[0] as { result: Record<string, RuntimeValue> }).result;
        entity['program'] = { ...read, name: 'bad name!' };
        await executor.execute(['program/eval', '@entity.program', EMIT]);
        const [failure] = payloads('FAILED');
        expect(failure).toMatchObject({ errors: [{ code: 'PROGRAM_NAME_INVALID' }] });
        expect(existsSync(join(cwd, 'orbitals'))).toBe(false);
    });
});
