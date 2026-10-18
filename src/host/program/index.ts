/**
 * The host side of the language trio's server effects (`behavior/catalog`,
 * `behavior/describe`, `behavior/source`, `behavior/resolve`, `behavior/dependencies`, `program/read|print|eval`): a thin
 * caller that runs the installed `orb` from the project directory and parses its
 * JSON. All behavior resolution, reflection, printing and validation is `orb`'s;
 * nothing here re-implements it. Both execution paths (the interpreter's effect
 * executor and the compiled server host) call this module.
 *
 * @packageDocumentation
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@almadar/logger';
import { discoverBehaviorPackages } from '@almadar/core/behavior-package';
import {
  CatalogEntrySchema,
  CatalogScopeSchema,
  TraitValueSchema,
  parseProgram,
  TraitDescriptionSchema,
  BehaviorDescriptionSchema,
  DescribeTargetSchema,
  formatTraitValueLiteral,
  defaultPage,
  dependencyGraphOf,
  importsOf,
  type BehaviorTier,
  type DependencyGraph,
  type CircuitStepResult,
  SExprSchema,
  EventPayloadSchema,
  mergeCallSiteConfigOverrides,
  type CatalogEntry,
  type CatalogScope,
  type EvaluatedProgram,
  type JsonValue,
  type OrbitalSchema,
  type ProgramValidationIssue,
  type TraitDescription,
  type BehaviorDescription,
  type DescribeTarget,
  type TraitValue,
  type TraitValueMountResult,
  type BehaviorRef,
  type BehaviorValueMountResult,
} from '@almadar/core';
import {
  atomTraitResolver,
  composeAppFromFiles,
  orbitalImportResolver,
  organismOrderResolver,
  type LayoutStrategy,
} from '@almadar/core/builders';
import type { OrbitalDefinition } from '@almadar/core';
import type { ServiceCallContext } from '../../types.js';
import type { ProgramEffectName } from './effects.js';
import { installedWorkspaceHost, workspaceOwnerSegment } from './workspace-host.js';

export { PROGRAM_EFFECTS, isProgramEffect, type ProgramEffectName } from './effects.js';
export { installWorkspaceHost, uninstallWorkspaceHost, installedWorkspaceHost, workspaceOwnerSegment, type WorkspaceHost, type WorkspacePort } from './workspace-host.js';

const log = createLogger('almadar:integrations:program');

/** Where the host runs `orb`: the project (workspace) root, so installed behavior packages resolve. */
export interface ProgramHostOptions {
  readonly cwd: string;
  /** Explicit `orb` binary; defaults to {@link resolveOrbBinary}. */
  readonly orbBin?: string;
}

const BinPackageSchema = z.object({ bin: z.union([z.string(), z.record(z.string())]).optional() });

/**
 * The installed `orb` binary: `ORBITAL_BIN`, then the local `~/bin/orbital`
 * under `ALMADAR_DEV=1` (the published launcher can lag the subcommand surface),
 * then the `@almadar/orb` npm package's bin, then `orb` on PATH.
 */
export function resolveOrbBinary(): string {
  const override = process.env['ORBITAL_BIN'];
  if (override && existsSync(override)) return override;
  if (process.env['ALMADAR_DEV'] === '1') {
    const local = join(process.env['HOME'] ?? '', 'bin', 'orbital');
    if (existsSync(local)) return local;
  }
  const require = createRequire(import.meta.url);
  let pkgPath: string | undefined;
  try {
    pkgPath = require.resolve('@almadar/orb/package.json');
  } catch {
    pkgPath = undefined;
  }
  if (pkgPath !== undefined) {
    const parsed = BinPackageSchema.safeParse(JSON.parse(readFileSync(pkgPath, 'utf-8')));
    const bin = parsed.success ? (typeof parsed.data.bin === 'string' ? parsed.data.bin : Object.values(parsed.data.bin ?? {})[0]) : undefined;
    if (bin !== undefined) {
      const binPath = resolve(dirname(pkgPath), bin);
      if (existsSync(binPath)) return binPath;
    }
  }
  return 'orb';
}

interface OrbRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function runOrb(args: readonly string[], opts: ProgramHostOptions): Promise<OrbRun> {
  const bin = opts.orbBin ?? resolveOrbBinary();
  return new Promise((done) => {
    execFile(bin, [...args], { cwd: opts.cwd, maxBuffer: 1024 * 1024 * 512 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      if (code !== 0) log.warn('orb exited non-zero', { args: args.join(' '), code, stderr });
      done({ stdout, stderr, code });
    });
  });
}

/** {@link runOrb} for a caller that cannot await (a prompt builder, a module-level allowlist). */
function runOrbSync(args: readonly string[], opts: ProgramHostOptions): OrbRun {
  const bin = opts.orbBin ?? resolveOrbBinary();
  const res = spawnSync(bin, [...args], { cwd: opts.cwd, maxBuffer: 1024 * 1024 * 512, encoding: 'utf-8' });
  const code = res.error !== undefined ? 1 : (res.status ?? 1);
  const stderr = res.error !== undefined ? res.error.message : res.stderr;
  if (code !== 0) log.warn('orb exited non-zero', { args: args.join(' '), code, stderr });
  return { stdout: res.stdout, stderr, code };
}

/** Any schema with zod's `safeParse` — core's schemas come from core's own zod instance. */
interface SafeParser<T> {
  safeParse(value: ReturnType<typeof JSON.parse>): { success: true; data: T } | { success: false; error: { message: string } };
}

/** Core's `parseProgram` (IR, with orbital values standing for their import orbitals) as a {@link SafeParser}. */
const ProgramParser: SafeParser<OrbitalSchema> = {
  safeParse(value) {
    try {
      return { success: true, data: parseProgram(value) };
    } catch (error) {
      return { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  },
};

function parseJson<T>(schema: SafeParser<T>, run: OrbRun, what: string): T {
  if (run.code !== 0) throw new Error(`${what}: orb exited ${run.code}: ${run.stderr.trim()}`);
  const parsed = schema.safeParse(JSON.parse(run.stdout));
  if (!parsed.success) throw new Error(`${what}: unexpected orb output: ${parsed.error.message}`);
  return parsed.data;
}

function withTempFile<T>(name: string, content: string, use: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'almadar-program-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return use(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A one-off file at the project root, so a relative import from it stays inside `orb`'s base path. */
function withProjectFile<T>(cwd: string, name: string, content: string, use: (path: string) => Promise<T>): Promise<T> {
  const path = join(cwd, `.${randomUUID()}-${name}`);
  writeFileSync(path, content);
  return use(path).finally(() => rmSync(path, { force: true }));
}

/** `behavior/catalog`: installed behaviors under registry folders. */
export async function behaviorCatalog(scope: CatalogScope, opts: ProgramHostOptions): Promise<CatalogEntry[]> {
  const exposure = (scope.exposure ?? []).flatMap((e) => ['--exposure', e]);
  const run = await runOrb(['behaviors', 'catalog', '--json', ...scope.paths, ...exposure], opts);
  return parseJson(CatalogEntrySchema.array(), run, 'behavior/catalog');
}

/** {@link behaviorCatalog} for a caller that cannot await. */
export function behaviorCatalogSync(scope: CatalogScope, opts: ProgramHostOptions): CatalogEntry[] {
  const exposure = (scope.exposure ?? []).flatMap((e) => ['--exposure', e]);
  return parseJson(CatalogEntrySchema.array(), runOrbSync(['behaviors', 'catalog', '--json', ...scope.paths, ...exposure], opts), 'behavior/catalog');
}

/** `behavior/describe`: a trait value's knobs and events; an orbital value's or a whole behavior's orbitals. */
export async function behaviorDescribe(value: TraitValue, opts: ProgramHostOptions): Promise<TraitDescription>;
export async function behaviorDescribe(value: DescribeTarget, opts: ProgramHostOptions): Promise<TraitDescription | BehaviorDescription>;
export async function behaviorDescribe(value: DescribeTarget, opts: ProgramHostOptions): Promise<TraitDescription | BehaviorDescription> {
  if ('trait' in value) {
    const run = await runOrb(['behaviors', 'describe', '--json', formatTraitValueLiteral(value)], opts);
    return parseJson(TraitDescriptionSchema, run, 'behavior/describe');
  }
  const spec = 'orbital' in value ? `${value.behavior}.orbitals.${value.orbital}` : value.behavior;
  return parseJson(BehaviorDescriptionSchema, await runOrb(['behaviors', 'describe', '--json', spec], opts), 'behavior/describe');
}

/** `behavior/source`: the behavior a value belongs to, as a program (`.orb` IR). */
export async function behaviorSource(value: Pick<TraitValue, 'behavior'>, opts: ProgramHostOptions): Promise<OrbitalSchema> {
  const run = await runOrb(['behaviors', 'source', '--json', value.behavior], opts);
  return parseJson(ProgramParser, run, 'behavior/source');
}

/** `program/read`: `.lolo` text → a program (`.orb` IR). */
export function programRead(text: string, opts: ProgramHostOptions): Promise<OrbitalSchema> {
  return withTempFile('program.lolo', text, async (path) =>
    parseJson(ProgramParser, await runOrb(['emit', 'orb', path], opts), 'program/read'),
  );
}

/**
 * `program/read` as an effect outcome: text that lowers but is not a program core
 * accepts (an entity with no fields, …) fails with the validator's issues on that
 * text, the same data `program/eval` fails with.
 */
async function programReadOutcome(text: string, opts: ProgramHostOptions): Promise<ProgramEffectOutcome> {
  return withTempFile('program.lolo', text, async (path) => {
    const run = await runOrb(['emit', 'orb', path], opts);
    if (run.code !== 0) return fail(`program/read: orb exited ${run.code}: ${run.stderr.trim()}`);
    const parsed = ProgramParser.safeParse(JSON.parse(run.stdout));
    if (parsed.success) return { ok: true, result: parsed.data };
    const report = parseJson(ValidateReportSchema, await runOrb(['validate', '--json', '--deny-warnings', path], opts), 'program/read');
    const issues = [...(report.errors ?? []), ...(report.warnings ?? [])];
    if (issues.length === 0) return fail(`program/read: not a program: ${parsed.error.message}`);
    return { ok: false, error: `program/read: ${issues.length} validation issue(s): ${issues.map((e) => e.message).join('; ')}`, errors: issues };
  });
}

/** `program/print`: a program (`.orb` IR) → `.lolo` text. */
export function programPrint(program: OrbitalSchema, opts: ProgramHostOptions): Promise<string> {
  return withTempFile('program.orb', JSON.stringify(program), async (path) => {
    const run = await runOrb(['emit', 'lolo', path], opts);
    if (run.code !== 0) throw new Error(`program/print: orb exited ${run.code}: ${run.stderr.trim()}`);
    return run.stdout;
  });
}

const IssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});
const ValidateReportSchema = z.object({
  valid: z.boolean(),
  errors: z.array(IssueSchema).optional(),
  warnings: z.array(IssueSchema).optional(),
});

/** Who runs a program effect: the signed-in caller, as `call-service` receives it. */
export type ProgramCallContext = Pick<ServiceCallContext, 'principal' | 'role'>;

/**
 * A workspace-backed specifier (`./<workspaces root>/<owner>/…`) is readable
 * only by its owner; every other specifier is unaffected. Returns the refusal,
 * or undefined when the caller may read it.
 */
export function workspaceAccessError(behavior: string, opts: ProgramHostOptions, context: ProgramCallContext | undefined): string | undefined {
  const host = installedWorkspaceHost();
  if (host === null || !behavior.startsWith('./')) return undefined;
  const under = relative(host.root, resolve(opts.cwd, behavior));
  if (under.startsWith('..') || isAbsolute(under)) return undefined;
  const owner = under.split(sep)[0];
  if (context?.principal !== undefined && workspaceOwnerSegment(context.principal) === owner) return undefined;
  return `behavior "${behavior}" is in another user's workspace`;
}

/** Options for {@link programEval}. */
export interface ProgramEvalOptions extends ProgramHostOptions {
  /** Write into this workspace (opened as `context`'s caller) and snapshot it; without one, into `<cwd>/orbitals`. */
  readonly workspace?: { readonly id: string; readonly context: ProgramCallContext };
  /** A prior version of the program whose ids the re-evaluation keeps. */
  readonly prior?: OrbitalSchema;
  /** The program is a finished app (a generation concludes here): `orb validate --final`. */
  readonly final?: boolean;
}

export type ProgramEvalResult =
  | { readonly ok: true; readonly result: EvaluatedProgram }
  | { readonly ok: false; readonly errors: readonly ProgramValidationIssue[] };

const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The validator's report on a stamped program, or the reason it could not be validated. */
type StampedValidation =
  | { readonly ok: true; readonly stamped: string; readonly errors: readonly ProgramValidationIssue[]; readonly warnings: readonly ProgramValidationIssue[]; readonly valid: boolean }
  | { readonly ok: false; readonly errors: readonly ProgramValidationIssue[] };

/**
 * The one validation call behind `program/eval` and `program/validate`: stamp ids (keeping
 * `prior`'s) into `dir`, then run `orb validate --json --deny-warnings` (as a finished app when `final`).
 */
async function stampAndValidate(program: OrbitalSchema, opts: Pick<ProgramEvalOptions, 'cwd' | 'prior' | 'final'> & ProgramHostOptions, dir: string, caller: string): Promise<StampedValidation> {
  if (!PROGRAM_NAME.test(program.name)) {
    return { ok: false, errors: [{ code: 'PROGRAM_NAME_INVALID', message: `program name "${program.name}" is not a file name` }] };
  }
  const input = join(dir, `${program.name}.orb`);
  const stamped = join(dir, `${program.name}.stamped.orb`);
  writeFileSync(input, JSON.stringify(program));
  const stampArgs = ['stamp', input, '-o', stamped];
  if (opts.prior !== undefined) {
    const priorPath = join(dir, 'prior.orb');
    writeFileSync(priorPath, JSON.stringify(opts.prior));
    stampArgs.push('--prior', priorPath);
  }
  const stamp = await runOrb(stampArgs, opts);
  if (stamp.code !== 0) {
    return { ok: false, errors: [{ code: 'PROGRAM_STAMP_FAILED', message: stamp.stderr.trim() }] };
  }
  const validateArgs = ['validate', '--json', '--deny-warnings', ...(opts.final === true ? ['--final'] : []), stamped];
  const report = parseJson(ValidateReportSchema, await runOrb(validateArgs, opts), caller);
  const errors = report.errors ?? [];
  const warnings = report.warnings ?? [];
  return { ok: true, stamped, errors, warnings, valid: report.valid && errors.length === 0 && warnings.length === 0 };
}

/** What `program/validate` returns. */
export interface ProgramValidationReport {
  readonly valid: boolean;
  readonly errors: readonly ProgramValidationIssue[];
  readonly warnings: readonly ProgramValidationIssue[];
}

/**
 * `program/validate`: the same stamp-and-validate call as `program/eval`, at the same
 * 0-error / 0-warning bar, in a temp directory that is removed after. Nothing is written
 * to the workspace or the project.
 */
export async function programValidate(program: OrbitalSchema, opts: Pick<ProgramEvalOptions, 'cwd' | 'prior' | 'final'> & ProgramHostOptions): Promise<ProgramValidationReport> {
  const dir = mkdtempSync(join(tmpdir(), 'almadar-validate-'));
  try {
    const run = await stampAndValidate(program, opts, dir, 'program/validate');
    return run.ok ? { valid: run.valid, errors: run.errors, warnings: run.warnings } : { valid: false, errors: run.errors, warnings: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `program/eval`: validate through {@link stampAndValidate}, and on success write the program to `orbitals/<name>.orb` in its workspace (or `cwd`)
 * and return its traits as values. Failures come back as data.
 */
export async function programEval(program: OrbitalSchema, opts: ProgramEvalOptions): Promise<ProgramEvalResult> {
  const dir = mkdtempSync(join(tmpdir(), 'almadar-eval-'));
  try {
    const run = await stampAndValidate(program, opts, dir, 'program/eval');
    if (!run.ok) return { ok: false, errors: run.errors };
    const stamped = run.stamped;
    const issues = [...run.errors, ...run.warnings];
    if (!run.valid || issues.length > 0) return { ok: false, errors: issues };
    const written = ProgramParser.safeParse(JSON.parse(readFileSync(stamped, 'utf-8')));
    if (!written.success) throw new Error(`program/eval: stamped program does not parse: ${written.error.message}`);
    const content = JSON.stringify(written.data, null, 2);
    let behavior: string;
    if (opts.workspace !== undefined) {
      const host = installedWorkspaceHost();
      if (host === null) return { ok: false, errors: [{ code: 'PROGRAM_NO_WORKSPACE_HOST', message: 'no workspace host is installed on this host' }] };
      if (opts.workspace.context.principal === undefined) {
        return { ok: false, errors: [{ code: 'PROGRAM_WORKSPACE_UNAUTHORIZED', message: 'a workspace eval needs a signed-in caller' }] };
      }
      const ws = await host.open(opts.workspace.id, opts.workspace.context);
      const rel = relative(opts.cwd, ws.workDir);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { ok: false, errors: [{ code: 'PROGRAM_WORKSPACE_OUTSIDE_PROJECT', message: `workspace ${ws.workDir} is outside the project ${opts.cwd}` }] };
      }
      await ws.writeFile(`orbitals/${program.name}.orb`, content);
      await ws.snapshot(`program/eval ${program.name}`);
      behavior = `./${rel.split(sep).join('/')}/orbitals/${program.name}`;
    } else {
      const target = join(opts.cwd, 'orbitals');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${program.name}.orb`), content);
      behavior = `./orbitals/${program.name}`;
    }
    const traits = written.data.orbitals.flatMap((orbital) =>
      orbital.traits.flatMap((t) => (typeof t === 'object' && 'name' in t && typeof t.name === 'string' ? [{ behavior, trait: t.name }] : [])),
    );
    return { ok: true, result: { behavior, traits, value: { behavior } } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LAYOUT_STRATEGIES: readonly LayoutStrategy[] = ['sidebar', 'tabs', 'dashboard', 'wizard-flow', 'single'];

/** Options for {@link programCompose}. */
export interface ProgramComposeOptions {
  readonly appName: string;
  readonly layout?: LayoutStrategy;
  /** The app's theme (a built-in theme name), set on the composed program. */
  readonly theme?: string;
}

/** The behavior an import orbital takes its source from (`reference.ref`'s alias through the orbital's `uses`). */
function importSource(orbital: OrbitalDefinition): { from: string; orbital: string } | undefined {
  const ref = orbital.reference?.ref;
  if (ref === undefined) return undefined;
  const [alias, kind, name] = ref.split('.');
  if (kind !== 'orbitals' || name === undefined) return undefined;
  const use = (orbital.uses ?? []).find((u) => u.as === alias);
  return use === undefined ? undefined : { from: use.from, orbital: name };
}

const behaviorName = (from: string): string => from.split('/').pop() ?? from;

/**
 * `program/compose`: assemble programs, in the order given, into one app
 * program — core `composeAppFromFiles` (pages, layout, wiring, the app nav).
 * The composer's registry lookups (an import's source orbital, an atom's trait,
 * an organism's orbital order) are served from `orb behaviors source` for every
 * behavior the programs import, loaded once up front.
 */
export async function programCompose(
  programs: readonly OrbitalSchema[],
  options: ProgramComposeOptions,
  opts: ProgramHostOptions,
): Promise<OrbitalSchema> {
  const sources = new Set<string>();
  for (const program of programs) {
    for (const orbital of program.orbitals) for (const use of orbital.uses ?? []) sources.add(use.from);
  }
  const loaded = new Map<string, OrbitalSchema>();
  for (const from of sources) loaded.set(behaviorName(from), await behaviorSource({ behavior: from }, opts));
  const load = (name: string): OrbitalSchema | null => loaded.get(name) ?? null;

  const byName = new Map<string, OrbitalDefinition>();
  for (const program of programs) for (const orbital of program.orbitals) byName.set(orbital.name, orbital);
  const catalogOrbitalOf = (name: string): { organism: string; orbital: string } | undefined => {
    const orbital = byName.get(name);
    const source = orbital === undefined ? undefined : importSource(orbital);
    return source === undefined ? undefined : { organism: behaviorName(source.from), orbital: source.orbital };
  };

  const composed = composeAppFromFiles(programs, {
    appName: options.appName,
    ...(options.layout !== undefined ? { layoutStrategy: options.layout } : {}),
    organismOf: (name) => catalogOrbitalOf(name)?.organism,
    organismOrderOf: organismOrderResolver(catalogOrbitalOf, load),
    atomTraitOf: atomTraitResolver(load),
    importedOrbitalOf: orbitalImportResolver(load),
  });
  return options.theme !== undefined ? { ...composed.schema, theme: options.theme } : composed.schema;
}

/**
 * Turn a trait value into a program a host can run: a one-orbital wrapper that
 * imports the value's owning orbital with `only { T }` and the value's overrides
 * as `traits { T { … } }` (LOLO §8b), validated at the 0/0 bar (the binding's
 * admission check) and resolved by `orb`. A project-relative behavior
 * (`./orbitals/X`) is imported relatively from a wrapper written at `cwd`, since
 * `orb`'s loader refuses an absolute import.
 */
export async function mountTraitValue(value: TraitValue, opts: ProgramHostOptions, context?: ProgramCallContext): Promise<TraitValueMountResult> {
  const denied = workspaceAccessError(value.behavior, opts, context);
  if (denied !== undefined) return { ok: false, error: denied };
  let source: OrbitalSchema;
  try {
    source = await behaviorSource(value, opts);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const owner = source.orbitals.find((o) =>
    o.traits.some((t) => typeof t === 'object' && !('ref' in t) && t.name === value.trait),
  );
  if (owner === undefined) {
    return { ok: false, error: `behavior "${value.behavior}" declares no inline trait "${value.trait}"` };
  }
  const { behavior, trait, config, ...rest } = value;
  const overrides = config !== undefined ? { ...rest, config: mergeCallSiteConfigOverrides({}, config) } : rest;
  const projectRelative = behavior.startsWith('./');
  const page = (owner.pages ?? []).find((p) => typeof p === 'object' && 'path' in p && (p.traits ?? []).some((t) => (typeof t === 'string' ? t : 'ref' in t ? t.ref : t.name) === trait));
  const wrapper = {
    name: `Mount${trait}`,
    orbitals: [
      {
        name: 'Mounted',
        entity: `Bound.orbitals.${owner.name}.entity`,
        reference: {
          ref: `Bound.orbitals.${owner.name}`,
          only: [trait],
          ...(Object.keys(overrides).length > 0 ? { traits: { [trait]: overrides } } : {}),
        },
        traits: [],
        pages: [],
        uses: [{ as: 'Bound', from: behavior }],
      },
    ],
  };
  const check = async (path: string): Promise<TraitValueMountResult> => {
    const report = parseJson(ValidateReportSchema, await runOrb(['validate', '--json', '--deny-warnings', path], opts), 'mount');
    const issues = [...(report.errors ?? []), ...(report.warnings ?? [])];
    if (!report.valid || issues.length > 0) {
      return { ok: false, error: `trait value ${formatTraitValueLiteral(value)} does not validate where it is bound`, errors: issues };
    }
    const schema = parseJson(ProgramParser, await runOrb(['resolve', path], opts), 'mount');
    const pagePath = page !== undefined && typeof page === 'object' && 'path' in page ? page.path : undefined;
    return { ok: true, mounted: { schema, orbital: 'Mounted', trait: `Mounted${trait}`, ...(pagePath !== undefined ? { pagePath } : {}) } };
  };
  const text = JSON.stringify(wrapper);
  return projectRelative ? withProjectFile(opts.cwd, 'mount.orb', text, check) : withTempFile('mount.orb', text, check);
}

const WHICH_LINE = /^(\/\S+\.(?:orb|lolo)) \((.+)\)$/;

/** The program file a behavior specifier names: workspace-relative under `cwd`, or the installed copy `orb behaviors which` reports (`.lolo` for a live package). */
async function behaviorFile(behavior: string, opts: ProgramHostOptions): Promise<string | { error: string }> {
  if (behavior.startsWith('./')) {
    const path = `${resolve(opts.cwd, behavior)}.orb`;
    return existsSync(path) ? path : { error: `no program at ${behavior}` };
  }
  const run = await runOrb(['behaviors', 'which', behavior], opts);
  const line = run.stdout.trim().split('\n').pop() ?? '';
  const match = WHICH_LINE.exec(line);
  if (run.code !== 0 || match === null) return { error: `behavior "${behavior}" is not installed${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}` };
  return match[1];
}

/**
 * Make a behavior value runnable: the program as written is validated at the
 * 0/0 bar (the embed's admission check) and resolved by `orb`; the frame opens
 * it on its default page (the one marked `initial`, else the first).
 */
export async function mountBehaviorValue(value: BehaviorRef, opts: ProgramHostOptions, context?: ProgramCallContext): Promise<BehaviorValueMountResult> {
  const denied = workspaceAccessError(value.behavior, opts, context);
  if (denied !== undefined) return { ok: false, error: denied };
  const file = await behaviorFile(value.behavior, opts);
  if (typeof file !== 'string') return { ok: false, error: file.error };
  const report = parseJson(ValidateReportSchema, await runOrb(['validate', '--json', '--deny-warnings', file], opts), 'mount');
  const issues = [...(report.errors ?? []), ...(report.warnings ?? [])];
  if (!report.valid || issues.length > 0) {
    return { ok: false, error: `behavior ${value.behavior} does not validate`, errors: issues };
  }
  const schema = parseJson(ProgramParser, await runOrb(['resolve', file], opts), 'mount');
  const firstPage = defaultPage(schema)?.page.path;
  if (firstPage === undefined) return { ok: false, error: `behavior ${value.behavior} has no page to open` };
  return { ok: true, mounted: { schema, firstPage } };
}

/** `behavior/resolve`: the behavior a value belongs to, resolved by `orb` — every import and composed trait inlined, as the runtime runs it. */
export async function behaviorResolve(value: Pick<TraitValue, 'behavior'>, opts: ProgramHostOptions): Promise<OrbitalSchema | { error: string }> {
  const file = await behaviorFile(value.behavior, opts);
  if (typeof file !== 'string') return file;
  return parseJson(ProgramParser, await runOrb(['resolve', file], opts), 'behavior/resolve');
}

/** Each installed behavior by name: its package's tier and prefix, and the UI pattern it is the factory of (the index `orb` derives, with no vectors read). */
function installedBehaviorIndex(opts: ProgramHostOptions): Map<string, { tier: BehaviorTier; prefix: string; pattern?: string }> {
  const out = new Map<string, { tier: BehaviorTier; prefix: string; pattern?: string }>();
  for (const pkg of discoverBehaviorPackages(opts.cwd)) {
    const tier: BehaviorTier = pkg.name === '@almadar/std' ? 'std' : pkg.name === '@almadar-io/behaviors' ? 'io' : 'unknown';
    const catalog = parseJson(CatalogEntrySchema.array(), runOrbSync(['behaviors', 'catalog', '--json', '--no-vectors', pkg.orb.prefix], opts), 'behavior/dependencies');
    for (const entry of catalog) {
      const name = entry.behavior.slice(pkg.orb.prefix.length + 1);
      if (!out.has(name)) out.set(name, { tier, prefix: pkg.orb.prefix, ...(entry.pattern !== undefined ? { pattern: entry.pattern } : {}) });
    }
  }
  return out;
}

/** `behavior/dependencies`: a program's dependency graph — each orbital's imports, then every installed behavior they reach, with its layer and its own imports. */
export async function behaviorDependencies(program: OrbitalSchema, opts: ProgramHostOptions): Promise<DependencyGraph> {
  const index = installedBehaviorIndex(opts);
  const orbs = new Map<string, OrbitalSchema | null>();
  let frontier = [...new Set(importsOf(program, () => 'unknown').map((i) => i.behavior))];
  while (frontier.length > 0) {
    const loaded = await Promise.all(
      frontier.map(async (name): Promise<[string, OrbitalSchema | null]> => {
        const entry = index.get(name);
        return [name, entry ? await behaviorSource({ behavior: `${entry.prefix}/${name}` }, opts) : null];
      }),
    );
    const next = new Set<string>();
    for (const [name, orb] of loaded) {
      orbs.set(name, orb);
      for (const i of orb ? importsOf(orb, () => 'unknown') : []) if (!orbs.has(i.behavior)) next.add(i.behavior);
    }
    frontier = [...next].filter((n) => !orbs.has(n));
  }
  return dependencyGraphOf(program, {
    tierOf: (n) => index.get(n)?.tier ?? 'unknown',
    orbOf: (n) => orbs.get(n) ?? null,
    patternOf: (n) => index.get(n)?.pattern,
  });
}

/** One transition a host asks to play: the trait, the state it plays from, and the event with its payload. */
const StepRequestSchema = z.object({
  orbital: z.string(),
  trait: z.string(),
  from: z.string(),
  event: z.string(),
  payload: EventPayloadSchema,
});
export type StepRequest = z.infer<typeof StepRequestSchema>;

const StepOutcomeSchema = z.object({
  trait: z.string(),
  executed: z.boolean(),
  previousState: z.string(),
  newState: z.string(),
  emits: z.array(z.object({ event: z.string(), payload: EventPayloadSchema.nullable() })),
  firedArm: z.number().int().nullable(),
  guards: z.array(z.object({ arm: z.number().int(), guard: SExprSchema, passed: z.boolean(), error: z.string().optional() })),
  effects: z.array(z.object({ type: z.string(), args: z.array(SExprSchema), status: z.enum(['executed', 'failed', 'skipped']), error: z.string().optional() })),
});
const StepReportSchema = z.union([
  z.object({ success: z.literal(true), steps: z.array(z.object({ outcomes: z.array(StepOutcomeSchema) })) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

/**
 * `program/step`: play each request against the program in one run of `orb`'s kernel, each from
 * its own `from` state, and report the circuit it ran — the arm that fired, every guard tried
 * (the Rust evaluator records no node-by-node trace yet, so `trace` is empty), each authored
 * effect of the fired arm and the events it emitted. Each request comes back played: as asked, with its `result`.
 */
/** A played request: the request as asked, and the circuit it ran. */
export type PlayedStep = StepRequest & { result: CircuitStepResult };

export async function programStep(program: OrbitalSchema, requests: readonly StepRequest[], opts: ProgramHostOptions): Promise<PlayedStep[] | { error: string }> {
  const steps = requests.map((r) => ({ trait: r.trait, event: r.event, payload: r.payload, from: r.from }));
  return withTempFile('program.orb', JSON.stringify(program), async (path) => {
    const run = await runOrb(['execute', path, '--steps', JSON.stringify(steps)], opts);
    const report = parseJson(StepReportSchema, run, 'program/step');
    if (!report.success) return { error: report.error };
    const results: PlayedStep[] = [];
    for (const [i, request] of requests.entries()) {
      const outcome = report.steps[i]?.outcomes.find((o) => o.trait === request.trait);
      if (outcome === undefined) return { error: `trait "${request.trait}" did not run` };
      const firedGuarded = outcome.firedArm !== null && outcome.guards.some((g) => g.arm === outcome.firedArm);
      results.push({ ...request, result: {
        trait: outcome.trait,
        event: request.event,
        transitionFired: outcome.executed,
        guard: firedGuarded ? 'pass' : outcome.firedArm === null && outcome.guards.length > 0 ? 'fail' : 'none',
        ...(outcome.firedArm !== null ? { firedArm: outcome.firedArm } : {}),
        state: { before: outcome.previousState, after: outcome.newState },
        effects: outcome.effects.map((e) => ({ type: e.type, args: e.args, status: e.status, ...(e.error !== undefined ? { error: e.error } : {}) })),
        emitted: outcome.emits.map((e) => ({ type: e.event, ...(e.payload !== null ? { payload: e.payload } : {}), timestamp: i })),
        guards: outcome.guards.map((g) => ({ arm: g.arm, guard: g.guard, passed: g.passed, trace: [], ...(g.error !== undefined ? { error: g.error } : {}) })),
      } });
    }
    return results;
  });
}

/** The outcome of one program effect: the value for `{ result }`, or the failure (`errors` for eval's validator issues). */
export type ProgramEffectOutcome =
  | { readonly ok: true; readonly result: CatalogEntry[] | TraitDescription | BehaviorDescription | OrbitalSchema | string | EvaluatedProgram | ProgramValidationReport | DependencyGraph | PlayedStep[] }
  | { readonly ok: false; readonly error: string; readonly errors?: readonly ProgramValidationIssue[] };

type EffectArg = JsonValue;

function fail(error: string): ProgramEffectOutcome {
  return { ok: false, error };
}

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> }): string {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function programArg(op: string, value: EffectArg): OrbitalSchema | string {
  const parsed = ProgramParser.safeParse(value);
  return parsed.success ? parsed.data : `${op}: not a program: ${parsed.error.message}`;
}

/**
 * Parse one program effect's positional arguments (the trailing emit config
 * already removed) and run it. Both execution paths call this — the
 * interpreter's effect executor and the compiled server handlers — so argument
 * validation has one owner. Failures come back as data, never thrown.
 */
export async function runProgramEffect(op: ProgramEffectName, args: readonly EffectArg[], opts: ProgramHostOptions, context?: ProgramCallContext): Promise<ProgramEffectOutcome> {
  log.debug('effect', { op, args: JSON.stringify(args) });
  try {
    switch (op) {
      case 'behavior/catalog': {
        const scope = CatalogScopeSchema.safeParse(args[0]);
        return scope.success ? { ok: true, result: await behaviorCatalog(scope.data, opts) } : fail(`behavior/catalog: ${issuesOf(scope.error)}`);
      }
      case 'behavior/describe': {
        const value = DescribeTargetSchema.safeParse(args[0]);
        if (!value.success) return fail(`${op}: ${issuesOf(value.error)}`);
        const denied = workspaceAccessError(value.data.behavior, opts, context);
        if (denied !== undefined) return fail(`${op}: ${denied}`);
        return { ok: true, result: await behaviorDescribe(value.data, opts) };
      }
      case 'behavior/source': {
        const value = DescribeTargetSchema.safeParse(args[0]);
        if (!value.success) return fail(`${op}: ${issuesOf(value.error)}`);
        const denied = workspaceAccessError(value.data.behavior, opts, context);
        if (denied !== undefined) return fail(`${op}: ${denied}`);
        return { ok: true, result: await behaviorSource(value.data, opts) };
      }
      case 'behavior/resolve': {
        const value = DescribeTargetSchema.safeParse(args[0]);
        if (!value.success) return fail(`${op}: ${issuesOf(value.error)}`);
        const denied = workspaceAccessError(value.data.behavior, opts, context);
        if (denied !== undefined) return fail(`${op}: ${denied}`);
        const resolved = await behaviorResolve(value.data, opts);
        return 'error' in resolved ? fail(`${op}: ${resolved.error}`) : { ok: true, result: resolved };
      }
      case 'program/step': {
        const program = programArg(op, args[0]);
        if (typeof program === 'string') return fail(program);
        const requests = z.array(StepRequestSchema).safeParse(args[1]);
        if (!requests.success) return fail(`${op}: ${issuesOf(requests.error)}`);
        const played = await programStep(program, requests.data, opts);
        return 'error' in played ? fail(`${op}: ${played.error}`) : { ok: true, result: played };
      }
      case 'behavior/dependencies': {
        const program = programArg(op, args[0]);
        return typeof program === 'string' ? fail(program) : { ok: true, result: await behaviorDependencies(program, opts) };
      }
      case 'program/read':
        return typeof args[0] === 'string' ? await programReadOutcome(args[0], opts) : fail('program/read: expected .lolo text');
      case 'program/print': {
        const program = programArg(op, args[0]);
        return typeof program === 'string' ? fail(program) : { ok: true, result: await programPrint(program, opts) };
      }
      case 'program/compose': {
        if (!Array.isArray(args[0])) return fail('program/compose: expected a list of programs');
        const programs: OrbitalSchema[] = [];
        for (const raw of args[0]) {
          const program = programArg(op, raw);
          if (typeof program === 'string') return fail(program);
          programs.push(program);
        }
        const options = args[1];
        if (options === null || options === undefined || typeof options !== 'object' || Array.isArray(options)) {
          return fail('program/compose: options must be an object with an appName');
        }
        let appName: string | undefined;
        let layout: LayoutStrategy | undefined;
        let theme: string | undefined;
        for (const [key, value] of Object.entries(options)) {
          if (key === 'appName' && typeof value === 'string' && value.length > 0) appName = value;
          // An empty theme is "no theme", so a program can always pass its plan's theme field.
          else if (key === 'theme' && typeof value === 'string') theme = value.length > 0 ? value : undefined;
          else if (key === 'layout') {
            const match = LAYOUT_STRATEGIES.find((l) => l === value);
            if (match === undefined) return fail(`program/compose: layout must be one of ${LAYOUT_STRATEGIES.join(', ')}`);
            layout = match;
          } else return fail(`program/compose: unsupported option "${key}"`);
        }
        if (appName === undefined) return fail('program/compose: options must name the app (appName)');
        return { ok: true, result: await programCompose(programs, { appName, ...(layout !== undefined ? { layout } : {}), ...(theme !== undefined ? { theme } : {}) }, opts) };
      }
      case 'program/validate': {
        const program = programArg(op, args[0]);
        if (typeof program === 'string') return fail(program);
        const options = args[1] ?? {};
        if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail('program/validate: options must be an object');
        let prior: OrbitalSchema | undefined;
        let final: boolean | undefined;
        for (const [key, value] of Object.entries(options)) {
          if (key === 'final') {
            if (typeof value !== 'boolean') return fail('program/validate: final must be a boolean');
            final = value;
          } else if (key === 'prior') {
            const p = programArg('program/validate prior', value);
            if (typeof p === 'string') return fail(p);
            prior = p;
          } else return fail(`program/validate: unsupported option "${key}"`);
        }
        return { ok: true, result: await programValidate(program, { ...opts, ...(prior !== undefined ? { prior } : {}), ...(final !== undefined ? { final } : {}) }) };
      }
      case 'program/eval': {
        const program = programArg(op, args[0]);
        if (typeof program === 'string') return fail(program);
        const options = args[1] ?? {};
        if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail('program/eval: options must be an object');
        let workspace: string | undefined;
        let prior: OrbitalSchema | undefined;
        let final: boolean | undefined;
        for (const [key, value] of Object.entries(options)) {
          if (key === 'workspace') {
            if (typeof value !== 'string' || value === '') return fail('program/eval: workspace must be a non-empty id');
            workspace = value;
          }
          else if (key === 'final') {
            if (typeof value !== 'boolean') return fail('program/eval: final must be a boolean');
            final = value;
          }
          else if (key === 'prior') {
            const p = programArg('program/eval prior', value);
            if (typeof p === 'string') return fail(p);
            prior = p;
          } else return fail(`program/eval: unsupported option "${key}"`);
        }
        const outcome = await programEval(program, { ...opts, ...(workspace !== undefined ? { workspace: { id: workspace, context: context ?? {} } } : {}), ...(prior !== undefined ? { prior } : {}), ...(final !== undefined ? { final } : {}) });
        if (outcome.ok) return { ok: true, result: outcome.result };
        return { ok: false, error: `program/eval: ${outcome.errors.length} validation issue(s): ${outcome.errors.map((e) => e.message).join('; ')}`, errors: outcome.errors };
      }
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
