import { assertFolderMatchesName, assertNameIsFree, parsePackageFile, parseReactNativeFile, type Package, type ReactNativeLine } from './compat';

const REACT_NATIVE_FILE = '../../compatibility-data/react-native.json';

const reactNativeModules = import.meta.glob<unknown>('../../compatibility-data/react-native.json', {
  eager: true,
  import: 'default',
});
const packageModules = import.meta.glob<unknown>('../../compatibility-data/**/compatibility.json', {
  eager: true,
  import: 'default',
});

export interface SiteData {
  /** Ascending. */
  reactNative: ReactNativeLine[];
  /** Sorted by name. */
  packages: Package[];
}

/**
 * Top-level outputs of the site itself, which a package page at /<name>/ must not collide with:
 * the files in public/ and the pages in src/pages/ as built. A test compares this list with those
 * folders, so adding a page or a public file without listing it here fails `npm test`.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['404.html', 'index.html', 'favicon.svg', 'badge']);

// Glob keys are relative to this file; show them relative to the repository root in errors.
function displayPath(key: string): string {
  return key.replace(/^(\.\.\/)+/, '');
}

let cached: SiteData | undefined;

export function loadSiteData(): SiteData {
  if (cached) return cached;

  const reactNative = parseReactNativeFile(reactNativeModules[REACT_NATIVE_FILE], displayPath(REACT_NATIVE_FILE));

  const packages = Object.entries(packageModules).map(([key, raw]) => {
    const file = displayPath(key);
    const pkg = parsePackageFile(raw, file, reactNative);
    assertFolderMatchesName(file, pkg);
    assertNameIsFree(file, pkg, RESERVED_NAMES);
    return pkg;
  });

  // Plain code-unit order, so the result does not depend on the build machine's locale.
  cached = { reactNative, packages: packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  return cached;
}
