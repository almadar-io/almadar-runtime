// std-name-claim on the kernel: the scenarios @almadar-io/hosting's names.test.ts pins for NameClaims (one name per
// holder, first claim wins, reserved and malformed names refused before a kept name, renaming releases the old name),
// on one program whose reserved knob is hosting's test list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-name-claim');

describe.skipIf(KERNEL_DIR === undefined)('std-name-claim on the kernel', () => {
  let dir = '';
  let program = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'std-name-claim-'));
    const source = readFileSync(atom, 'utf8');
    const reserved = 'reserved : [string] = []';
    const label = 'label : string = "name"';
    for (const needle of [reserved, label]) if (!source.includes(needle)) throw new Error(`std-name-claim no longer declares ${needle}`);
    program = join(dir, 'std-name-claim.lolo');
    writeFileSync(program, source.replace(reserved, 'reserved : [string] = ["std", "almadar-behaviors"]').replace(label, 'label : string = "handle"'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const open = async (): Promise<KernelProgram> => KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '' });
  const answer = async (p: KernelProgram, event: string, payload: EventPayload): Promise<{ event: string; payload: EventPayload | undefined }> => {
    const run = await p.dispatch('NameClaimOrbital', event, payload);
    const found = run.emits.find((e) => ['NAME_CLAIMED', 'NAME_CLAIM_FAILED', 'NAME_OF_ANSWERED', 'HOLDER_OF_ANSWERED'].includes(e.event));
    if (found === undefined) throw new Error(`${event}: no answer (${run.error ?? JSON.stringify(run.rejections)})`);
    return { event: found.event, payload: found.payload };
  };
  const claim = (p: KernelProgram, name: string, holder: string, keepHeld?: boolean) => answer(p, 'CLAIM_NAME', { name, holder, ...(keepHeld !== undefined ? { keepHeld } : {}) });
  const nameOf = async (p: KernelProgram, holder: string) => (await answer(p, 'NAME_OF', { holder })).payload?.name;
  const holderOf = async (p: KernelProgram, name: string) => (await answer(p, 'HOLDER_OF', { name })).payload?.holder;

  it('a user and a team each hold one handle; the other side is refused a taken one', async () => {
    const p = await open();
    try {
      expect((await claim(p, 'osama', 'user:u1')).event).toBe('NAME_CLAIMED');
      expect((await claim(p, 'acme', 'team:t1')).event).toBe('NAME_CLAIMED');
      expect(await nameOf(p, 'user:u1')).toBe('osama');
      expect(await holderOf(p, 'acme')).toBe('team:t1');
      expect(await claim(p, 'acme', 'user:u1')).toEqual({ event: 'NAME_CLAIM_FAILED', payload: { code: 'taken', value: 'acme', message: '"acme" is taken' } });
      expect(await nameOf(p, 'user:u1')).toBe('osama');
    } finally {
      p.close();
    }
  });

  it('a reserved handle is refused', async () => {
    const p = await open();
    try {
      expect((await claim(p, 'almadar-behaviors', 'user:u1')).payload).toMatchObject({ code: 'reserved', value: 'almadar-behaviors' });
    } finally {
      p.close();
    }
  });

  it('control: a holder claiming the name it holds keeps it', async () => {
    const p = await open();
    try {
      await claim(p, 'shop', 'user:u1');
      expect(await claim(p, 'shop', 'user:u1')).toEqual({ event: 'NAME_CLAIMED', payload: { name: 'shop', holder: 'user:u1' } });
    } finally {
      p.close();
    }
  });

  it('a holder cannot move off a name it must keep; claiming that name again is fine', async () => {
    const p = await open();
    try {
      await claim(p, 'kept-one', 'user:u1');
      expect((await claim(p, 'another', 'user:u1', true)).payload).toMatchObject({ code: 'kept', value: 'kept-one' });
      expect(await nameOf(p, 'user:u1')).toBe('kept-one');
      expect((await claim(p, 'kept-one', 'user:u1', true)).event).toBe('NAME_CLAIMED');
    } finally {
      p.close();
    }
  });

  it('control: a reserved or malformed name is refused as such, before whether the held name is kept', async () => {
    const p = await open();
    try {
      await claim(p, 'kept-two', 'user:u2');
      expect((await claim(p, 'std', 'user:u2', true)).payload).toMatchObject({ code: 'reserved' });
      expect((await claim(p, 'X', 'user:u2', true)).payload).toMatchObject({ code: 'invalid', message: 'The handle "X" must be 3-40 lowercase letters, digits or hyphens, not starting or ending with a hyphen' });
    } finally {
      p.close();
    }
  });

  it('edge: renaming releases the old handle for someone else', async () => {
    const p = await open();
    try {
      await claim(p, 'first', 'user:u1');
      await claim(p, 'second', 'user:u1');
      expect(await holderOf(p, 'first')).toBe('');
      expect(await nameOf(p, 'user:u1')).toBe('second');
      expect((await claim(p, 'first', 'user:u2')).event).toBe('NAME_CLAIMED');
      expect(await p.rows('NameLock')).toHaveLength(2);
    } finally {
      p.close();
    }
  });

  it('control: a refused claim writes nothing', async () => {
    const p = await open();
    try {
      await claim(p, 'taken-one', 'user:u1');
      await claim(p, 'taken-one', 'user:u2');
      expect(await p.rows('NameHolder')).toEqual([expect.objectContaining({ id: 'user:u1', name: 'taken-one' })]);
    } finally {
      p.close();
    }
  });
});
