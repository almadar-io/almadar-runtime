/**
 * Program host handlers — server-side only.
 *
 * Backs the language trio's effects (behavior/catalog|describe|source,
 * program/read|print|eval) with the one host implementation in
 * `@almadar/integrations/program`, which runs the installed `orb` from the
 * project directory. Wired by OrbitalServerRuntime alongside createOsHandlers
 * (lazy import, merged under user handlers).
 *
 * NOT exported from the main index.ts because it spawns processes.
 *
 * @packageDocumentation
 */

import { runProgramEffect } from '@almadar/integrations/program';
import type { EffectHandlers } from '../types.js';

export interface ProgramHostConfig {
    /** Project root `orb` resolves behavior packages from. */
    cwd: string;
    /** Explicit `orb` binary; defaults to the host's resolution order. */
    orbBin?: string;
}

export type ProgramHandlers = Pick<EffectHandlers, 'programEffect'>;

export function createProgramHandlers(host: ProgramHostConfig): ProgramHandlers {
    const opts = host.orbBin === undefined ? { cwd: host.cwd } : { cwd: host.cwd, orbBin: host.orbBin };
    return { programEffect: (op, args, context) => runProgramEffect(op, args, opts, context) };
}
