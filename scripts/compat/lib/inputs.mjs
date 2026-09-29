// Inputs of a compatibility-check build. Anyone who can start a build chooses these values, so they
// are checked against fixed patterns and the catalog before anything uses them.
//
// The workflow always checks a cell of the catalog: the package must be enabled and both versions
// must be on lines the catalog lists. Local runs can set COMPAT_RECORD=false (`record` here): nothing
// is sent then, so any exact versions and a disabled package are accepted, which is how draft
// settings are tried. The workflow has no such input.
import { CATALOG_FILE, isPackageName } from './catalog.mjs';
import { isVersion, lineOf, MAX_VERSION_LENGTH } from './semver.mjs';

export { isPackageName };

/**
 * @param {Record<string, string | undefined>} raw  the input values, as strings
 * @param {{ catalog: import('./catalog.mjs').Catalog }} data
 * @returns {{ ok: true, value: { package: string, libraryVersion: string, reactNativeVersion: string,
 *   libraryLine: string, reactNativeLine: string, record: boolean,
 *   settings: import('./catalog.mjs').Settings } } | { ok: false, errors: string[] }}
 */
export function validateCheckInputs(raw, data) {
  const errors = [];
  const name = raw.package ?? '';
  const libraryVersion = raw.libraryVersion ?? '';
  const reactNativeVersion = raw.reactNativeVersion ?? '';
  const recordText = raw.record ?? 'true';

  // Echo values back in errors only once they are known to be short and printable.
  const shown = (value) => (/^[\x20-\x7e]{0,80}$/.test(value) ? JSON.stringify(value) : '(not shown)');

  if (recordText !== 'true' && recordText !== 'false') errors.push(`record ${shown(recordText)} must be true or false`);
  const record = recordText !== 'false';

  let entry;
  if (!isPackageName(name)) {
    errors.push(`package ${shown(name)} is not a valid npm package name`);
  } else {
    entry = data.catalog.packages.find((p) => p.name === name);
    if (!entry) errors.push(`package ${name} is not in ${CATALOG_FILE}`);
    else if (!entry.settings) errors.push(`package ${name} has no settings in ${CATALOG_FILE}, so it cannot be checked`);
    else if (record && !entry.enabled) {
      errors.push(`package ${name} is disabled in ${CATALOG_FILE}; the workflow does not check it (try its settings in a local run with COMPAT_RECORD=false)`);
    }
  }

  const versionError = (label, value) =>
    `${label} ${shown(value)} must be an exact version such as 2.1.3 or 0.88.0-rc.3 (at most ${MAX_VERSION_LENGTH} characters)`;
  if (!isVersion(libraryVersion)) errors.push(versionError('library_version', libraryVersion));
  if (!isVersion(reactNativeVersion)) errors.push(versionError('react_native_version', reactNativeVersion));

  const libraryLine = lineOf(libraryVersion);
  const reactNativeLine = lineOf(reactNativeVersion);
  if (record && entry?.settings && entry.enabled) {
    if (libraryLine && !entry.lines.some((l) => l.line === libraryLine)) {
      errors.push(`library line ${libraryLine} is not in the versions of ${name} in ${CATALOG_FILE}`);
    }
    if (reactNativeLine && !data.catalog.reactNative.some((rn) => rn.line === reactNativeLine)) {
      errors.push(`React Native line ${reactNativeLine} is not in the [react-native] versions of ${CATALOG_FILE}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { package: name, libraryVersion, reactNativeVersion, libraryLine, reactNativeLine, record, settings: entry.settings },
  };
}
