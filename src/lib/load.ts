import { parse as parseToml } from 'smol-toml';
import catalogText from '../../green-packages.toml?raw';
import { CATALOG_FILE, parseCatalog } from '../../scripts/compat/lib/catalog.mjs';
import {
  DataError,
  folderOf,
  packageWithoutResults,
  parseResultsFile,
  type Package,
  type ReactNativeLine,
} from './compat';

export { RESERVED_NAMES } from '../../scripts/compat/lib/catalog.mjs';

const resultModules = import.meta.glob<unknown>('../../compatibility-data/**/compatibility.json', {
  eager: true,
  import: 'default',
});

export interface SiteData {
  /** Ascending. */
  reactNative: ReactNativeLine[];
  /** Sorted by name. */
  packages: Package[];
}

// Glob keys are relative to this file; show them relative to the repository root in errors.
function displayPath(key: string): string {
  return key.replace(/^(\.\.\/)+/, '');
}

let cached: SiteData | undefined;

/** Every package in green-packages.toml, with the results in compatibility-data/ where there are any. */
export function loadSiteData(): SiteData {
  if (cached) return cached;

  let raw: unknown;
  try {
    raw = parseToml(catalogText);
  } catch (error) {
    const line = (error as { line?: number }).line;
    throw new DataError(line ? `${CATALOG_FILE}:${line}` : CATALOG_FILE, [String((error as Error).message).split('\n')[0] ?? '']);
  }
  const catalog = parseCatalog(raw, CATALOG_FILE);
  if (!catalog.ok) throw new DataError(CATALOG_FILE, catalog.errors);
  const { reactNative, packages: entries } = catalog.value;

  const results = new Map<string, { file: string; raw: unknown }>();
  for (const [key, value] of Object.entries(resultModules)) {
    const file = displayPath(key);
    const name = folderOf(file);
    if (!entries.some((entry) => entry.name === name)) {
      throw new DataError(file, [`"${name}" is not a package in ${CATALOG_FILE}`]);
    }
    results.set(name, { file, raw: value });
  }

  const packages = entries.map((entry) => {
    const found = results.get(entry.name);
    return found ? parseResultsFile(found.raw, found.file, entry, reactNative) : packageWithoutResults(entry);
  });

  cached = { reactNative, packages };
  return cached;
}
