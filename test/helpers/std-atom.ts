import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const stdRoot = dirname(createRequire(import.meta.url).resolve('@almadar/std/package.json'));

/** The `.lolo` source of an `@almadar/std` infra atom, read from the installed dependency. */
export function stdInfraAtom(name: string): string {
  return join(stdRoot, 'behaviors', 'lolo', 'infra', 'atoms', `${name}.lolo`);
}
