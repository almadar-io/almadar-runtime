// program/inputs, program/dispatch and persist/read-named through the interpreter's executor: the same
// vectors the Rust kernel runs (`orbital-core-runtime` tests/agent_ports.rs), the same emitted trace.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
    externalInputsOf,
    parseOrbitalSchema,
    readableEntitiesOf,
    type EntityRow,
    type JsonValue,
    type OrbitalEventResponse,
    type RuntimeValue,
    type ServiceHostPorts,
} from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type EffectHandlers } from '../src/index.js';

interface Dispatched {
    address: string;
    payload: JsonValue;
}

interface Case {
    name: string;
    op: string;
    args: JsonValue[];
    dispatched: Dispatched | null;
    expect: JsonValue;
    text?: string;
}

interface Vectors {
    caller: { orbital: string; trait: string };
    schema: JsonValue;
    rows: Record<string, EntityRow[]>;
    scripted: Record<string, OrbitalEventResponse>;
    cases: Case[];
}

const EMIT = { emit: { success: 'OK', failure: 'FAILED' } };
const local = new URL('./fixtures/agent-ports/vectors.json', import.meta.url);
const vectors: Vectors = JSON.parse(readFileSync(local, 'utf8'));
const schema = parseOrbitalSchema(vectors.schema);

function hostPorts(dispatched: Dispatched[]): ServiceHostPorts {
    return {
        caller: vectors.caller,
        message: () => {},
        inputs: () => externalInputsOf(schema),
        readableEntities: () => readableEntitiesOf(schema),
        dispatchInput: async (orbital, request) => {
            const payload: JsonValue = JSON.parse(JSON.stringify(request.payload ?? {}));
            dispatched.push({ address: `${orbital}.${request.targetTrait}.${request.event}`, payload });
            const scripted = vectors.scripted[request.event];
            if (scripted === undefined) throw new Error(`no scripted response for ${request.event}`);
            return scripted;
        },
        read: async (entity) => vectors.rows[entity] ?? [],
    };
}

function makeExecutor(extra: Partial<EffectHandlers>) {
    const emit = vi.fn();
    const handlers = stubEffectHandlers({ emit, ...extra });
    const bindings: BindingContext = { entity: { id: 'e-1' } };
    const context: EffectContext = { traitName: vectors.caller.trait, state: 'idle', transition: 'idle->idle' };
    return { emit, executor: new EffectExecutor({ handlers, bindings, context, environment: 'server' }) };
}

function fired(emit: ReturnType<typeof vi.fn>, event: string): RuntimeValue[] {
    return emit.mock.calls.filter(([e]) => e === event).map(([, payload]) => payload);
}

describe('agent ports: shared vectors through the executor', () => {
    for (const c of vectors.cases) {
        it(c.name, async () => {
            const dispatched: Dispatched[] = [];
            const { emit, executor } = makeExecutor({ agentPorts: () => hostPorts(dispatched) });
            await executor.execute([c.op, ...c.args, EMIT]);
            const expected = c.expect;
            if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) throw new Error('vector expectation is not an outcome');
            if (expected['ok'] === true) {
                const result = expected['result'];
                expect(fired(emit, 'OK')).toEqual([{ result, text: JSON.stringify(result) }]);
                if (c.text !== undefined) expect(JSON.stringify(result)).toBe(c.text);
                expect(fired(emit, 'FAILED')).toHaveLength(0);
            } else {
                const { ok: _ok, ...failure } = expected;
                expect(fired(emit, 'FAILED')).toEqual([failure]);
                expect(fired(emit, 'OK')).toHaveLength(0);
            }
            expect(dispatched).toEqual(c.dispatched === null ? [] : [c.dispatched]);
        });
    }
});

describe('missing ports', () => {
    it.each(['program/inputs', 'program/dispatch', 'persist/read-named'])('%s fires emit.failure naming the missing ports, not silence', async (op) => {
        const { emit, executor } = makeExecutor({});
        await executor.execute([op, 'x', EMIT]);
        expect(fired(emit, 'OK')).toHaveLength(0);
        expect(fired(emit, 'FAILED')).toEqual([{ error: `no host ports configured for ${op}` }]);
    });

    it.each(['program/inputs', 'program/dispatch', 'persist/read-named'])('%s without emit config throws', async (op) => {
        const { executor } = makeExecutor({});
        await expect(executor.execute([op, 'x'])).rejects.toThrow(`no host ports configured for ${op}`);
    });

    it.each([
        ['persist/read-named', ['@entity.unset']],
        ['program/dispatch', ['@payload.address', {}]],
        ['program/inputs', [{ select: [{ event: '@payload.event' }] }]],
    ])('%s with an unresolved binding fails the call, as the Rust kernel does', async (op, args) => {
        const dispatched: Dispatched[] = [];
        const { emit, executor } = makeExecutor({ agentPorts: () => hostPorts(dispatched) });
        await executor.execute([op, ...args, EMIT]);
        expect(dispatched).toEqual([]);
        expect(fired(emit, 'FAILED')).toEqual([{ error: `${op}: arguments must be JSON data` }]);
    });

    it('a non-JSON argument (an unset binding) fails without touching the ports', async () => {
        const dispatched: Dispatched[] = [];
        const agentPorts = vi.fn(() => hostPorts(dispatched));
        const { emit, executor } = makeExecutor({ agentPorts });
        await executor.execute(['persist/read-named', '@entity.unset', EMIT]);
        expect(dispatched).toEqual([]);
        expect(fired(emit, 'FAILED')).toEqual([{ error: 'persist/read-named: arguments must be JSON data' }]);
    });
});
