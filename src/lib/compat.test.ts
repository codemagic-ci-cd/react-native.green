import { describe, expect, it } from 'vitest';
import { badgeFor, badgeSvg } from './badge';
import {
  bestLineFor,
  cellKind,
  cellResult,
  compareLines,
  DataError,
  defaultReactNativeLine,
  finderAnswer,
  formatTestedDate,
  newestTestedLine,
  overviewCell,
  packageWithoutResults,
  parseResultsFile,
  verifiedRange,
  type CatalogEntry,
  type ReactNativeLine,
} from './compat';
import { loadSiteData } from './load';
import { KIND_LABEL, OUTCOME_ICON, OUTCOME_LABEL, outcomeOf, STATUS_LABEL } from './view';

// React Native lines as the catalog gives them: ascending, and a prerelease version is an RC.
function rnLines(versions: string[]): ReactNativeLine[] {
  return versions
    .map((version) => ({
      line: version.split('.').slice(0, 2).join('.'),
      version,
      channel: version.includes('-') ? ('rc' as const) : ('stable' as const),
    }))
    .sort((a, b) => compareLines(a.line, b.line));
}

const RN = rnLines(['0.81.6', '0.82.1', '0.83.10', '0.84.0-rc.1']);
const FILE = 'compatibility-data/example/compatibility.json';

type Rows = Record<string, { version: string; cells: string }>;
type Cell = Record<string, unknown>;

// Builds a catalog entry and its results file from one letter per React Native line: Y passes,
// I iOS build fails, A Android build fails, B both builds fail, T tests fail, N passes with no test
// suite, X fails both builds with no test suite, and "-" leaves the cell out (not tested).
function fixture(rows: Rows, rn: ReactNativeLine[] = RN, name = 'example') {
  const entry: CatalogEntry = {
    name,
    repository: 'https://github.com/example/example',
    lines: Object.entries(rows)
      .map(([line, { version }]) => ({ line, version }))
      .sort((a, b) => compareLines(b.line, a.line)),
  };
  const results: Record<string, Record<string, Cell>> = {};
  for (const [line, { version, cells }] of Object.entries(rows)) {
    const row: Record<string, Cell> = {};
    [...cells].forEach((code, i) => {
      const column = rn[i];
      if (code === '-' || !column) return;
      row[column.line] = {
        status: code === 'Y' || code === 'N' ? 'compatible' : 'incompatible',
        tested: { library: version, reactNative: column.version },
        checks: {
          buildIos: code === 'I' || code === 'B' || code === 'X' ? 'failed' : 'passed',
          buildAndroid: code === 'A' || code === 'B' || code === 'X' ? 'failed' : 'passed',
          tests: code === 'T' ? 'failed' : code === 'N' || code === 'X' ? 'none' : 'passed',
        },
        testedAt: '2026-09-06T02:14:09Z',
      };
    });
    results[line] = row;
  }
  return { entry, file: { schemaVersion: 2, package: name, results } as Record<string, unknown> & { results: typeof results } };
}

function parse(rows: Rows) {
  const { entry, file } = fixture(rows);
  return parseResultsFile(file, FILE, entry, RN);
}

// A file with one passing cell (2.1 on 0.81), for tests that break one field.
function oneCellFile() {
  const made = fixture({ '2.1': { version: '2.1.3', cells: 'Y' } });
  const cell = made.file.results['2.1']?.['0.81'];
  if (!cell) throw new Error('fixture is missing the 0.81 cell');
  return { ...made, cell };
}

function rejects({ entry, file }: { entry: CatalogEntry; file: unknown }, pattern: RegExp, path = FILE) {
  expect(() => parseResultsFile(file, path, entry, RN)).toThrow(DataError);
  expect(() => parseResultsFile(file, path, entry, RN)).toThrow(pattern);
}

describe('compareLines', () => {
  it('orders numerically by major then minor', () => {
    const lines = ['0.100', '10.0', '0.9', '9.5', '0.99', '1.0'];
    expect([...lines].sort(compareLines)).toEqual(['0.9', '0.99', '0.100', '1.0', '9.5', '10.0']);
  });

  it('lists library rows newest first', () => {
    const pkg = parse({
      '9.5': { version: '9.5.0', cells: 'Y' },
      '10.0': { version: '10.0.1', cells: 'Y' },
    });
    expect(pkg.lines.map((l) => l.line)).toEqual(['10.0', '9.5']);
  });
});

describe('cellKind', () => {
  const pkg = parse({ '2.1': { version: '2.1.3', cells: 'YI-' } });

  it('reads compatible and incompatible cells', () => {
    expect(cellKind(pkg, '2.1', '0.81')).toBe('yes');
    expect(cellKind(pkg, '2.1', '0.82')).toBe('no');
  });

  it('treats a missing cell as queued', () => {
    expect(cellKind(pkg, '2.1', '0.83')).toBe('queued');
    expect(cellKind(pkg, '9.9', '0.81')).toBe('queued');
  });
});

describe('bestLineFor', () => {
  const pkg = parse({
    '2.1': { version: '2.1.3', cells: 'IY--' },
    '2.0': { version: '2.0.0', cells: 'YYT-' },
  });

  it('picks the newest compatible line', () => {
    expect(bestLineFor(pkg, '0.81')?.line).toBe('2.0');
    expect(bestLineFor(pkg, '0.82')?.line).toBe('2.1');
  });

  it('returns nothing when no line is compatible', () => {
    expect(bestLineFor(pkg, '0.83')).toBeUndefined();
    expect(bestLineFor(pkg, '0.84')).toBeUndefined();
  });
});

describe('overviewCell', () => {
  const pkg = parse({
    '2.1': { version: '2.1.3', cells: 'IY--' },
    '2.0': { version: '2.0.0', cells: 'YYT-' },
  });

  it('separates the newest line, an older line, no line, and untested', () => {
    expect(overviewCell(pkg, '0.82')).toEqual({ kind: 'latest', line: '2.1' });
    expect(overviewCell(pkg, '0.81')).toEqual({ kind: 'older', line: '2.0' });
    expect(overviewCell(pkg, '0.83')).toEqual({ kind: 'no' });
    expect(overviewCell(pkg, '0.84')).toEqual({ kind: 'untested' });
  });
});

describe('defaultReactNativeLine', () => {
  it('picks the newest stable line with results, skipping release candidates', () => {
    expect(defaultReactNativeLine(RN, parse({ '1.0': { version: '1.0.0', cells: 'YYYY' } }))?.line).toBe('0.83');
  });

  it('skips a newer stable line that has no results yet', () => {
    expect(defaultReactNativeLine(RN, parse({ '1.0': { version: '1.0.0', cells: 'IY--' } }))?.line).toBe('0.82');
  });

  it('falls back to the newest stable line when the package has no stable results', () => {
    expect(defaultReactNativeLine(RN, parse({ '1.0': { version: '1.0.0', cells: '---Y' } }))?.line).toBe('0.83');
  });

  it('returns nothing when there is no stable line', () => {
    const pkg = parse({ '1.0': { version: '1.0.0', cells: 'Y' } });
    expect(defaultReactNativeLine(RN.filter((rn) => rn.channel === 'rc'), pkg)).toBeUndefined();
  });
});

describe('newestTestedLine', () => {
  it('skips newer lines that have no results yet', () => {
    const pkg = parse({ '2.1': { version: '2.1.3', cells: '----' }, '2.0': { version: '2.0.0', cells: 'Y---' } });
    expect(newestTestedLine(pkg)?.line).toBe('2.0');
    expect(newestTestedLine(parse({ '2.1': { version: '2.1.3', cells: '----' } }))).toBeUndefined();
  });
});

describe('finderAnswer', () => {
  const pkg = parse({ '2.1': { version: '2.1.3', cells: 'YI-' } });

  it('names the tested release that works', () => {
    const answer = finderAnswer(pkg, '0.81');
    expect(answer.headline).toBe('2.1.x');
    expect(answer.best?.line).toBe('2.1');
    expect(answer.text).toContain('Tested 2.1.3 on React Native 0.81.');
  });

  it('says "None yet" when releases were tested and none works', () => {
    expect(finderAnswer(pkg, '0.82')).toMatchObject({
      tested: true,
      headline: 'None yet',
      text: 'No tested release builds and passes its tests on React Native 0.82 yet.',
    });
  });

  it('says "Not tested yet" when no release has a result on that line', () => {
    expect(finderAnswer(pkg, '0.83')).toMatchObject({
      tested: false,
      headline: 'Not tested yet',
      text: 'No release has been tested on React Native 0.83 yet.',
    });
    const skeleton = parse({ '2.1': { version: '2.1.3', cells: '----' } });
    expect(finderAnswer(skeleton, '0.81').headline).toBe('Not tested yet');
  });

  it('answers with an older line while the newest line has no results', () => {
    const older = parse({ '2.1': { version: '2.1.3', cells: '----' }, '2.0': { version: '2.0.0', cells: 'YY--' } });
    const answer = finderAnswer(older, '0.81');
    expect(answer.best?.line).toBe('2.0');
    expect(answer.headline).toBe('2.0.x');
    expect(answer.text).toContain('Tested 2.0.0 on React Native 0.81.');
    // Nothing was tried on 0.83 by either line.
    expect(finderAnswer(older, '0.83').headline).toBe('Not tested yet');
  });

  it('names newer lines that were not tried when "None yet"', () => {
    const one = parse({ '2.1': { version: '2.1.3', cells: '----' }, '2.0': { version: '2.0.0', cells: 'I---' } });
    expect(finderAnswer(one, '0.81')).toMatchObject({
      headline: 'None yet',
      text: 'No tested release builds and passes its tests on React Native 0.81 yet. 2.1.x has not been tested on it.',
    });
    const two = parse({
      '2.2': { version: '2.2.0', cells: '----' },
      '2.1': { version: '2.1.3', cells: '----' },
      '2.0': { version: '2.0.0', cells: 'I---' },
    });
    expect(finderAnswer(two, '0.81').text).toMatch(/ 2\.2\.x and 2\.1\.x have not been tested on it\.$/);
    // A newer line that was tried and failed is not "not tested".
    const tried = parse({ '2.1': { version: '2.1.3', cells: 'B---' }, '2.0': { version: '2.0.0', cells: 'I---' } });
    expect(finderAnswer(tried, '0.81').text).not.toContain('not been tested');
  });

  it('does not mention tests in "None yet" when only libraries without a test suite were tried', () => {
    const noSuite = parse({ '2.1': { version: '2.1.3', cells: 'X---' } });
    expect(finderAnswer(noSuite, '0.81').text).toBe('No tested release builds on React Native 0.81 yet.');
    // Same builds, but one library did have a suite (tests failed): the old sentence stays.
    const suite = parse({ '2.1': { version: '2.1.3', cells: 'T---' } });
    expect(finderAnswer(suite, '0.81').text).toBe(
      'No tested release builds and passes its tests on React Native 0.81 yet.',
    );
  });

  it('treats a release-candidate column like any other', () => {
    const rc = parse({ '2.1': { version: '2.1.3', cells: '---Y' } });
    expect(finderAnswer(rc, '0.84')).toMatchObject({ headline: '2.1.x', tested: true });
    expect(finderAnswer(rc, '0.83')).toMatchObject({ headline: 'Not tested yet', tested: false });
  });
});

describe('verifiedRange', () => {
  it('joins a contiguous run', () => {
    expect(verifiedRange(parse({ '1.0': { version: '1.0.0', cells: 'IYYY' } }), RN)).toBe('0.82 to 0.84');
  });

  it('splits non-contiguous runs, including a queued gap', () => {
    expect(verifiedRange(parse({ '1.0': { version: '1.0.0', cells: 'YYTY' } }), RN)).toBe('0.81 to 0.82, 0.84');
    expect(verifiedRange(parse({ '1.0': { version: '1.0.0', cells: 'Y-YY' } }), RN)).toBe('0.81, 0.83 to 0.84');
  });

  it('only looks at the newest line', () => {
    const pkg = parse({
      '2.0': { version: '2.0.0', cells: 'IIIY' },
      '1.0': { version: '1.0.0', cells: 'YYYY' },
    });
    expect(verifiedRange(pkg, RN)).toBe('0.84');
  });

  it('is empty when nothing is compatible', () => {
    expect(verifiedRange(parse({ '1.0': { version: '1.0.0', cells: 'IT--' } }), RN)).toBe('');
  });
});

describe('the approved design', () => {
  // The prototype's sample data.
  const columns = rnLines(['0.78.3', '0.79.7', '0.80.3', '0.81.6', '0.82.1', '0.83.10', '0.84.1', '0.85.3', '0.86.3', '0.87.1', '0.88.0-rc.3']);
  const made = fixture(
    {
      '2.1': { version: '2.1.3', cells: 'BBBIIYYYYYY' },
      '2.0': { version: '2.0.0', cells: 'BBIYYYYYYT-' },
      '1.3': { version: '1.3.21', cells: 'YYYYYYYABB-' },
    },
    columns,
  );
  const pkg = parseResultsFile(made.file, FILE, made.entry, columns);

  it('opens on 0.87 with 2.1 as the answer', () => {
    expect(defaultReactNativeLine(columns, pkg)?.line).toBe('0.87');
    expect(bestLineFor(pkg, '0.87')?.line).toBe('2.1');
  });

  it('shows the badge range and the home row from the prototype', () => {
    expect(verifiedRange(pkg, columns)).toBe('0.83 to 0.88');
    expect(columns.map((column) => bestLineFor(pkg, column.line)?.line)).toEqual([
      '1.3', '1.3', '1.3', '2.0', '2.0', '2.1', '2.1', '2.1', '2.1', '2.1', '2.1',
    ]);
    expect(cellKind(pkg, '2.0', '0.88')).toBe('queued');
  });
});

describe('validation', () => {
  it('rejects a status that contradicts the checks, naming the file and field', () => {
    const made = oneCellFile();
    made.cell.checks = { buildIos: 'passed', buildAndroid: 'passed', tests: 'failed' };
    rejects(made, /example\/compatibility\.json[\s\S]*results\["2\.1"\]\["0\.81"\]\.status/);
  });

  describe('a library with no test suite', () => {
    const checks = (buildIos: string, buildAndroid: string) => ({ buildIos, buildAndroid, tests: 'none' });

    it('is compatible when both builds pass', () => {
      const pkg = parse({ '2.1': { version: '2.1.3', cells: 'NI' } });
      expect(cellKind(pkg, '2.1', '0.81')).toBe('yes');
      expect(cellResult(pkg, '2.1', '0.81')?.checks.tests).toBe('none');
      // A failed build still makes it incompatible.
      expect(cellKind(pkg, '2.1', '0.82')).toBe('no');
      expect(verifiedRange(pkg, RN)).toBe('0.81');
    });

    it('accepts "compatible" only when both builds passed', () => {
      const ok = oneCellFile();
      ok.cell.checks = checks('passed', 'passed');
      expect(() => parseResultsFile(ok.file, FILE, ok.entry, RN)).not.toThrow();

      const failed = oneCellFile();
      failed.cell.checks = checks('failed', 'passed');
      rejects(failed, /\["0\.81"\]\.status: is "compatible" but the checks say "incompatible"/);
    });

    it('rejects "incompatible" when both builds passed', () => {
      const made = oneCellFile();
      made.cell.checks = checks('passed', 'passed');
      made.cell.status = 'incompatible';
      rejects(made, /\.status: is "incompatible" but the checks say "compatible"/);
    });

    it('rejects "none" on a build check', () => {
      const ios = oneCellFile();
      ios.cell.checks = { buildIos: 'none', buildAndroid: 'passed', tests: 'passed' };
      rejects(ios, /buildIos/);
      const android = oneCellFile();
      android.cell.checks = { buildIos: 'passed', buildAndroid: 'none', tests: 'passed' };
      rejects(android, /buildAndroid/);
    });
  });

  it('keeps results on lines the catalog no longer lists, without showing them', () => {
    const made = oneCellFile();
    made.file.results['2.1']!['0.70'] = { ...made.cell, tested: { library: '2.1.3', reactNative: '0.70.1' } };
    made.file.results['1.0'] = { '0.81': { ...made.cell, tested: { library: '1.0.0', reactNative: '0.81.6' } } };
    const pkg = parseResultsFile(made.file, FILE, made.entry, RN);
    expect([...(pkg.lines[0]?.results.keys() ?? [])]).toEqual(['0.81']);
    expect(pkg.lines.map((l) => l.line)).toEqual(['2.1']);
  });

  it('rejects an unknown status value', () => {
    const made = oneCellFile();
    made.cell.status = 'untested';
    rejects(made, /\.status/);
  });

  it('rejects tested versions from the wrong line', () => {
    const rnWrong = oneCellFile();
    rnWrong.cell.tested = { library: '2.1.3', reactNative: '0.82.1' };
    rejects(rnWrong, /results\["2\.1"\]\["0\.81"\]\.tested\.reactNative: "0\.82\.1" is not a 0\.81 release/);

    const libraryWrong = oneCellFile();
    libraryWrong.cell.tested = { library: '2.0.0', reactNative: '0.81.6' };
    rejects(libraryWrong, /tested\.library: "2\.0\.0" is not a 2\.1 release/);
  });

  it('requires the file to name its package and sit in its folder', () => {
    const other = oneCellFile();
    other.file.package = 'other';
    rejects(other, /package: "other" must be the package whose folder the file is in, "example"/);
    rejects(oneCellFile(), /must be the package whose folder the file is in, "other"/, 'compatibility-data/other/compatibility.json');
    const scoped = fixture({ '1.0': { version: '1.0.0', cells: 'Y' } }, RN, '@scope/name');
    expect(() => parseResultsFile(scoped.file, 'compatibility-data/@scope/name/compatibility.json', scoped.entry, RN)).not.toThrow();
  });

  it('only accepts https://codemagic.io links for buildUrl', () => {
    for (const url of ['javascript:alert(1)', 'http://codemagic.io/app/1', 'https://example.com/build/1']) {
      const made = oneCellFile();
      made.cell.buildUrl = url;
      rejects(made, /\["0\.81"\]\.buildUrl/);
    }
    const made = oneCellFile();
    made.cell.buildUrl = 'https://codemagic.io/app/abc/build/123';
    expect(parseResultsFile(made.file, FILE, made.entry, RN).lines[0]?.results.get('0.81')?.buildUrl).toBe(
      'https://codemagic.io/app/abc/build/123',
    );
  });

  it('rejects unknown keys at any level and names them', () => {
    const made = oneCellFile();
    made.cell.buildURL = 'https://codemagic.io/app/1';
    rejects(made, /\["0\.81"\]\.buildURL: is not a known field/);
    const top = oneCellFile();
    top.file.draft = true;
    rejects(top, /draft: is not a known field/);
  });

  it('rejects another schema version, line keys with leading zeros, and inexact tested versions', () => {
    const v1 = oneCellFile();
    v1.file.schemaVersion = 1;
    rejects(v1, /schemaVersion/);
    const zeros = fixture({ '01.0': { version: '1.0.0', cells: 'Y' } });
    rejects(zeros, /results\["01\.0"\]/);
    for (const library of ['2.1', 'v2.1.3', '2.1.03', `2.1.0-${'a'.repeat(59)}`]) {
      const made = oneCellFile();
      made.cell.tested = { library, reactNative: '0.81.6' };
      rejects(made, /tested\.library/);
    }
  });

  it('lists a package without a results file with nothing tested', () => {
    const { entry } = fixture({ '2.1': { version: '2.1.3', cells: '' }, '2.0': { version: '2.0.0', cells: '' } });
    const pkg = packageWithoutResults(entry);
    expect(pkg.lines.map((l) => [l.line, l.version, l.results.size])).toEqual([
      ['2.1', '2.1.3', 0],
      ['2.0', '2.0.0', 0],
    ]);
  });
});

describe('formatTestedDate', () => {
  it('formats in UTC as day, short month, year', () => {
    expect(formatTestedDate('2026-09-06T02:14:09Z')).toBe('6 Sep 2026');
    expect(formatTestedDate('2026-08-27T23:30:00Z')).toBe('27 Aug 2026');
  });
});

describe('badgeSvg', () => {
  it('pins text widths and describes itself', () => {
    const svg = badgeSvg({ tone: 'verified', message: '2.1.x: RN 0.83 to 0.88' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>rn.green: 2.1.x: RN 0.83 to 0.88</title>');
    expect(svg.match(/textLength="/g)).toHaveLength(2);
    expect(svg).toContain('#1f7a45');
  });

  it('keeps every number to one decimal place', () => {
    // "RN 0.81, 0.86" has 13 characters, and 13 * 7.2 is 93.60000000000001 in floating point.
    const svg = badgeSvg({ tone: 'verified', message: 'RN 0.81, 0.86' });
    const numbers = svg.match(/="(\d+(?:\.\d+)?)"/g) ?? [];
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(n).toMatch(/^="\d+(\.\d)?"$/);
  });

  it('colours each tone', () => {
    expect(badgeSvg({ tone: 'failing', message: 'x' })).toContain('#6b2d3a');
    const grey = badgeSvg({ tone: 'untested', message: 'not tested yet' });
    expect(grey).toContain('fill="#535b66"');
    expect(grey).not.toContain('#6b2d3a');
  });
});

describe('badgeFor', () => {
  const badge = (rows: Record<string, { version: string; cells: string }>) => badgeFor(parse(rows), RN);

  it('is grey "not tested yet" when no line has a result', () => {
    expect(badge({ '2.1': { version: '2.1.3', cells: '----' }, '2.0': { version: '2.0.0', cells: '----' } })).toEqual({
      tone: 'untested',
      message: 'not tested yet',
    });
  });

  it('is green and names the line when it has compatible versions', () => {
    expect(badge({ '2.1': { version: '2.1.3', cells: 'YYY-' } })).toEqual({
      tone: 'verified',
      message: '2.1.x: RN 0.81 to 0.83',
    });
  });

  it('is red only when every stable column has a result and none works', () => {
    expect(badge({ '2.1': { version: '2.1.3', cells: 'IAB-' } })).toEqual({
      tone: 'failing',
      message: '2.1.x: no verified versions',
    });
  });

  it('is grey "no verified versions yet" while some stable columns are untested', () => {
    expect(badge({ '2.1': { version: '2.1.3', cells: 'I---' } })).toEqual({
      tone: 'untested',
      message: '2.1.x: no verified versions yet',
    });
    expect(badge({ '2.1': { version: '2.1.3', cells: 'IT-B' } }).tone).toBe('untested');
  });

  it('does not count the release-candidate column towards "every column has a result"', () => {
    // 0.84 is the RC: untested does not hold red back, and a result there does not force it.
    expect(badge({ '2.1': { version: '2.1.3', cells: 'III-' } }).tone).toBe('failing');
    expect(badge({ '2.1': { version: '2.1.3', cells: 'II-I' } }).tone).toBe('untested');
    expect(badge({ '2.1': { version: '2.1.3', cells: 'IIIY' } })).toEqual({
      tone: 'verified',
      message: '2.1.x: RN 0.84',
    });
  });

  it('bases the badge on the newest line that has results', () => {
    expect(
      badge({ '2.1': { version: '2.1.3', cells: '----' }, '2.0': { version: '2.0.0', cells: 'YY--' } }),
    ).toEqual({ tone: 'verified', message: '2.0.x: RN 0.81 to 0.82' });
    // Once the newest line has a result, it is the one named, even where it fails.
    expect(
      badge({ '2.1': { version: '2.1.3', cells: 'I---' }, '2.0': { version: '2.0.0', cells: 'YYY-' } }),
    ).toEqual({ tone: 'untested', message: '2.1.x: no verified versions yet' });
  });
});

describe('words for "not tested"', () => {
  it('uses one vocabulary for cells, pills and checks', () => {
    expect(KIND_LABEL.queued).toBe('Untested');
    expect(STATUS_LABEL.queued).toBe('Not tested');
    expect(OUTCOME_LABEL.wait).toBe('Not tested');
  });
});

describe('the "no test suite" outcome', () => {
  it('is neither a pass nor a failure', () => {
    expect(outcomeOf('none')).toBe('none');
    expect(outcomeOf('passed')).toBe('pass');
    expect(outcomeOf('failed')).toBe('fail');
    expect(outcomeOf(undefined)).toBe('wait');
    expect(OUTCOME_LABEL.none).toBe('None');
    // The dash, like "not tested", and not the tick or the cross.
    expect(OUTCOME_ICON.none).toBe('dash');
  });

  it('does not tell the reader a test suite passed', () => {
    const pkg = parse({ '2.1': { version: '2.1.3', cells: 'N' } });
    const answer = finderAnswer(pkg, '0.81');
    expect(answer.headline).toBe('2.1.x');
    expect(answer.text).toBe(
      'Tested 2.1.3 on React Native 0.81.6. The demo app builds on iOS and Android. The library has no test suite.',
    );
    expect(answer.text).not.toContain('passes');
  });
});

describe('data in the repository', () => {
  it('loads and validates every package in the catalog', () => {
    const { packages, reactNative } = loadSiteData();
    expect(packages.length).toBeGreaterThan(0);
    expect(reactNative.length).toBeGreaterThan(0);
  });
});
