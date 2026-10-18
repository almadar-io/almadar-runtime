/** The effects the language trio routes to this host. */
export const PROGRAM_EFFECTS = [
  'behavior/catalog',
  'behavior/describe',
  'behavior/source',
  'behavior/resolve',
  'behavior/dependencies',
  'program/read',
  'program/print',
  'program/eval',
  'program/validate',
  'program/compose',
  'program/step',
] as const;
export type ProgramEffectName = (typeof PROGRAM_EFFECTS)[number];

/** Narrow an effect head to one this host runs. */
export function isProgramEffect(name: string): name is ProgramEffectName {
  return (PROGRAM_EFFECTS as readonly string[]).includes(name);
}
