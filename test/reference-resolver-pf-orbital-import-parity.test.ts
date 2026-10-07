/**
 * Real-organism JS-vs-Rust orbital-import parity (B4-J6).
 *
 * The Stage B parity gate (`reference-resolver-stage-b-fixtures.test.ts`)
 * only ever compared SYNTHETIC fixtures the compiled path wrote for itself
 * — it never exercised a real organism's own imported orbitals through both
 * paths (prevention verdict rung 3: the gate measured what a hand-built
 * fixture wanted, not what a real `.lolo` corpus produces). Project
 * Friday's two orbital-reference-form imports of `std-time-tracking`
 * (`TimesheetOrbital = TimeTracking.orbitals.TimesheetPanelOrbital`,
 * `ApprovalRequestOrbital = TimeTracking.orbitals.ApprovalRequestPanelOrbital`)
 * are the corpus case that surfaced everything this file's `foldCallSiteConfigOntoTrait`,
 * `resolveTraitEntry`'s `embedScope` propagation, and the sibling-pull
 * `consumerDeclaredProvenance` gate exist to fix — this test is the standing
 * regression gate for all three.
 *
 * Regenerates the Rust reference at test time (`orb emit orb` + `orbital
 * resolve`, both under `ALMADAR_DEV`) rather than embedding a frozen
 * snapshot — a stale snapshot would silently stop catching a JS regression
 * the moment the compiled side legitimately changes. Skips (not fails) when
 * the dev binaries aren't on this machine, same convention as
 * `composed-trait-listen-eventid-routing.test.ts`'s real-plugin suite.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryPersistence } from '@almadar/db/mock';
import { runToolLoop } from '@almadar/integrations';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import type { OrbitalSchema, Trait, TraitRef } from '@almadar/core';
import { IO_ROOT, ORB_BIN as ORB_BIN_INSTALLED, PACKAGE_ROOT, STD_ROOT, orbSpawnEnv } from './helpers/behavior-packages.js';

const PF_LOLO = join(IO_ROOT, 'behaviors/lolo/project-friday/organisms/project-friday.lolo');
const ORB_BIN = ORB_BIN_INSTALLED;
const ORBITAL_BIN = ORB_BIN_INSTALLED;

const CLI_ENV = orbSpawnEnv();

function isTrait(t: TraitRef): t is Trait {
  return typeof t === 'object' && 'stateMachine' in t;
}

/** The trait a preprocessed entry registers: inline, or a call-site-configured `{ref, _resolved}` wrapper. */
function registeredTrait(t: TraitRef): Trait | undefined {
  if (isTrait(t)) return t;
  return typeof t === 'object' && '_resolved' in t ? t._resolved : undefined;
}

describe(
  'ReferenceResolver — real-organism JS-vs-Rust orbital-import parity (Project Friday, B4-J6)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-parity-'));
    const pfOrbPath = join(dir, 'pf.orb');
    const pfResolvedPath = join(dir, 'pf-resolved.orb');
    execFileSync(ORB_BIN, ['emit', 'orb', PF_LOLO, '-o', pfOrbPath], { cwd: PACKAGE_ROOT, env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 });
    execFileSync(ORBITAL_BIN, ['resolve', pfOrbPath, '-o', pfResolvedPath], { cwd: PACKAGE_ROOT, env: CLI_ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
    const pfSchema = JSON.parse(readFileSync(pfOrbPath, 'utf-8')) as OrbitalSchema;
    const rustSchema = JSON.parse(readFileSync(pfResolvedPath, 'utf-8')) as OrbitalSchema;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }

    for (const orbitalName of ['TimesheetOrbital', 'ApprovalRequestOrbital'] as const) {
      it(`"${orbitalName}" resolves the same trait SET through both paths (order-independent)`, async () => {
        const result = await preprocessSchema(pfSchema, {
          basePath: IO_ROOT,
          stdLibPath: STD_ROOT,
          allowOutsideBasePath: true,
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const jsOrbital = result.data.schema.orbitals.find((o) => o.name === orbitalName);
        const rustOrbital = rustSchema.orbitals.find((o) => o.name === orbitalName);
        expect(jsOrbital).toBeDefined();
        expect(rustOrbital).toBeDefined();
        if (!jsOrbital || !rustOrbital) return;

        const jsNames = new Set(jsOrbital.traits.map(registeredTrait).filter((t): t is Trait => t !== undefined).map((t) => t.name));
        const rustNames = new Set(rustOrbital.traits.filter(isTrait).map((t) => t.name));
        const jsOnly = [...jsNames].filter((n) => !rustNames.has(n)).sort();
        const rustOnly = [...rustNames].filter((n) => !jsNames.has(n)).sort();

        // Closed (J2, B4-J6): when ONE atom is composed TWICE as separate
        // top-level entries of the SAME imported file (std-approval-request's
        // `InlineBrowseItemBrowse6`/`…10`, both `ref: Dense.traits.
        // BrowseItemBrowse`), their shared sibling (`DataGrid1`/
        // `DenseTableView`/`MasterListView`) now materialises TWICE (once
        // bare, once owner-prefixed) on both paths — `pullSiblingTraits`
        // keys/disambiguates by the IMMEDIATE embedder (`parent`), not just
        // the top-level owner, and drains its worklist FIFO (verified against
        // the compiled path's actual `orbital resolve` output, not just its
        // source). Both sides must now be exactly `[]`.
        expect(jsOnly).toEqual([]);
        expect(rustOnly).toEqual([]);
      });
    }

    it('both AppLayout shells forward the imported app-level appName/navItems knobs (uses { config } override)', async () => {
      const result = await preprocessSchema(pfSchema, {
        basePath: IO_ROOT,
        stdLibPath: STD_ROOT,
        allowOutsideBasePath: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      for (const orbitalName of ['TimesheetOrbital', 'ApprovalRequestOrbital'] as const) {
        const o = result.data.schema.orbitals.find((x) => x.name === orbitalName);
        expect(o).toBeDefined();
        if (!o) continue;
        const appLayout = o.traits.filter(isTrait).find((t) => /AppLayout$/.test(t.name));
        expect(appLayout).toBeDefined();
        if (!appLayout?.config) continue;
        expect(appLayout.config.appName?.default).toBe('Project Friday');
        expect(appLayout.config.appName?.forwardedFrom).toBe('@config.appName');
        const navItems = appLayout.config.navItems?.default;
        const declaredNav = pfSchema.config?.['navItems']?.default;
        expect(Array.isArray(navItems) ? navItems.length : navItems).toBe(Array.isArray(declaredNav) ? declaredNav.length : -1);
        expect(appLayout.config.navItems?.forwardedFrom).toBe('@config.navItems');
      }
    });

    it('creates a task through the approved tools after permitted project/workspace reads', async () => {
      const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
      await runtime.register(rustSchema);
      await runtime.persistence.create('Workspace', { id: 'workspace-tools', name: 'Tool test workspace' });
      await runtime.persistence.create('Project', { id: 'project-tools', name: 'Tool test project', workspaceId: 'workspace-tools' });
      const host = runtime.servicePorts({ orbital: 'AssistantOrbital', trait: 'AssistantOrbitalAssistantLoop' }, { id: 'owner-tools', role: 'owner' });
      const tools = [
        ...['Task', 'Lead', 'TimeEntry', 'Project', 'Workspace', 'KnowledgeEntry'].map((read) => ({ read })),
        ...[
          'TaskOrbital.TaskOrbitalTaskPersistor.DO_CREATE',
          'TaskOrbital.TaskOrbitalTaskPersistor.DO_UPDATE',
          'LeadOrbital.LeadOrbitalDealPersistor.DO_CREATE',
          'LeadOrbital.LeadOrbitalDealPersistor.DO_UPDATE',
        ].map((event) => ({ event })),
      ];
      let turn = 0;
      const client: Parameters<typeof runToolLoop>[0] = {
        async callWithTools(options) {
          expect(options.tools?.map((tool) => tool.function.name).sort()).toEqual([
            ...tools.flatMap((tool) => 'read' in tool ? [`read__${tool.read}`] : [tool.event.split('.').join('__')]),
          ].sort());
          const current = turn++;
          if (current === 1) {
            expect(options.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n'))
              .toContain('project-tools');
          }
          const calls = current === 0
            ? ['read__Project', 'read__Workspace'].map((name) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } }))
            : current === 1 ? [{ id: 'create', type: 'function' as const, function: {
              name: 'TaskOrbital__TaskOrbitalTaskPersistor__DO_CREATE',
              arguments: JSON.stringify({ data: { title: 'Assistant created task', projectId: 'project-tools', workspaceId: 'workspace-tools' } }),
            } }] : undefined;
          return { message: { role: 'assistant', content: calls ? null : 'Created.', ...(calls ? { tool_calls: calls } : {}) }, finishReason: 'stop', usage: null };
        },
      };
      await runToolLoop(client, host, { messages: [{ role: 'user', content: 'Create a task in my project' }], tools }, { provider: 'scripted', model: 'scripted' });
      expect(await runtime.persistence.list('Task')).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Assistant created task', projectId: 'project-tools', workspaceId: 'workspace-tools' }),
      ]));
      await runtime.persistence.create('Task', { id: 'private-task', title: 'Private task', assignee: 'someone-else' });
      const contractor = runtime.servicePorts(host.caller, { id: 'contractor-tools', role: 'external_contractor' });
      expect(await contractor.read('Task')).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'private-task' })]));
    });

    it('preserves the assistant allowlist and resolved input identities on both paths', async () => {
      const result = await preprocessSchema(pfSchema, {
        basePath: IO_ROOT,
        stdLibPath: STD_ROOT,
        allowOutsideBasePath: true,
      });
      expect(result.success, result.success ? undefined : JSON.stringify(result)).toBe(true);
      if (!result.success) return;

      const expected = [
        ...['Task', 'Lead', 'TimeEntry', 'Project', 'Workspace', 'KnowledgeEntry'].map((read) => ({ read })),
        ...[
          'TaskOrbital.TaskOrbitalTaskPersistor.DO_CREATE',
          'TaskOrbital.TaskOrbitalTaskPersistor.DO_UPDATE',
          'LeadOrbital.LeadOrbitalDealPersistor.DO_CREATE',
          'LeadOrbital.LeadOrbitalDealPersistor.DO_UPDATE',
        ].map((event) => ({ event })),
      ];
      for (const schema of [result.data.schema, rustSchema]) {
        const orbital = schema.orbitals.find((entry) => entry.name === 'AssistantOrbital');
        const loop = orbital?.traits.map(registeredTrait)
          .find((trait) => trait?.name === 'AssistantOrbitalAssistantLoop');
        expect(loop?.config?.tools?.default).toEqual(expected);
      }
    });
  },
);
