// std-docker record/replay parity on the Node os host: the live std-docker source with only its env knob's default pointed
// at a fake `docker`, which answers every subcommand; each operation's public answers and the argv it ran are pinned in a
// file snapshot (recorded before std-docker composed std-cli).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const atom = fileURLToPath(new URL('../../almadar-std/behaviors/lolo/infra/atoms/std-docker.lolo', import.meta.url));
const fakeDir = fileURLToPath(new URL('./fixtures/fake-docker', import.meta.url));
const ENV_KNOB = '      env : Map string string = {}\n';

function programOnFakeDocker(dir: string): string {
  const source = readFileSync(atom, 'utf8');
  if (!source.includes(ENV_KNOB)) throw new Error('std-docker no longer declares the env knob this test points at the fake docker');
  const file = join(dir, 'std-docker.lolo');
  writeFileSync(file, source.replace(ENV_KNOB, `      env : Map string string = { PATH: "${fakeDir}" }\n`));
  return file;
}
const LOG = '/tmp/almadar-fake-docker.log';

/** buildTime is measured on the monotonic clock, so only its kind is pinned. */
function withoutClock(payload: EventPayload): EventPayload {
  if (!('buildTime' in payload)) return payload;
  const { buildTime, ...rest } = payload;
  return { ...rest, buildTime: typeof buildTime === 'number' && buildTime >= 0 ? 'non-negative number' : buildTime };
}
const PUBLIC = new Set(['BUILD_DONE', 'RUN_DONE', 'STOP_DONE', 'REMOVE_DONE', 'LOGS_DONE', 'STATUS_DONE', 'LIST_DONE', 'DOCKER_FAILED']);

const OPS: ReadonlyArray<{ name: string; event: string; payload: EventPayload }> = [
  { name: 'build', event: 'BUILD', payload: { tag: 'app:1', buildArgs: { A: '1' } } },
  { name: 'run', event: 'RUN', payload: { image: 'nginx', name: 'web', ports: [{ host: 8080, container: 80 }], env: { K: 'v' } } },
  { name: 'stop', event: 'STOP', payload: { containerId: 'cid123' } },
  { name: 'remove', event: 'REMOVE', payload: { containerId: 'cid123', force: true } },
  { name: 'logs', event: 'LOGS', payload: { containerId: 'cid123', tail: 5 } },
  { name: 'status', event: 'STATUS', payload: { containerId: 'cid123' } },
  { name: 'list', event: 'LIST', payload: { all: true } },
  { name: 'stop-nonzero-exit', event: 'STOP', payload: { containerId: 'fail' } },
];

describe.skipIf(KERNEL_DIR === undefined)('std-docker on the Node os host (record/replay parity)', () => {
  let dir = '';
  let program = '';
  let open: KernelProgram | undefined;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'std-docker-')); program = programOnFakeDocker(dir); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => { open?.close(); open = undefined; });

  it.each(OPS)('$name answers as recorded', async ({ name, event, payload }) => {
    if (existsSync(LOG)) rmSync(LOG);
    open = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
    const run = await open.dispatch('DockerOrbital', event, payload);
    const answers = run.emits.filter((emit) => PUBLIC.has(emit.event)).map((emit) => ({ event: emit.event, payload: withoutClock(emit.payload ?? {}) }));
    const argv = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n') : [];
    expect(answers).toHaveLength(1);
    expect(argv.length).toBeGreaterThan(0);
    await expect(JSON.stringify({ answers, argv }, null, 2) + '\n').toMatchFileSnapshot(`./fixtures/std-docker-parity/${name}.json`);
  });
});
