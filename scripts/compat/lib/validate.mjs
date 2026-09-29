// Validates the data with the site's own rules, so nothing the site would refuse to build can reach
// the branch: the catalog with scripts/compat/lib/catalog.mjs, and each results file with
// src/lib/compat.ts. Under Node 22 the calling process must run with --experimental-strip-types to
// load the TypeScript module.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CATALOG_FILE, parseCatalogText } from './catalog.mjs';
import { DATA_DIR, readJson, REPO_ROOT } from './config.mjs';

async function siteRules() {
  return import(new URL('../../../src/lib/compat.ts', import.meta.url).href);
}

/**
 * @param {{ catalogText: string, results: Array<{ file: string, data: object }> }} data
 *   `file` is repository-relative, e.g. "compatibility-data/example/compatibility.json"
 * @throws naming the file and field, when anything is invalid
 */
export async function validateData({ catalogText, results }) {
  const catalog = parseCatalogText(catalogText, CATALOG_FILE);
  if (!catalog.ok) throw new Error(`Invalid data in ${CATALOG_FILE}\n${catalog.errors.map((e) => `  - ${e}`).join('\n')}`);
  const compat = await siteRules();
  for (const { file, data } of results) {
    const name = compat.folderOf(file);
    const entry = catalog.value.packages.find((p) => p.name === name);
    if (!entry) throw new compat.DataError(file, [`"${name}" is not a package in ${CATALOG_FILE}`]);
    compat.parseResultsFile(data, file, entry, catalog.value.reactNative);
  }
}

/** Every results file under compatibility-data/, as { file, data }. */
export function readResultsFiles(repoRoot = REPO_ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'compatibility.json') found.push({ file: relative(repoRoot, path), data: readJson(path) });
    }
  };
  walk(join(repoRoot, DATA_DIR));
  return found;
}
