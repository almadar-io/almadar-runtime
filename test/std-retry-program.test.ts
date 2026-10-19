// std-retry on the kernel: attempts are numbered from 1, a failure schedules the next after the backoff, and the
// attempts spent give up.
import { describe, expect, it } from 'vitest';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-retry');
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe.skipIf(KERNEL_DIR === undefined)('std-retry on the kernel', () => {
  const open = async (): Promise<KernelProgram> => KernelProgram.open(await resolveProgramFile(atom, process.cwd()), { kernelDir: KERNEL_DIR ?? '' });
  const attempts = (run: { emits: Array<{ event: string; payload?: { [k: string]: unknown } | undefined }> }) =>
    run.emits.filter((e) => e.event === 'ATTEMPT').map((e) => e.payload?.attempt);
  /** Fire the backoff tick every 100 ms, as a host would, until something is emitted. */
  const due = async (p: KernelProgram) => {
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const run = await p.tick('RetryOrbital', 'Retry', 'backoffCheck');
      if (run.emits.length > 0) return run;
    }
    throw new Error('the backoff never fired');
  };

  it('numbers each attempt: 1, then 2 after the first failure, then 3', async () => {
    const p = await open();
    try {
      expect(attempts(await p.dispatch('RetryOrbital', 'START', { key: 'k1' }))).toEqual([1]);
      await p.dispatch('RetryOrbital', 'FAILED', { key: 'k1', error: 'boom' });
      expect(attempts(await due(p))).toEqual([2]);
      await p.dispatch('RetryOrbital', 'FAILED', { key: 'k1', error: 'boom' });
      expect(attempts(await due(p))).toEqual([3]);
    } finally {
      p.close();
    }
  });

  it('control: the last failure gives up with the attempts made', async () => {
    const p = await open();
    try {
      await p.dispatch('RetryOrbital', 'START', { key: 'k1' });
      await p.dispatch('RetryOrbital', 'FAILED', { key: 'k1', error: 'a' });
      await due(p);
      await p.dispatch('RetryOrbital', 'FAILED', { key: 'k1', error: 'b' });
      await due(p);
      const run = await p.dispatch('RetryOrbital', 'FAILED', { key: 'k1', error: 'c' });
      expect(run.emits.find((e) => e.event === 'GAVE_UP')?.payload).toMatchObject({ key: 'k1', attempts: 3, error: 'c' });
    } finally {
      p.close();
    }
  });
});
