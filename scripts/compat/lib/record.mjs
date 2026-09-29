// Turns the outcome of one compatibility-check build into a cell and writes it into a package's
// results file, compatibility-data/<package>/compatibility.json, in the shape src/lib/compat.ts
// accepts:
//
//   { "schemaVersion": 2, "package": "<name>", "results": { "<library line>": { "<RN line>": cell } } }
import { compareLines } from './semver.mjs';

export const CHECK_NAMES = ['buildIos', 'buildAndroid', 'tests'];

/**
 * A cell is compatible when both builds passed and the tests passed, or the library has no test
 * suite ("none").
 * @param {{ checks: { buildIos: string, buildAndroid: string, tests: string },
 *   library: string, reactNative: string, testedAt: string, buildUrl?: string }} outcome
 */
export function composeCell({ checks, library, reactNative, testedAt, buildUrl }) {
  for (const name of ['buildIos', 'buildAndroid']) {
    if (checks[name] !== 'passed' && checks[name] !== 'failed') throw new Error(`check ${name} has no result`);
  }
  if (!['passed', 'failed', 'none'].includes(checks.tests)) throw new Error('check tests has no result');
  const compatible = checks.buildIos === 'passed' && checks.buildAndroid === 'passed' && checks.tests !== 'failed';
  // Key order matches the files: status, tested, checks, buildUrl, testedAt.
  return {
    status: compatible ? 'compatible' : 'incompatible',
    tested: { library, reactNative },
    checks: { buildIos: checks.buildIos, buildAndroid: checks.buildAndroid, tests: checks.tests },
    ...(buildUrl ? { buildUrl } : {}),
    testedAt,
  };
}

/** A timestamp in the files' style, whole seconds: 2026-09-06T02:14:09Z. */
export function timestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildUrlFor(appId, buildId) {
  return `https://codemagic.io/app/${encodeURIComponent(appId)}/build/${encodeURIComponent(buildId)}`;
}

/** A results file with nothing in it yet. */
export function emptyResults(name) {
  return { schemaVersion: 2, package: name, results: {} };
}

/**
 * Sets one cell and returns the new file; a package without a results file starts an empty one.
 * A result is applied only when the cell is missing or the result is newer than it, so recording the
 * same builds again changes nothing; `applied` is false then and the file is returned unchanged.
 */
export function applyCell(file, name, { libraryLine, reactNativeLine, cell }) {
  const current = file ?? emptyResults(name);
  const existing = current.results?.[libraryLine]?.[reactNativeLine];
  if (existing && Date.parse(existing.testedAt) >= Date.parse(cell.testedAt)) return { file: current, applied: false };
  const next = structuredClone(current);
  next.results[libraryLine] = { ...next.results[libraryLine], [reactNativeLine]: cell };
  return { file: next, applied: true };
}

/**
 * The file as the watcher writes it: only lines the catalog lists (a retired line is dropped), library
 * lines newest first, React Native lines ascending.
 * @param {string[]} libraryLines  the package's lines in the catalog
 * @param {string[]} reactNativeLines  the catalog's React Native lines
 */
export function tidyResults(file, libraryLines, reactNativeLines) {
  const keepLibrary = new Set(libraryLines);
  const keepReactNative = new Set(reactNativeLines);
  const results = {};
  for (const line of Object.keys(file.results).filter((l) => keepLibrary.has(l)).sort((a, b) => compareLines(b, a))) {
    const row = Object.keys(file.results[line])
      .filter((rn) => keepReactNative.has(rn))
      .sort(compareLines)
      .map((rn) => [rn, file.results[line][rn]]);
    if (row.length > 0) results[line] = Object.fromEntries(row);
  }
  return { schemaVersion: 2, package: file.package, results };
}
