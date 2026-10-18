/** `{name}` references in a field template. */
const REFERENCE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function templateReferences(template: string): string[] {
  return Array.from(template.matchAll(REFERENCE), (m) => m[1]);
}

/** The template with each reference replaced by its field's value; empty when any referenced value is empty. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  if (templateReferences(template).some((name) => (values[name] ?? '') === '')) return '';
  return template.replace(REFERENCE, (_, name: string) => values[name]);
}
