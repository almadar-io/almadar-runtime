/** A mount seed's lifecycle dispatch threw: names that trait and event, the original error's message kept. */
export class TraitMountError extends Error {
  readonly trait: string;
  readonly event: string;
  readonly original: Error;

  constructor(trait: string, event: string, original: Error) {
    super(original.message);
    this.name = 'TraitMountError';
    this.trait = trait;
    this.event = event;
    this.original = original;
  }
}
