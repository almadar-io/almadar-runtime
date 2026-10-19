// std-file-drop on the kernel with the Node os host: a delivery at the file-drop hook is written under the directory and
// answered with its path; a body or a name of the wrong shape is refused before anything is written.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-file-drop');
const DEFAULT_DIR = '/var/lib/almadar/drop/';

describe.skipIf(KERNEL_DIR === undefined)('std-file-drop on the kernel', () => {
  let scratch = '';
  let dir = '';
  let program: KernelProgram;

  beforeEach(async () => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'std-file-drop-'));
    dir = join(scratch, 'drop') + '/';
    const source = readFileSync(atom, 'utf8');
    if (source.split(DEFAULT_DIR).length !== 3) throw new Error(`std-file-drop no longer names ${DEFAULT_DIR} as its grant and its dir default`);
    const file = join(scratch, 'std-file-drop-here.lolo');
    writeFileSync(file, source.split(DEFAULT_DIR).join(dir));
    program = await KernelProgram.open(await resolveProgramFile(file, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
  });
  afterEach(() => {
    program.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const deliver = (body: string) => program.deliverInbound('file-drop', { headers: { 'Content-Type': 'application/json' }, rawBody: body });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

  it('writes the delivered bytes as <dir><name>.png and answers 201 with the path', async () => {
    const answer = await deliver(JSON.stringify({ name: 'shot-1', data: png.toString('base64') }));
    expect(answer.status, answer.body).toBe(201);
    expect(JSON.parse(answer.body)).toEqual({ path: `${dir}shot-1.png` });
    expect(readFileSync(`${dir}shot-1.png`).equals(png)).toBe(true);
  });

  it('a nested name makes its directory', async () => {
    const answer = await deliver(JSON.stringify({ name: 'site/home-dark', data: png.toString('base64') }));
    expect(answer.status).toBe(201);
    expect(readFileSync(`${dir}site/home-dark.png`).equals(png)).toBe(true);
  });

  it('control: a name that could leave the directory, or a body of the wrong shape, answers 400 and writes nothing', async () => {
    for (const body of [
      JSON.stringify({ name: '../escape', data: png.toString('base64') }),
      JSON.stringify({ name: '/abs', data: png.toString('base64') }),
      JSON.stringify({ name: 'a//b', data: png.toString('base64') }),
      JSON.stringify({ name: 'ok' }),
      JSON.stringify({ data: png.toString('base64') }),
      'not json',
    ]) {
      expect((await deliver(body)).status, body).toBe(400);
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
