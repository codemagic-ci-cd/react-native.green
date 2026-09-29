// The small part of semver these scripts need: exact versions only, no ranges.

// major.minor.patch with an optional prerelease such as "-rc.3". The same shape the site accepts.
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const MAX_VERSION_LENGTH = 64;

/** @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | null} */
export function parseVersion(version) {
  if (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function isVersion(version) {
  return parseVersion(version) !== null;
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: 0.88.0-rc.2 < 0.88.0-rc.10 < 0.88.0. Invalid versions sort first. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return core;
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return y.prerelease.length - x.prerelease.length;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i += 1) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    const order = compareIdentifiers(x.prerelease[i], y.prerelease[i]);
    if (order !== 0) return order;
  }
  return 0;
}

/** "0.88.0-rc.3" and "0.88.1" are both on line "0.88". */
export function lineOf(version) {
  const parsed = parseVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}` : null;
}

/** Numeric order of minor lines: "0.99" < "0.100". */
export function compareLines(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function isStable(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease.length === 0;
}

/** Only "-rc.N" counts; nightlies and other prereleases are never tracked. */
export function isReleaseCandidate(version) {
  return isVersion(version) && /-rc\.\d+$/.test(version);
}

/** The highest of `versions` on `line` that passes `accept`, or null. */
export function newestOnLine(versions, line, accept = () => true) {
  return (
    versions
      .filter((v) => lineOf(v) === line && accept(v))
      .sort(compareVersions)
      .at(-1) ?? null
  );
}
