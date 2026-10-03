/**
 * `uses lazy`: the behavior behind a lazy page lives in its own `.orb`, at the
 * page's `orbRef` relative to the importer's `.orb`, and is loaded when the
 * page is opened.
 */

import type { LazyPage, OrbitalSchema } from "@almadar/core";
import type { LoadResult, SchemaLoader } from "./schema-loader.js";

export async function loadLazyPage(
  loader: SchemaLoader,
  page: LazyPage,
  importerPath?: string,
): Promise<LoadResult<OrbitalSchema>> {
  const loaded = await loader.load(page.orbRef, importerPath);
  if (!loaded.success) return loaded;
  const { schema, sourcePath } = loaded.data;
  if (!schema.orbitals.some((o) => o.name === page.orbital)) {
    return {
      success: false,
      error: `Lazy page ${page.path} expects orbital "${page.orbital}" in ${sourcePath}, found: ${schema.orbitals.map((o) => o.name).join(", ")}`,
    };
  }
  return { success: true, data: schema };
}
