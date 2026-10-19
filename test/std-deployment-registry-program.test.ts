// std-deployment-registry on the kernel: the generic half of the scenarios @almadar-io/hosting's deployments.test.ts pins
// for Deployments (versions from 1 per artifact, an activating deployment becomes active, one that does not is history
// only, rollback re-activates an earlier activating version and refuses the others, withdraw keeps the history, history
// carries each deployment's details and when it was recorded).
import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-deployment-registry');

describe.skipIf(KERNEL_DIR === undefined)('std-deployment-registry on the kernel', () => {
  const open = async (): Promise<KernelProgram> => KernelProgram.open(await resolveProgramFile(atom, process.cwd()), { kernelDir: KERNEL_DIR ?? '' });
  const ANSWERS = ['DEPLOYED', 'DEPLOY_FAILED', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'WITHDRAWN', 'WITHDRAW_FAILED', 'RESOLVED', 'HISTORY_ANSWERED'];
  const ask = async (p: KernelProgram, event: string, payload: EventPayload): Promise<{ event: string; payload: EventPayload | undefined }> => {
    const run = await p.dispatch('DeploymentRegistryOrbital', event, payload);
    const found = run.emits.find((e) => ANSWERS.includes(e.event));
    if (found === undefined) throw new Error(`${event}: no answer (${run.error ?? JSON.stringify(run.rejections)})`);
    return { event: found.event, payload: found.payload };
  };
  const deploy = (p: KernelProgram, artifact: string, activates: boolean, details: EventPayload = {}) => ask(p, 'DEPLOY', { artifact, activates, details });
  const resolve = async (p: KernelProgram, artifact: string) => (await ask(p, 'RESOLVE', { artifact })).payload;

  it('an activating deployment becomes active: the artifact resolves to that version and its details', async () => {
    const p = await open();
    try {
      expect(await deploy(p, 'acme/shop', true, { commit: 'c1', packageVersion: '1.0.0', rowQuota: 500 })).toEqual({ event: 'DEPLOYED', payload: { artifact: 'acme/shop', version: 1 } });
      expect(await resolve(p, 'acme/shop')).toMatchObject({ found: true, version: 1, details: { commit: 'c1', packageVersion: '1.0.0', rowQuota: 500 } });
    } finally {
      p.close();
    }
  });

  it('control: the same name under another artifact is a different one', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', true);
      expect(await resolve(p, 'other/shop')).toMatchObject({ found: false, version: 0 });
    } finally {
      p.close();
    }
  });

  it('a deployment that does not activate is recorded in history but never becomes active', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', false, { target: 'own-cloud' });
      expect(await resolve(p, 'acme/shop')).toMatchObject({ found: false });
      const history = (await ask(p, 'HISTORY', { artifact: 'acme/shop' })).payload?.deployments;
      expect(history).toEqual([expect.objectContaining({ version: 1, activates: false, details: { target: 'own-cloud' } })]);
    } finally {
      p.close();
    }
  });

  it('a rollback re-activates an earlier version, and a newer deployment moves forward again', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', true, { commit: 'c1' });
      await deploy(p, 'acme/shop', true, { commit: 'c2' });
      expect((await ask(p, 'ROLLBACK', { artifact: 'acme/shop', version: 1 })).event).toBe('ROLLED_BACK');
      expect(await resolve(p, 'acme/shop')).toMatchObject({ version: 1, details: { commit: 'c1' } });
      expect((await deploy(p, 'acme/shop', true, { commit: 'c3' })).payload).toMatchObject({ version: 3 });
      expect(await resolve(p, 'acme/shop')).toMatchObject({ version: 3, details: { commit: 'c3' } });
    } finally {
      p.close();
    }
  });

  it('edge: rolling back to a version that may not serve, or one never recorded, is refused', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', true);
      await deploy(p, 'acme/shop', false);
      expect((await ask(p, 'ROLLBACK', { artifact: 'acme/shop', version: 2 })).payload).toMatchObject({ code: 'not-activatable' });
      expect((await ask(p, 'ROLLBACK', { artifact: 'acme/shop', version: 9 })).payload).toMatchObject({ code: 'not-recorded', message: 'acme/shop has no recorded version 9' });
      expect(await resolve(p, 'acme/shop')).toMatchObject({ version: 1 });
    } finally {
      p.close();
    }
  });

  it('versions are numbered from 1, independently per artifact', async () => {
    const p = await open();
    try {
      expect((await deploy(p, 'a/one', true)).payload).toMatchObject({ version: 1 });
      expect((await deploy(p, 'a/one', true)).payload).toMatchObject({ version: 2 });
      expect((await deploy(p, 'a/two', true)).payload).toMatchObject({ version: 1 });
      expect((await deploy(p, 'a/one', false)).payload).toMatchObject({ version: 3 });
    } finally {
      p.close();
    }
  });

  it('withdraw leaves nothing active; its history stays', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', true);
      expect((await ask(p, 'WITHDRAW', { artifact: 'acme/shop' })).event).toBe('WITHDRAWN');
      expect(await resolve(p, 'acme/shop')).toMatchObject({ found: false });
      expect((await ask(p, 'HISTORY', { artifact: 'acme/shop' })).payload?.deployments).toHaveLength(1);
      expect((await ask(p, 'WITHDRAW', { artifact: 'acme/shop' })).event).toBe('WITHDRAWN');
    } finally {
      p.close();
    }
  });

  it('history is oldest first and carries each deployment\'s details and when it was recorded', async () => {
    const p = await open();
    try {
      await deploy(p, 'acme/shop', true, { publishedBy: 'u1', gateReport: '{"checks":[]}' });
      await deploy(p, 'acme/shop', true, { publishedBy: 'u2' });
      const history = (await ask(p, 'HISTORY', { artifact: 'acme/shop' })).payload?.deployments;
      expect(Array.isArray(history) ? history.map((d) => (typeof d === 'object' && d !== null && !Array.isArray(d) ? d.version : null)) : []).toEqual([1, 2]);
      expect(history).toEqual([
        expect.objectContaining({ details: { publishedBy: 'u1', gateReport: '{"checks":[]}' }, recordedAt: expect.any(Number) }),
        expect.objectContaining({ details: { publishedBy: 'u2' } }),
      ]);
    } finally {
      p.close();
    }
  });
});
