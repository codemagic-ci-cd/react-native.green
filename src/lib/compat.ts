import { z } from 'zod';

// A minor line such as "0.87" or "2.1". Patch versions are folded into these. No leading zeros,
// so "0.080" cannot sit beside "0.80" and sort as its equal.
const LINE_KEY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// major.minor.patch with an optional prerelease such as "-rc.3".
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
// npm's rules for package names: lowercase, URL-safe, optionally scoped, at most 214 characters.
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const lineKey = z.string().regex(LINE_KEY, 'must be a minor line such as "0.87"');
// Versions end up in chips and row headers, so a runaway prerelease tag is capped.
const version = z
  .string()
  .max(64, 'must be at most 64 characters')
  .regex(SEMVER, 'must be a version such as "0.87.1" or "0.88.0-rc.3"');
const checkResultSchema = z.enum(['passed', 'failed']);
const notEmpty = (record: object) => Object.keys(record).length > 0;

// Strict objects throughout, so a misspelt key such as "buildURL" fails the build instead of
// being dropped.
const reactNativeFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lines: z
    .record(
      lineKey,
      z.strictObject({
        version,
        channel: z.enum(['stable', 'rc']),
      }),
    )
    .refine(notEmpty, 'must list at least one line'),
});

const cellResultSchema = z
  .strictObject({
    status: z.enum(['compatible', 'incompatible']),
    tested: z.strictObject({
      library: version,
      reactNative: version,
    }),
    checks: z.strictObject({
      buildIos: checkResultSchema,
      buildAndroid: checkResultSchema,
      tests: checkResultSchema,
    }),
    testedAt: z.iso.datetime(),
    buildUrl: z
      .url({ protocol: /^https$/, hostname: /^codemagic\.io$/, error: 'must be an https://codemagic.io/ link' })
      .optional(),
  })
  .superRefine((result, ctx) => {
    const allPassed = Object.values(result.checks).every((check) => check === 'passed');
    const expected = allPassed ? 'compatible' : 'incompatible';
    if (result.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `is "${result.status}" but the checks say "${expected}"`,
      });
    }
  });

const packageFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mock: z.boolean().optional(),
  package: z.strictObject({
    name: z
      .string()
      .max(214, 'must be at most 214 characters')
      .regex(PACKAGE_NAME, 'must be a valid npm package name')
      // "npm install -rf@1.3" would be read as an option, not a package.
      .refine((name) => !name.startsWith('-'), 'must not start with a hyphen'),
    repository: z.url({ protocol: /^https$/, error: 'must be an https:// link' }),
    description: z.string().optional(),
    license: z.string().optional(),
  }),
  lines: z
    .record(
      lineKey,
      z.strictObject({
        version,
        results: z.record(lineKey, cellResultSchema),
      }),
    )
    .refine(notEmpty, 'must list at least one line'),
});

export type CheckResult = z.infer<typeof checkResultSchema>;
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
  mock: boolean;
  /** Newest line first. */
  lines: LibraryLine[];
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

/** Returns the React Native lines in ascending order. */
export function parseReactNativeFile(raw: unknown, file: string): ReactNativeLine[] {
  const data = parseWith(reactNativeFileSchema, raw, file);
  const problems: string[] = [];
  for (const [line, info] of Object.entries(data.lines)) {
    if (!belongsToLine(info.version, line)) {
      problems.push(`${formatPath(['lines', line, 'version'])}: "${info.version}" is not a ${line} release`);
    }
  }
  if (problems.length > 0) throw new DataError(file, problems);

  return Object.entries(data.lines)
    .map(([line, info]) => ({ line, version: info.version, channel: info.channel }))
    .sort((a, b) => compareLines(a.line, b.line));
}

/** Validates one compatibility.json against the known React Native lines. */
export function parsePackageFile(raw: unknown, file: string, rnLines: ReactNativeLine[]): Package {
  const data = parseWith(packageFileSchema, raw, file);
  const knownRn = new Set(rnLines.map((rn) => rn.line));
  const problems: string[] = [];

  for (const [line, info] of Object.entries(data.lines)) {
    if (!belongsToLine(info.version, line)) {
      problems.push(`${formatPath(['lines', line, 'version'])}: "${info.version}" is not a ${line} release`);
    }
    for (const [rn, result] of Object.entries(info.results)) {
      const at = ['lines', line, 'results', rn];
      if (!knownRn.has(rn)) {
        problems.push(`${formatPath(at)}: React Native ${rn} is not listed in react-native.json`);
      }
      if (!belongsToLine(result.tested.library, line)) {
        problems.push(
          `${formatPath([...at, 'tested', 'library'])}: "${result.tested.library}" is not a ${line} release`,
        );
      }
      if (!belongsToLine(result.tested.reactNative, rn)) {
        problems.push(
          `${formatPath([...at, 'tested', 'reactNative'])}: "${result.tested.reactNative}" is not a ${rn} release`,
        );
      }
    }
  }
  if (problems.length > 0) throw new DataError(file, problems);

  const lines = Object.entries(data.lines)
    .map(([line, info]) => ({ line, version: info.version, results: new Map(Object.entries(info.results)) }))
    .sort((a, b) => compareLines(b.line, a.line));

  return {
    ...data.package,
    mock: data.mock ?? false,
    lines,
  };
}

/**
 * The folder a compatibility.json sits in is its page's route, so it must equal the package name.
 * `file` is repository-relative, e.g. "compatibility-data/@scope/name/compatibility.json".
 */
/**
 * A package page is written to /<name>/, so a name equal to another top-level output ("404.html",
 * "favicon.svg", "badge", ...) would overwrite it or crash the build. `reserved` is
 * RESERVED_NAMES in load.ts.
 */
export function assertNameIsFree(file: string, pkg: Package, reserved: ReadonlySet<string>): void {
  if (reserved.has(pkg.name)) {
    throw new DataError(file, [`package.name: "${pkg.name}" is taken by a page or file of the site itself`]);
  }
}

export function assertFolderMatchesName(file: string, pkg: Package): void {
  const folder = file.replace(/^compatibility-data\//, '').replace(/\/compatibility\.json$/, '');
  if (folder !== pkg.name) {
    throw new DataError(file, [`package.name: "${pkg.name}" does not match its folder "${folder}"`]);
  }
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
 * The React Native lines the newest library line is compatible with, as contiguous runs in
 * column order: "0.83 to 0.88" or "0.81 to 0.83, 0.86". Empty when there are none.
 */
export function verifiedRange(pkg: Package, rnLines: ReactNativeLine[]): string {
  const newest = pkg.lines[0];
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
