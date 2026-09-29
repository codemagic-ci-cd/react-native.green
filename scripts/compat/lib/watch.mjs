// The decisions behind watch-releases: which versions the catalog should list and which cells to
// (re)test. Pure: npm data comes in as { versions: string[], distTags: { [tag]: version } }, and
// version lists are the catalog's `versions` arrays, newest first.
import { compareLines, isReleaseCandidate, isStable, lineOf, newestOnLine } from './semver.mjs';

const newestFirst = (versions) => [...versions].sort((a, b) => compareLines(lineOf(b), lineOf(a)));

/** Newest stable patch of a line, else its newest release candidate, else null. */
function newestReactNative(versions, line) {
  return newestOnLine(versions, line, isStable) ?? newestOnLine(versions, line, isReleaseCandidate);
}

/**
 * React Native: each listed line moves to its newest stable patch, or its newest release candidate
 * while it has no stable release. A line newer than every listed one is added when npm's `latest` or
 * `next` tag points at it. Versions are never removed.
 * @returns {{ versions: string[], changes: string[] }}
 */
export function refreshReactNative(versions, npm) {
  const changes = [];
  const next = versions.map((current) => {
    const newest = newestReactNative(npm.versions, lineOf(current));
    if (newest && newest !== current) {
      changes.push(`react-native ${lineOf(current)}: ${current} -> ${newest}`);
      return newest;
    }
    return current;
  });

  const newestListed = versions.map(lineOf).sort(compareLines).at(-1);
  for (const tag of ['latest', 'next']) {
    const line = lineOf(npm.distTags?.[tag] ?? '');
    if (!line || next.some((v) => lineOf(v) === line) || (newestListed && compareLines(line, newestListed) <= 0)) continue;
    const version = newestReactNative(npm.versions, line);
    if (!version) continue;
    next.push(version);
    changes.push(`react-native ${line}: new line at ${version}, from the "${tag}" tag`);
  }
  return { versions: newestFirst(next), changes };
}

/**
 * A package: each listed line moves to its newest stable patch; a newer line is added when npm's
 * `latest` tag points at it. Prereleases are ignored; versions are never removed.
 * @returns {{ versions: string[], changes: string[] }}
 */
export function refreshPackage(name, versions, npm) {
  const changes = [];
  const next = versions.map((current) => {
    const newest = newestOnLine(npm.versions, lineOf(current), isStable);
    if (newest && newest !== current) {
      changes.push(`${name} ${lineOf(current)}: ${current} -> ${newest}`);
      return newest;
    }
    return current;
  });

  const latest = npm.distTags?.latest;
  const latestLine = isStable(latest ?? '') ? lineOf(latest) : null;
  const newestListed = versions.map(lineOf).sort(compareLines).at(-1);
  if (latestLine && !next.some((v) => lineOf(v) === latestLine) && (!newestListed || compareLines(latestLine, newestListed) > 0)) {
    const version = newestOnLine(npm.versions, latestLine, isStable);
    next.push(version);
    changes.push(`${name} ${latestLine}: new line at ${version}`);
  }
  return { versions: newestFirst(next), changes };
}

/**
 * Cells that need a build: every pair of the package's catalog versions and the catalog's React
 * Native versions whose result is missing or was tested on other versions.
 * @param {import('./catalog.mjs').CatalogPackage} pkg
 * @param {import('./catalog.mjs').CatalogReactNative[]} reactNative
 * @param {object | undefined} resultsFile
 */
export function staleCells(pkg, reactNative, resultsFile) {
  const cells = [];
  for (const library of pkg.lines) {
    for (const rn of reactNative) {
      const cell = resultsFile?.results?.[library.line]?.[rn.line];
      const stale = !cell || cell.tested.library !== library.version || cell.tested.reactNative !== rn.version;
      if (!stale) continue;
      cells.push({
        package: pkg.name,
        libraryLine: library.line,
        libraryVersion: library.version,
        reactNativeLine: rn.line,
        reactNativeVersion: rn.version,
        reason: !cell ? 'not tested' : 'newer patch',
      });
    }
  }
  return cells;
}

/** Newest React Native line first, then newest library line; the first `max` are started now. */
export function orderAndCut(cells, max) {
  const ordered = [...cells].sort(
    (a, b) =>
      compareLines(b.reactNativeLine, a.reactNativeLine) ||
      compareLines(b.libraryLine, a.libraryLine) ||
      (a.package < b.package ? -1 : a.package > b.package ? 1 : 0),
  );
  const limit = Math.max(0, Math.floor(max));
  return { start: ordered.slice(0, limit), later: ordered.slice(limit) };
}

/**
 * Body of POST /api/v3/apps/{app_id}/builds for one cell. `node` is the package's setup.node from the
 * catalog; `xcodeByLine` maps React Native lines to an Xcode version (xcode-versions.json).
 */
export function buildRequest(cell, { branch, xcodeByLine = {}, node }) {
  const xcode = xcodeByLine[cell.reactNativeLine];
  const softwareVersions = { ...(xcode ? { xcode } : {}), ...(node ? { node } : {}) };
  return {
    workflow_id: 'compatibility-check',
    branch,
    inputs: {
      package: cell.package,
      library_version: cell.libraryVersion,
      react_native_version: cell.reactNativeVersion,
      record: true,
    },
    labels: [cell.package, `library ${cell.libraryVersion}`, `react-native ${cell.reactNativeVersion}`],
    ...(Object.keys(softwareVersions).length > 0 ? { environment: { software_versions: softwareVersions } } : {}),
  };
}
