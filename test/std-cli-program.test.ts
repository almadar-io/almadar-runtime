// std-cli on the Node os host: a program composing it runs real `sh` children and answers CLI_DONE / CLI_FAILED.
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile, type ProgramRun } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const fixture = fileURLToPath(new URL('./fixtures/std-cli-sh.lolo', import.meta.url));
const inTmp = fileURLToPath(new URL('./fixtures/std-cli-sh-tmp.lolo', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/std-cli-sh-binary.lolo', import.meta.url));

function answer(run: ProgramRun, event: string): EventPayload | undefined {
  return run.emits.find((emit) => emit.event === event)?.payload;
}

describe.skipIf(KERNEL_DIR === undefined)('std-cli on the Node os host', () => {
  let open: KernelProgram | undefined;
  afterEach(() => { open?.close(); open = undefined; });

  async function sh(script: string, stage = 'run'): Promise<ProgramRun> {
    open ??= await KernelProgram.open(await resolveProgramFile(fixture), { kernelDir: KERNEL_DIR ?? '', os: true });
    return open.dispatch('ShOrbital', 'CLI_RUN', { stage, argv: ['-c', script] });
  }

  it('answers the stage, exit code 0 and stdout of a finished child', async () => {
    const run = await sh('printf hello', 'greet');
    expect(run.success).toBe(true);
    expect(answer(run, 'CLI_DONE')).toEqual({ stage: 'greet', exitCode: 0, signal: 0, stdout: 'hello', stdoutBytes: Buffer.from('hello').toString('base64'), stderr: '' });
    expect(answer(run, 'CLI_FAILED')).toBeUndefined();
  });

  it('a non-zero exit is still CLI_DONE, with the code and the stderr text', async () => {
    const run = await sh('printf oops >&2; exit 3');
    expect(answer(run, 'CLI_DONE')).toEqual({ stage: 'run', exitCode: 3, signal: 0, stdout: '', stdoutBytes: '', stderr: 'oops' });
  });

  it('output longer than one 64 KiB read is collected whole, from both streams', async () => {
    const run = await sh("head -c 200000 /dev/zero | tr '\\000' a; head -c 70000 /dev/zero | tr '\\000' b >&2");
    const done = answer(run, 'CLI_DONE');
    expect(typeof done?.stdout === 'string' ? done.stdout.length : -1).toBe(200000);
    expect(typeof done?.stderr === 'string' ? done.stderr.length : -1).toBe(70000);
    expect(done?.exitCode).toBe(0);
  });

  it('a child ended by a signal answers exit code -1 and the signal', async () => {
    const run = await sh('kill -TERM $$');
    const done = answer(run, 'CLI_DONE');
    expect(done?.exitCode).toBe(-1);
    expect(done?.signal).toBe(15);
  });

  it('runs back to back, each answered once', async () => {
    const first = await sh('printf one', 'a');
    const second = await sh('printf two', 'b');
    expect(answer(first, 'CLI_DONE')?.stdout).toBe('one');
    expect(answer(second, 'CLI_DONE')).toMatchObject({ stage: 'b', stdout: 'two' });
    expect(second.emits.filter((emit) => emit.event === 'CLI_DONE')).toHaveLength(1);
  });

  it('a run\'s env replaces the knob\'s environment; without one the child gets the knob\'s (empty) environment', async () => {
    open ??= await KernelProgram.open(await resolveProgramFile(fixture), { kernelDir: KERNEL_DIR ?? '', os: true });
    const withEnv = await open.dispatch('ShOrbital', 'CLI_RUN', { stage: 'env', argv: ['-c', 'printf "%s" "$FOO"'], env: { FOO: 'bar' } });
    expect(answer(withEnv, 'CLI_DONE')?.stdout).toBe('bar');
    const without = await open.dispatch('ShOrbital', 'CLI_RUN', { stage: 'env', argv: ['-c', 'printf "%s" "$FOO"'] });
    expect(answer(without, 'CLI_DONE')?.stdout).toBe('');
  });

  it('the cwd knob runs the child in that directory; empty runs it in the host\'s', async () => {
    const tmp = await KernelProgram.open(await resolveProgramFile(inTmp), { kernelDir: KERNEL_DIR ?? '', os: true });
    try {
      const run = await tmp.dispatch('ShTmpOrbital', 'CLI_RUN', { stage: 'pwd', argv: ['-c', 'pwd -P'] });
      expect(answer(run, 'CLI_DONE')?.stdout).toMatch(/\/tmp\n$/);
    } finally {
      tmp.close();
    }
    const here = await sh('pwd -P');
    expect(answer(here, 'CLI_DONE')?.stdout).toBe(`${realpathSync(process.cwd())}\n`);
  });

  it('stdin bytes are fed to the child and closed', async () => {
    open ??= await KernelProgram.open(await resolveProgramFile(fixture), { kernelDir: KERNEL_DIR ?? '', os: true });
    const run = await open.dispatch('ShOrbital', 'CLI_RUN', { stage: 'cat', argv: ['-c', 'cat; printf "|done"'], stdin: Buffer.from('hello').toString('base64') });
    expect(answer(run, 'CLI_DONE')?.stdout).toBe('hello|done');
    const none = await sh('cat; printf "|done"');
    expect(answer(none, 'CLI_DONE')?.stdout).toBe('|done');
  });

  it('with binaryOutput, bytes that are not UTF-8 are answered in stdoutBytes and stdout is empty', async () => {
    const bin = await KernelProgram.open(await resolveProgramFile(binary), { kernelDir: KERNEL_DIR ?? '', os: true });
    try {
      const run = await bin.dispatch('ShBinOrbital', 'CLI_RUN', { stage: 'bin', argv: ['-c', "printf '\\000\\001\\377'"] });
      expect(answer(run, 'CLI_DONE')).toMatchObject({ stdout: '', stdoutBytes: Buffer.from([0, 1, 255]).toString('base64'), exitCode: 0 });
    } finally {
      bin.close();
    }
  });

  it('control: a cancel with nothing running answers cli_idle and no CLI_DONE', async () => {
    open ??= await KernelProgram.open(await resolveProgramFile(fixture), { kernelDir: KERNEL_DIR ?? '', os: true });
    const run = await open.dispatch('ShOrbital', 'CLI_CANCEL', {});
    expect(answer(run, 'CLI_FAILED')).toEqual({ stage: '', error: 'nothing is running', code: 'cli_idle' });
    expect(answer(run, 'CLI_DONE')).toBeUndefined();
  });
});
