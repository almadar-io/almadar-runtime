// std-infra-projection parity: the live atom, handed the resolved programs @almadar-io/terraform's scripts/record-parity.ts
// projected (frozen beside the recording, recorded.json), answered each option set with the same Terraform main and variables
// text, tier, score and its breakdown, resources, cost per resource and analysis as generateTerraform did. expected.json is the
// atom's own answer once it fixed two defects (authentication from the declared identity entity, not a pattern name; the tier-3
// load-balancer chain, G-TERRAFORM-001); its diff against recorded.json was reviewed to hold only those two.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { EventPayload, JsonValue } from '@almadar/core';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import { stdInfraAtom } from './helpers/std-atom.js';

const atom = stdInfraAtom('std-infra-projection');
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/infra-projection/${name}`, import.meta.url));

interface CostItem { resource: string; monthly: { min: number; max: number }; notes: string }
interface Recorded {
  credentials: { [service: string]: JsonValue };
  cases: Array<{
    program: string;
    label: string;
    options: { provider: string; appName: string; region?: string; overrides?: { tier?: number; database?: string; maxInstances?: number } };
    output: {
      hcl: string;
      variables: string;
      tier: number;
      resources: string[];
      estimatedCost: { monthly: { min: number; max: number }; breakdown: CostItem[] };
      score: { raw: number; tier: number; breakdown: { [key: string]: number } };
      analysis: { [key: string]: JsonValue };
    };
  }>;
}

const recorded: Recorded = JSON.parse(readFileSync(fixture('recorded.json'), 'utf8'));
const expected: Array<{ program: string; label: string; projected: EventPayload }> = JSON.parse(readFileSync(fixture('expected.json'), 'utf8'));

describe.skipIf(KERNEL_DIR === undefined)('std-infra-projection on the kernel (parity with @almadar-io/terraform)', () => {
  it.each(recorded.cases.map((c, i) => ({ ...c, name: `${c.program} ${c.label}`, pinned: expected[i]?.projected })))('$name', async ({ program, options, pinned }) => {
    const open = await KernelProgram.open(await resolveProgramFile(atom, process.cwd()), { kernelDir: KERNEL_DIR ?? '' });
    try {
      const payload: EventPayload = {
        program: readFileSync(fixture(`${program}.orb`), 'utf8'),
        appName: options.appName,
        provider: options.provider,
        credentials: recorded.credentials,
        ...(options.region !== undefined ? { region: options.region } : {}),
        ...(options.overrides?.tier !== undefined ? { tier: options.overrides.tier } : {}),
        ...(options.overrides?.database !== undefined ? { database: options.overrides.database } : {}),
        ...(options.overrides?.maxInstances !== undefined ? { maxInstances: options.overrides.maxInstances } : {}),
      };
      const run = await open.dispatch('InfraProjectionOrbital', 'INFRA_PROJECT', payload);
      const done = run.emits.find((e) => e.event === 'INFRA_PROJECTED')?.payload;
      expect(done, run.error ?? JSON.stringify(run.rejections)).toBeDefined();
      expect(done).toEqual(pinned);
    } finally {
      open.close();
    }
  }, 60_000);

  async function project(program: string, extra: EventPayload = {}): Promise<EventPayload | undefined> {
    const open = await KernelProgram.open(await resolveProgramFile(atom, process.cwd()), { kernelDir: KERNEL_DIR ?? '' });
    try {
      const run = await open.dispatch('InfraProjectionOrbital', 'INFRA_PROJECT', { program, appName: 'probe', provider: 'gcp', credentials: {}, ...extra });
      return run.emits.find((e) => e.event === 'INFRA_PROJECTED')?.payload;
    } finally {
      open.close();
    }
  }
  const tiny = (): string => readFileSync(fixture('tiny.orb'), 'utf8');
  const hcl = (p: EventPayload | undefined): string => (typeof p?.hcl === 'string' ? p.hcl : '');
  const variables = (p: EventPayload | undefined): string => (typeof p?.variables === 'string' ? p.variables : '');

  describe('the defects it fixes', () => {
    it('authentication comes from the identity entity the program declares, not from a pattern name', async () => {
      const program = JSON.parse(tiny());
      program.orbitals[0].entity.identity = true;
      const done = await project(JSON.stringify(program));
      expect(done?.analysis).toMatchObject({ hasAuth: true });
      expect(hcl(done)).toContain('resource "google_identity_platform_config" "auth"');
    });

    it('control: a page rendering a pattern named login-form in a program with no identity entity needs no authentication', async () => {
      const done = await project(tiny());
      expect(done?.analysis).toMatchObject({ hasAuth: false });
      expect(hcl(done)).not.toContain('google_identity_platform_config');
    });

    it('tier 3 serves the app through the load balancer it reserves, behind the Cloud Armor policy (G-TERRAFORM-001)', async () => {
      const text = hcl(await project(tiny(), { tier: 3 }));
      expect(text).toContain('network_endpoint_type = "SERVERLESS"');
      expect(text).toContain('service = google_cloud_run_v2_service.app.name');
      expect(text).toContain('security_policy = google_compute_security_policy.waf.id');
      expect(text).toContain('group = google_compute_region_network_endpoint_group.app.id');
      expect(text).toContain('default_service = google_compute_backend_service.app.id');
      expect(text).toContain('domains = [var.domain]');
      expect(text).toContain('url_map          = google_compute_url_map.app.id');
      expect(text).toContain('target                = google_compute_target_https_proxy.app.id');
      expect(text).toContain('ip_address            = google_compute_global_address.lb_ip.address');
      expect(variables(await project(tiny(), { tier: 3 }))).toContain('variable "domain"');
    });

    it('control: below tier 3 there is no load balancer and no domain to supply', async () => {
      const done = await project(tiny(), { tier: 2 });
      expect(hcl(done)).not.toContain('google_compute_global_address');
      expect(hcl(done)).not.toContain('google_compute_backend_service');
      expect(variables(done)).not.toContain('variable "domain"');
    });
  });
});
