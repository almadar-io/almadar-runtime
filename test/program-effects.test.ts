// The language trio's server effects (behavior/catalog|describe|source, program/read|print|eval):
// the executor arm hands the JSON args to the injected program host (whose `runProgramEffect` owns
// argument parsing — tested in @almadar/integrations) and reports through emit.success /
// emit.failure. A missing host or non-JSON args are an explicit failure, never silence.
import { describe, it, expect, vi } from 'vitest';
import type { JsonValue, RuntimeValue } from '@almadar/core';
import type { ProgramEffectName, ProgramEffectOutcome } from '@almadar/integrations/program';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import {
    EffectExecutor,
    type BindingContext,
    type EffectContext,
    type EffectHandlers,
} from '../src/index.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';

const EMIT = { emit: { success: 'OK', failure: 'FAILED' } };
const OPS: ProgramEffectName[] = ['behavior/catalog', 'behavior/describe', 'behavior/source', 'program/read', 'program/print', 'program/eval', 'program/compose'];

type ProgramEffect = NonNullable<EffectHandlers['programEffect']>;

function host(outcome: ProgramEffectOutcome) {
    return vi.fn<ProgramEffect>(async () => outcome);
}

function makeExecutor(extra: Partial<EffectHandlers>, environment: 'client' | 'server' = 'server', delegate?: ServerLegCollector) {
    const emit = vi.fn();
    const handlers = stubEffectHandlers({ emit, ...extra });
    const bindings: BindingContext = { entity: { id: 'e-1' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    return { emit, executor: new EffectExecutor({ handlers, bindings, context, environment, delegate }) };
}

function fired(emit: ReturnType<typeof vi.fn>, event: string): RuntimeValue[] {
    return emit.mock.calls.filter(([e]) => e === event).map(([, payload]) => payload);
}

describe('program effects reach the host with their JSON args', () => {
    it.each(OPS)('%s passes the op and positional args (emit config split off) and emits { result }', async (op) => {
        const programEffect = host({ ok: true, result: 'done' });
        const { emit, executor } = makeExecutor({ programEffect });
        const args: JsonValue[] = [{ paths: ['almadar-std/ui/core'] }, { into: '/tmp/x' }];
        await executor.execute([op, ...args, EMIT]);
        expect(programEffect).toHaveBeenCalledWith(op, args);
        expect(fired(emit, 'OK')).toEqual([{ result: 'done' }]);
        expect(fired(emit, 'FAILED')).toHaveLength(0);
    });

    it('a host failure fires emit.failure with { error }', async () => {
        const { emit, executor } = makeExecutor({ programEffect: host({ ok: false, error: 'orb exited 2' }) });
        await executor.execute(['behavior/catalog', { paths: ['almadar-std/ui/core'] }, EMIT]);
        expect(fired(emit, 'FAILED')).toEqual([{ error: 'orb exited 2' }]);
        expect(fired(emit, 'OK')).toHaveLength(0);
    });

    it('eval validator issues ride the failure as data', async () => {
        const errors = [{ code: 'ORB_X', message: 'bad thing', path: 'orbitals[0]' }];
        const { emit, executor } = makeExecutor({ programEffect: host({ ok: false, error: 'program/eval: 1 validation issue(s): bad thing', errors }) });
        await executor.execute(['program/eval', { name: 'X' }, EMIT]);
        expect(fired(emit, 'FAILED')).toEqual([{ error: 'program/eval: 1 validation issue(s): bad thing', errors }]);
    });

    it('a non-JSON argument (an unset binding) fails without calling the host', async () => {
        const programEffect = host({ ok: true, result: 'never' });
        const { emit, executor } = makeExecutor({ programEffect });
        await executor.execute(['program/read', '@entity.unset', EMIT]);
        expect(programEffect).not.toHaveBeenCalled();
        expect(fired(emit, 'FAILED')).toEqual([{ error: 'program/read: arguments must be JSON data' }]);
    });
});

describe('missing host', () => {
    it.each(OPS)('%s fires emit.failure naming the missing host, not silence', async (op) => {
        const { emit, executor } = makeExecutor({});
        await executor.execute([op, 'x', EMIT]);
        expect(fired(emit, 'OK')).toHaveLength(0);
        expect(fired(emit, 'FAILED')).toEqual([{ error: `no program host configured for ${op}` }]);
    });

    it.each(OPS)('%s without emit config throws', async (op) => {
        const { executor } = makeExecutor({});
        await expect(executor.execute([op, 'x'])).rejects.toThrow(`no program host configured for ${op}`);
    });
});

describe('control without emit config', () => {
    it('a successful call runs fire-and-forget and emits no events', async () => {
        const programEffect = host({ ok: true, result: 'done' });
        const { emit, executor } = makeExecutor({ programEffect });
        await executor.execute(['program/read', 'orbital Hello {}']);
        expect(programEffect).toHaveBeenCalledTimes(1);
        expect(emit).not.toHaveBeenCalled();
    });

    it('a failed call throws', async () => {
        const { executor } = makeExecutor({ programEffect: host({ ok: false, error: 'nope' }) });
        await expect(executor.execute(['program/read', 'x'])).rejects.toThrow('nope');
    });
});

describe('client delegation', () => {
    it.each(OPS)('a client executor forwards %s to the server leg without running the host', async (op) => {
        const collector = new ServerLegCollector();
        const programEffect = host({ ok: true, result: 'never' });
        const { emit, executor } = makeExecutor({ programEffect }, 'client', collector);
        await executor.execute([op, 'x', EMIT]);
        expect(collector.drain().map((e) => e[0])).toEqual([op]);
        expect(programEffect).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });
});
