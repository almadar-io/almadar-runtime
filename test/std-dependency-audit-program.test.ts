// std-dependency-audit parity on the Node os host: the live atom, with its root (knob and fs grant) at the fixture projects and
// its PATH at the fake package managers, answers every scenario the way the retired security-audit CLI (archive/tools/almadar-security-audit) did when
// scripts/record-parity.mjs recorded it: the console report and the progress lines byte for byte, the JSON and SARIF reports
// as parsed values (the atom writes compact JSON, owner 2026-10-19), and the exit code. node-pnpm, node-npm-vulns and many were
// then re-recorded from the atom once it fixed the CLI's defects (G-CROSS-267), each diff reviewed to hold only those fixes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const atom = fileURLToPath(new URL('../../almadar-std/behaviors/lolo/infra/atoms/std-dependency-audit.lolo', import.meta.url));
const fixtures = realpathSync(fileURLToPath(new URL('./fixtures/dep-audit', import.meta.url)));
const projects = join(fixtures, 'projects');
const expected = join(fixtures, 'expected');

const SCENARIOS: ReadonlyArray<{ name: string; payload: EventPayload }> = [
  { name: 'node-pnpm', payload: { projects: ['node-pnpm'] } },
  { name: 'node-npm-clean', payload: { projects: ['node-npm-clean'] } },
  { name: 'node-npm-vulns', payload: { projects: ['node-npm-vulns'], failOn: 'low', includeDev: false } },
  { name: 'python-app', payload: { projects: ['python-app'], failOn: 'moderate' } },
  { name: 'many', payload: { projects: ['node-pnpm', 'python-app', 'missing', 'not-a-project'], failOn: 'critical' } },
];

function normalize(text: string): string {
  return text
    .split(projects).join('<projects>')
    .replace(/Scanned: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/, 'Scanned: <time>')
    .replace(/Duration: \d+ms/, 'Duration: <ms>ms')
    .replace(/"timestamp":\d+/, '"timestamp":"<time>"')
    .replace(/"duration":\d+/, '"duration":"<ms>"')
    .replace(/"startTimeUtc":"[^"]+"/, '"startTimeUtc":"<time>"');
}

function parsed(file: string): JsonValue {
  const value: JsonValue = JSON.parse(readFileSync(file, 'utf8'));
  return value;
}

type ReportVulnerability = { id: string; severity: string; score: number; package: string; fixAvailable: boolean };
type Report = { vulnerabilities: ReportVulnerability[]; outdated: JsonValue[] };

function text(payload: EventPayload | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === 'string' ? value : '';
}

describe.skipIf(KERNEL_DIR === undefined)('std-dependency-audit on the Node os host (parity with the TS CLI)', () => {
  let dir = '';
  let program = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'std-dependency-audit-'));
    const source = readFileSync(atom, 'utf8');
    const grant = '"/workspace/**"';
    const root = 'root : string = "/workspace"';
    const env = 'env : Map string string = { PATH: "/usr/local/bin:/usr/bin:/bin" }';
    for (const needle of [grant, root, env]) if (!source.includes(needle)) throw new Error(`std-dependency-audit no longer declares ${needle}`);
    program = join(dir, 'std-dependency-audit.lolo');
    writeFileSync(program, source
      .replace(grant, JSON.stringify(`${projects}/**`))
      .replace(root, `root : string = ${JSON.stringify(projects)}`)
      .replace(env, `env : Map string string = { PATH: ${JSON.stringify(`${join(fixtures, 'bin')}:${join(fixtures, 'bin-node')}:/usr/bin:/bin`)} }`));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  async function audit(payload: EventPayload): Promise<EventPayload | undefined> {
    const open = await KernelProgram.open(await resolveProgramFile(program, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true });
    try {
      const run = await open.dispatch('DependencyAuditOrbital', 'AUDIT', payload);
      const done = run.emits.find((emit) => emit.event === 'AUDIT_DONE')?.payload;
      expect(done, run.error ?? 'AUDIT_DONE').toBeDefined();
      return done;
    } finally {
      open.close();
    }
  }

  function report(done: EventPayload | undefined): Report {
    const value: Report = JSON.parse(text(done, 'json'));
    return value;
  }

  it.each(SCENARIOS)('$name answers as the CLI did', async ({ name, payload }) => {
    const done = await audit(payload);
    expect(normalize(text(done, 'console'))).toBe(readFileSync(join(expected, `${name}.console.txt`), 'utf8'));
    expect(JSON.parse(normalize(text(done, 'json')))).toEqual(parsed(join(expected, `${name}.json.txt`)));
    expect(JSON.parse(normalize(text(done, 'sarif')))).toEqual(parsed(join(expected, `${name}.sarif.txt`)));
    expect(done?.exitCode).toBe(Number(readFileSync(join(expected, `${name}.exit`), 'utf8').trim()));
    const log = Array.isArray(done?.log) ? done.log.filter((line): line is string => typeof line === 'string') : [];
    expect(normalize(log.join('\n')) + '\n').toBe(readFileSync(join(expected, `${name}.log.txt`), 'utf8'));
  });

  describe('the CLI defects it fixes (G-CROSS-267)', () => {
    it.each([
      { failOn: 'critical', exitCode: 1 },
      { failOn: 'high', exitCode: 1 },
      { failOn: 'moderate', exitCode: 1 },
      { failOn: 'low', exitCode: 1 },
      { failOn: 'never', exitCode: 0 },
    ])('a critical finding fails a run whose failOn is $failOn with $exitCode', async ({ failOn, exitCode }) => {
      const done = await audit({ projects: ['node-critical-only'], failOn });
      expect(done?.exitCode).toBe(exitCode);
    });

    it.each([
      { failOn: 'critical', exitCode: 0 },
      { failOn: 'high', exitCode: 0 },
      { failOn: 'moderate', exitCode: 0 },
      { failOn: 'low', exitCode: 1 },
    ])('a low finding (and an info one) fails only a run whose failOn reaches low: $failOn gives $exitCode', async ({ failOn, exitCode }) => {
      const done = await audit({ projects: ['node-npm-vulns'], failOn });
      expect(done?.exitCode).toBe(exitCode);
    });

    it('reads npm 7+ audit output: one finding per advisory, none for a package that is only vulnerable through another', async () => {
      const done = await audit({ projects: ['node-npm7'] });
      expect(report(done).vulnerabilities).toEqual([{
        id: 'GHSA-xvch-5gv4-984h', title: 'Prototype Pollution in minimist', description: '', severity: 'critical', score: 9.8,
        package: 'minimist', affectedVersions: '<0.2.4', ghsa: 'GHSA-xvch-5gv4-984h', cwe: 'CWE-1321',
        references: ['https://github.com/advisories/GHSA-xvch-5gv4-984h'], exploitAvailable: true, fixAvailable: true,
        dependencyPath: ['minimist'], ecosystem: 'node',
      }]);
    });

    it('npm 7+: a package vulnerable itself and through another lists its own advisory once (a mixed via, G-CROSS-270)', async () => {
      const done = await audit({ projects: ['node-npm-mixed'] });
      expect(report(done).vulnerabilities.map((v) => ({ id: v.id, package: v.package, severity: v.severity }))).toEqual([
        { id: 'GHSA-aaaa-bbbb-cccc', package: 'mkdirp', severity: 'high' },
        { id: 'GHSA-xvch-5gv4-984h', package: 'minimist', severity: 'critical' },
      ]);
    });

    it('npm 7+: an advisory with no CVSS score takes its severity\'s score and a package with no fix says so', async () => {
      const done = await audit({ projects: ['node-npm-vulns'] });
      const found = report(done).vulnerabilities.map((v) => ({ id: v.id, severity: v.severity, score: v.score, fixAvailable: v.fixAvailable }));
      expect(found).toEqual([
        { id: 'GHSA-vh95-rmgr-6w4m', severity: 'low', score: 2, fixAvailable: true },
        { id: 'GHSA-r628-mhmh-qjhw', severity: 'info', score: 5, fixAvailable: false },
      ]);
    });

    it('keeps the outdated packages npm reports with exit 1', async () => {
      const done = await audit({ projects: ['node-npm7'] });
      expect(report(done).outdated).toEqual([{ package: 'chalk', current: '4.1.2', latest: '5.3.0', wanted: '4.1.2', ecosystem: 'node', isDevDependency: true }]);
    });

    it('control: includeDev false still drops a development dependency reported with exit 1', async () => {
      const done = await audit({ projects: ['node-npm7'], includeDev: false });
      expect(report(done).outdated).toEqual([]);
    });

    it('keeps the vulnerabilities safety reports with exit 64', async () => {
      const done = await audit({ projects: ['python-safety-64'], failOn: 'high' });
      expect(report(done).vulnerabilities.map((v) => ({ id: v.id, severity: v.severity, package: v.package }))).toEqual([{ id: '51668', severity: 'high', package: 'requests' }]);
      expect(done?.exitCode).toBe(1);
    });

    it('control: safety exit 0 still reports what it printed', async () => {
      const done = await audit({ projects: ['python-app'] });
      expect(report(done).vulnerabilities.map((v) => v.package)).toEqual(['requests', 'flask']);
    });
  });
});
