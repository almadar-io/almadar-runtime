// std-workspace record/replay parity on the Node os host: the live std-workspace source with its root (knob default and fs
// grant) pointed at a temp directory runs one scenario on real git; every step's public answers are pinned in a file
// snapshot (recorded before std-workspace composed std-cli), with commit ids, times and the temp root normalized.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toWireValue, type EventPayload, type JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const atom = fileURLToPath(new URL('../../almadar-std/behaviors/lolo/infra/atoms/std-workspace.lolo', import.meta.url));
const ROOT = '/var/lib/almadar/workspaces';
const USER = { id: 'u1' };

type Step = { event: string; payload: EventPayload };

function steps(oid: (n: number) => string): Step[] {
  const ws = { workspace: 'w1' };
  return [
    { event: 'WORKSPACE_WRITE_FILE', payload: { ...ws, path: 'schema.orb', content: '{"name":"a"}\n' } },
    { event: 'WORKSPACE_WRITE_FILE', payload: { ...ws, path: 'orbitals/x.lolo', content: 'app x [ version: "1.0.0" ]\n' } },
    { event: 'WORKSPACE_TREE', payload: { ...ws } },
    { event: 'WORKSPACE_READ_FILE', payload: { ...ws, path: 'orbitals/x.lolo' } },
    { event: 'WORKSPACE_SNAPSHOT', payload: { ...ws, reason: 'first' } },
    { event: 'WORKSPACE_WRITE_FILE', payload: { ...ws, path: 'schema.orb', content: '{"name":"b"}\n' } },
    { event: 'WORKSPACE_SNAPSHOT', payload: { ...ws, reason: 'second' } },
    { event: 'WORKSPACE_HISTORY', payload: { ...ws, limit: 10 } },
    { event: 'WORKSPACE_CHANGES', payload: { ...ws, oid: oid(2) } },
    { event: 'WORKSPACE_UNDO', payload: { ...ws } },
    { event: 'WORKSPACE_HISTORY', payload: { ...ws, limit: 10 } },
    { event: 'WORKSPACE_REDO', payload: { ...ws } },
    { event: 'WORKSPACE_RESTORE', payload: { ...ws, oid: oid(1) } },
    { event: 'WORKSPACE_READ_FILE', payload: { ...ws, path: 'schema.orb' } },
    { event: 'WORKSPACE_REMOVE_FILE', payload: { ...ws, path: 'orbitals/x.lolo' } },
    { event: 'WORKSPACE_READ_FILE', payload: { ...ws, path: 'orbitals/missing.lolo' } },
  ];
}

const PUBLIC = /^WORKSPACE_[A-Z_]+$/;

function normalizer(root: string) {
  const oids = new Map<string, string>();
  const fix = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      let s = value.split(root).join('<root>');
      s = s.replace(/\b[0-9a-f]{40}\b/g, (hex) => {
        if (!oids.has(hex)) oids.set(hex, `<oid-${oids.size + 1}>`);
        return oids.get(hex) ?? hex;
      });
      s = s.replace(/\b[0-9a-f]{7,39}\b/g, (short) => {
        const full = [...oids.keys()].find((hex) => hex.startsWith(short));
        return full === undefined ? short : `${oids.get(full)}:short`;
      });
      return s;
    }
    if (typeof value === 'number') return value > 1_000_000_000 ? '<ts>' : value;
    if (Array.isArray(value)) return value.map(fix);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]));
    return value;
  };
  return { fix, oidOf: (n: number) => [...oids.entries()].find(([, label]) => label === `<oid-${n}>`)?.[0] ?? '' };
}

describe.skipIf(KERNEL_DIR === undefined)('std-workspace on the Node os host (record/replay parity)', () => {
  let dir = '';
  let program = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'std-workspace-')));
    mkdirSync(join(dir, 'ws'));
    const source = readFileSync(atom, 'utf8');
    if (source.split(ROOT).length < 3) throw new Error('std-workspace no longer names its root in the grant and the knob');
    program = join(dir, 'std-workspace.lolo');
    writeFileSync(program, source.split(ROOT).join(join(dir, 'ws')));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('one scenario answers as recorded', async () => {
    const open = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
    const { fix, oidOf } = normalizer(join(dir, 'ws'));
    const transcript: JsonValue[] = [];
    try {
      const plan = steps((n) => oidOf(n));
      for (let i = 0; i < plan.length; i += 1) {
        const step = steps((n) => oidOf(n))[i];
        const run = await open.dispatch('WorkspaceOrbital', step.event, step.payload, undefined, USER);
        const answers = run.emits.filter((emit) => PUBLIC.test(emit.event) && emit.event !== step.event).map((emit) => ({ event: emit.event, payload: fix(toWireValue(emit.payload ?? {})) }));
        expect(answers.length, `${step.event} answered`).toBeGreaterThan(0);
        transcript.push({ request: step.event, answers });
      }
    } finally {
      open.close();
    }
    await expect(JSON.stringify(transcript, null, 2) + '\n').toMatchFileSnapshot('./fixtures/std-workspace-parity/scenario.json');
  });
});
