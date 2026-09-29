import { z } from 'zod';

// A minor line such as "0.87" or "2.1". Patch versions are folded into these. No leading zeros,
// so "0.080" cannot sit beside "0.80" and sort as its equal.
const LINE_KEY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// major.minor.patch with an optional prerelease such as "-rc.3".
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const lineKey = z.string().regex(LINE_KEY, 'must be a minor line such as "0.87"');
// Versions end up in chips and row headers, so a runaway prerelease tag is capped.
const version = z
  .string()
  .max(64, 'must be at most 64 characters')
  .regex(SEMVER, 'must be a version such as "0.87.1" or "0.88.0-rc.3"');
const buildResultSchema = z.enum(['passed', 'failed']);
// "none" means the library has no test suite, so its cells are judged on the builds alone.
const testsResultSchema = z.enum(['passed', 'failed', 'none']);
// Strict objects throughout, so a misspelt key such as "buildURL" fails the build instead of
// being dropped.
const cellResultSchema = z
  .strictObject({
    status: z.enum(['compatible', 'incompatible']),
    tested: z.strictObject({
      library: version,
      reactNative: version,
    }),
    checks: z.strictObject({
      buildIos: buildResultSchema,
      buildAndroid: buildResultSchema,
      tests: testsResultSchema,
    }),
    testedAt: z.iso.datetime(),
    buildUrl: z
      .url({ protocol: /^https$/, hostname: /^codemagic\.io$/, error: 'must be an https://codemagic.io/ link' })
      .optional(),
  })
  .superRefine((result, ctx) => {
    const { buildIos, buildAndroid, tests } = result.checks;
    const works = buildIos === 'passed' && buildAndroid === 'passed' && tests !== 'failed';
    const expected = works ? 'compatible' : 'incompatible';
    if (result.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `is "${result.status}" but the checks say "${expected}"`,
      });
    }
  });

// compatibility-data/<package>/compatibility.json: results only. Outer keys are library lines,
// inner keys React Native lines. What is checked, and on which versions, is in green-packages.toml.
const resultsFileSchema = z.strictObject({
  schemaVersion: z.literal(2),
  package: z.string(),
  results: z.record(lineKey, z.record(lineKey, cellResultSchema)),
});

export type CheckResult = z.infer<typeof testsResultSchema>;
export type CellResult = z.infer<typeof cellResultSchema>;

export interface ReactNativeLine {
  line: string;
  version: string;
  channel: 'stable' | 'rc';
}

export interface LibraryLine {
  line: string;
  version: string;
  results: Map<string, CellResult>;
}

export interface Package {
  name: string;
  repository: string;
  description?: string;
  license?: string;
  /** Newest line first. */
  lines: LibraryLine[];
}

/** A package as green-packages.toml lists it (see scripts/compat/lib/catalog.mjs). */
export interface CatalogEntry {
  name: string;
  repository: string;
  description?: string;
  license?: string;
  /** Newest line first. */
  lines: { line: string; version: string }[];
}

export class DataError extends Error {
  constructor(file: string, problems: string[]) {
    super(`Invalid compatibility data in ${file}\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'DataError';
  }
}

// Keys such as "2.1" contain dots, so render them in brackets: lines["2.1"].results["0.87"].status
function formatPath(path: PropertyKey[]): string {
  return path
    .map((key, index) => {
      if (typeof key === 'string' && /^[A-Za-z_]\w*$/.test(key)) return index === 0 ? key : `.${key}`;
      return `[${JSON.stringify(String(key))}]`;
    })
    .join('');
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap((issue) =>
      // Name each unknown key by its own path rather than its parent's.
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => `${formatPath([...issue.path, key])}: is not a known field`)
        : [`${formatPath(issue.path) || '(root)'}: ${issue.message}`],
    );
    // One field can fail two checks with the same message (a URL's scheme and host, say).
    throw new DataError(file, [...new Set(problems)]);
  }
  return parsed.data;
}

/** Numeric order by major, then minor: "0.99" < "0.100", "9.5" < "10.0". */
export function compareLines(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function belongsToLine(version: string, line: string): boolean {
  return version.startsWith(`${line}.`);
}

/** "compatibility-data/@scope/name/compatibility.json" -> "@scope/name". */
export function folderOf(file: string): string {
  return file.replace(/^compatibility-data\//, '').replace(/\/compatibility\.json$/, '');
}

/** A package with no results file yet: listed, with nothing tested. */
export function packageWithoutResults(entry: CatalogEntry): Package {
  const { lines, ...details } = entry;
  return { ...details, lines: lines.map(({ line, version }) => ({ line, version, results: new Map() })) };
}

/**
 * Validates one results file for a package of the catalog. The file must name that package, and
 * each result's tested versions must be on its lines. Results on a line the catalog does not list
 * (either axis) are valid but not shown; they are dropped the next time a result is written to the file.
 */
export function parseResultsFile(raw: unknown, file: string, entry: CatalogEntry, rnLines: ReactNativeLine[]): Package {
  const data = parseWith(resultsFileSchema, raw, file);
  const problems: string[] = [];
  if (data.package !== entry.name || folderOf(file) !== entry.name) {
    problems.push(`package: "${data.package}" must be the package whose folder the file is in, "${folderOf(file)}"`);
  }
  for (const [line, row] of Object.entries(data.results)) {
    for (const [rn, result] of Object.entries(row)) {
      const at = ['results', line, rn];
      if (!belongsToLine(result.tested.library, line)) {
        problems.push(`${formatPath([...at, 'tested', 'library'])}: "${result.tested.library}" is not a ${line} release`);
      }
      if (!belongsToLine(result.tested.reactNative, rn)) {
        problems.push(`${formatPath([...at, 'tested', 'reactNative'])}: "${result.tested.reactNative}" is not a ${rn} release`);
      }
    }
  }
  if (problems.length > 0) throw new DataError(file, problems);

  const shown = new Set(rnLines.map((rn) => rn.line));
  const pkg = packageWithoutResults(entry);
  for (const libraryLine of pkg.lines) {
    for (const [rn, result] of Object.entries(data.results[libraryLine.line] ?? {})) {
      if (shown.has(rn)) libraryLine.results.set(rn, result);
    }
  }
  return pkg;
}

export type CellKind = 'yes' | 'no' | 'queued';

export function cellResult(pkg: Package, line: string, rn: string): CellResult | undefined {
  return pkg.lines.find((l) => l.line === line)?.results.get(rn);
}

/** A missing cell means the combination has not been tested yet. */
export function cellKind(pkg: Package, line: string, rn: string): CellKind {
  const result = cellResult(pkg, line, rn);
  if (!result) return 'queued';
  return result.status === 'compatible' ? 'yes' : 'no';
}

/** The newest library line that is compatible with the given React Native line. */
export function bestLineFor(pkg: Package, rn: string): LibraryLine | undefined {
  return pkg.lines.find((l) => l.results.get(rn)?.status === 'compatible');
}

/** The newest library line with a result on at least one React Native line. */
export function newestTestedLine(pkg: Package): LibraryLine | undefined {
  return pkg.lines.find((l) => l.results.size > 0);
}

export interface FinderAnswer {
  best: LibraryLine | undefined;
  /** False when no release has a result on this line. */
  tested: boolean;
  /** The big line: "5.10.x", "None yet" or "Not tested yet". */
  headline: string;
  text: string;
}

/**
 * The answer for one React Native line on a package page. "None yet" is for releases that were
 * tested and none works; when no release has a result on this line it says so instead.
 */
export function finderAnswer(pkg: Package, rn: string): FinderAnswer {
  const best = bestLineFor(pkg, rn);
  const tested = best?.results.get(rn)?.tested;
  if (best && tested) {
    return {
      best,
      tested: true,
      headline: `${best.line}.x`,
      text:
        best.results.get(rn)?.checks.tests === 'none'
          ? `Tested ${tested.library} on React Native ${tested.reactNative}. The demo app builds on iOS and Android. The library has no test suite.`
          : `Tested ${tested.library} on React Native ${tested.reactNative}. The demo app builds on iOS and Android and the test suite passes.`,
    };
  }
  if (!pkg.lines.some((l) => l.results.has(rn))) {
    return { best, tested: false, headline: 'Not tested yet', text: `No release has been tested on React Native ${rn} yet.` };
  }
  // Lines newer than the newest one with a result here have not been tried on this version.
  const newer = pkg.lines.slice(0, pkg.lines.findIndex((l) => l.results.has(rn))).map((l) => `${l.line}.x`);
  const untriedNote =
    newer.length === 0
      ? ''
      : ` ${newer.length === 1 ? newer[0] : `${newer.slice(0, -1).join(', ')} and ${newer[newer.length - 1]}`} ${
          newer.length === 1 ? 'has' : 'have'
        } not been tested on it.`;
  // Where every result is for a library without a test suite, "passes its tests" would be untrue.
  const suiteRan = pkg.lines.some((l) => {
    const tests = l.results.get(rn)?.checks.tests;
    return tests !== undefined && tests !== 'none';
  });
  return {
    best,
    tested: true,
    headline: 'None yet',
    text: `No tested release builds${suiteRan ? ' and passes its tests' : ''} on React Native ${rn} yet.${untriedNote}`,
  };
}

/**
 * The React Native line a package page opens on: the newest stable line the package has any
 * result for, so a freshly added line with no runs yet does not open on "None yet". Falls back
 * to the newest stable line when the package has no results on a stable line.
 */
export function defaultReactNativeLine(rnLines: ReactNativeLine[], pkg: Package): ReactNativeLine | undefined {
  const stable = rnLines.filter((rn) => rn.channel === 'stable').sort((a, b) => compareLines(b.line, a.line));
  return stable.find((rn) => pkg.lines.some((l) => l.results.has(rn.line))) ?? stable[0];
}

/**
 * The React Native lines the newest tested library line is compatible with, as contiguous runs in
 * column order: "0.83 to 0.88" or "0.81 to 0.83, 0.86". Empty when there are none. A line with no
 * results yet is skipped, so a fresh release does not hide the one before it.
 */
export function verifiedRange(pkg: Package, rnLines: ReactNativeLine[]): string {
  const newest = newestTestedLine(pkg);
  if (!newest) return '';

  const runs: string[][] = [];
  let current: string[] = [];
  for (const rn of [...rnLines].sort((a, b) => compareLines(a.line, b.line))) {
    if (cellKind(pkg, newest.line, rn.line) === 'yes') {
      current.push(rn.line);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  return runs.map((run) => (run.length === 1 ? run[0] : `${run[0]} to ${run[run.length - 1]}`)).join(', ');
}

export type OverviewCell =
  | { kind: 'latest' | 'older'; line: string }
  | { kind: 'no' }
  | { kind: 'untested' };

/** One cell of the home table: which library line to use on this React Native line, if any. */
export function overviewCell(pkg: Package, rn: string): OverviewCell {
  const best = bestLineFor(pkg, rn);
  if (best) return { kind: best === pkg.lines[0] ? 'latest' : 'older', line: best.line };
  const anyTested = pkg.lines.some((l) => l.results.has(rn));
  return anyTested ? { kind: 'no' } : { kind: 'untested' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-06T02:14:09Z" becomes "6 Sep 2026" (UTC, so the build machine's zone does not matter). */
export function formatTestedDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
