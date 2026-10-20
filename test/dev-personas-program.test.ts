// std-dev-personas on the JS kernel host against a live Auth emulator (ALMADAR_EMULATOR_LIVE=1): the `personas` and
// `persona-sign-in` hooks list the identity rows and sign one in as a real emulator user whose verified token carries
// its fields as claims. The native twin is the `orb mcp --program` / `orb serve` path over the same atom.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JAVA21_CANDIDATES, findJava21Home, startFirebaseEmulators, type RunningEmulators } from '@almadar/db/emulator';
import { emulatorIdToken, firebaseVerifier } from '@almadar/auth/server';
import { KernelProgram, resolveProgramFile } from '../src/kernel/program-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const fixture = fileURLToPath(new URL('./fixtures/dev-personas/dev-personas.lolo', import.meta.url));
const AUTH_HOST = '127.0.0.1:19097';
const SignedIn = z.object({ success: z.literal(true), customToken: z.string(), authEmulatorHost: z.string(), projectId: z.string() });
const Listed = z.object({ success: z.literal(true), personas: z.array(z.object({ id: z.string() }).passthrough()), source: z.string() });

const rows = [
  { id: 'maya', name: 'Maya', email: 'maya@example.com', role: 'member' },
  { id: 'app-a-heath', email: 'timber@summit.com', role: 'member' },
  { id: 'app-b-heath', email: 'timber@summit.com', role: 'member' },
  { id: 'claimy', role: 'member', sub: 'taken' },
];

async function open(seed: typeof rows): Promise<KernelProgram> {
  return KernelProgram.open(await resolveProgramFile(fixture, process.cwd()), { kernelDir: KERNEL_DIR ?? '', os: true, seed: { User: seed } });
}

async function signIn(program: KernelProgram, id: string): Promise<{ uid: string; claims: Record<string, unknown>; name: string | undefined; email: string | undefined }> {
  const answer = await program.deliverInbound('persona-sign-in', { headers: {}, rawBody: JSON.stringify({ id }) });
  expect(answer.status, answer.body).toBe(200);
  const { customToken } = SignedIn.parse(JSON.parse(answer.body));
  const verified = await firebaseVerifier().verify(await emulatorIdToken(customToken, AUTH_HOST), null);
  return { uid: verified.uid, claims: verified.claims, name: verified.name, email: verified.email };
}

describe.runIf(process.env['ALMADAR_EMULATOR_LIVE'] === '1' && KERNEL_DIR !== undefined)('std-dev-personas (live Auth emulator)', () => {
  let emulators: RunningEmulators | undefined;

  beforeAll(async () => {
    emulators = await startFirebaseEmulators({
      projectId: 'demo-almadar-personas-test',
      dataDir: mkdtempSync(join(tmpdir(), 'personas-emu-')),
      services: ['auth'],
      ports: { firestore: 18087, auth: 19097 },
      firebaseBin: process.env['FIREBASE_TOOLS_BIN'] ?? 'firebase',
      javaHome: findJava21Home(process.env, JAVA21_CANDIDATES),
      env: { ...process.env, NODE_ENV: 'development' },
    });
    Object.assign(process.env, emulators.env);
  }, 180_000);

  afterAll(async () => {
    await emulators?.stop();
  });

  it('lists the identity rows and signs one in whose verified token carries its role and name, not its email', async () => {
    const program = await open(rows);
    try {
      const listed = Listed.parse(JSON.parse((await program.deliverInbound('personas', { headers: {}, rawBody: '{}' })).body));
      expect(listed.personas.map((p) => p.id).sort()).toEqual(rows.map((r) => r.id).sort());
      expect(listed.source).toBe('identity-entity');
      const maya = await signIn(program, 'maya');
      expect(maya).toMatchObject({ uid: 'maya', name: 'Maya' });
      expect(maya.email).toBeUndefined();
      expect(maya.claims['role']).toBe('member');
    } finally {
      program.close();
    }
  }, 60_000);

  it('re-signing the same persona updates its claims instead of failing on the existing uid', async () => {
    const before = await open([{ id: 'sam', role: 'member' }]);
    try {
      expect((await signIn(before, 'sam')).claims['role']).toBe('member');
    } finally {
      before.close();
    }
    const after = await open([{ id: 'sam', role: 'admin' }]);
    try {
      expect((await signIn(after, 'sam')).claims['role']).toBe('admin');
    } finally {
      after.close();
    }
  }, 60_000);

  it('two personas with the same seeded email both sign in (apps share one dev emulator)', async () => {
    const program = await open(rows);
    try {
      expect((await signIn(program, 'app-a-heath')).uid).toBe('app-a-heath');
      expect((await signIn(program, 'app-b-heath')).uid).toBe('app-b-heath');
    } finally {
      program.close();
    }
  }, 60_000);

  it('refuses a persona field named like a reserved claim, an unknown id and a body without an id', async () => {
    const program = await open(rows);
    try {
      const reserved = await program.deliverInbound('persona-sign-in', { headers: {}, rawBody: JSON.stringify({ id: 'claimy' }) });
      expect(reserved.status).toBe(500);
      expect(reserved.body).toContain('reserved token claims: sub');
      expect((await program.deliverInbound('persona-sign-in', { headers: {}, rawBody: JSON.stringify({ id: 'nobody' }) })).status).toBe(404);
      expect((await program.deliverInbound('persona-sign-in', { headers: {}, rawBody: '{}' })).status).toBe(400);
    } finally {
      program.close();
    }
  }, 60_000);

  it('control: with no Auth emulator named, both hooks answer 404 and nothing is listed', async () => {
    const saved = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    const program = await open(rows);
    try {
      expect((await program.deliverInbound('personas', { headers: {}, rawBody: '{}' })).status).toBe(404);
      expect((await program.deliverInbound('persona-sign-in', { headers: {}, rawBody: JSON.stringify({ id: 'maya' }) })).status).toBe(404);
    } finally {
      program.close();
      process.env['FIREBASE_AUTH_EMULATOR_HOST'] = saved;
    }
  }, 60_000);
});
