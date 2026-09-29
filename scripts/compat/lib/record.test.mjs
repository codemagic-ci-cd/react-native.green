import { describe, expect, it } from 'vitest';
import { formatJson } from './json-format.mjs';
import { applyCell, buildUrlFor, composeCell, emptyResults, tidyResults, timestamp } from './record.mjs';

const cellAt = (testedAt, checks = { buildIos: 'passed', buildAndroid: 'failed', tests: 'passed' }) =>
  composeCell({ checks, library: '2.1.3', reactNative: '0.87.1', testedAt, buildUrl: 'https://codemagic.io/app/app1/build/b1' });
const cell = cellAt('2026-09-29T10:00:00Z');

describe('composeCell', () => {
  it('is compatible only when both builds and the tests passed, with keys in file order', () => {
    expect(cell.status).toBe('incompatible');
    expect(Object.keys(cell)).toEqual(['status', 'tested', 'checks', 'buildUrl', 'testedAt']);
    expect(cellAt('x', { buildIos: 'passed', buildAndroid: 'passed', tests: 'passed' }).status).toBe('compatible');
    expect(cellAt('x', { buildIos: 'passed', buildAndroid: 'passed', tests: 'failed' }).status).toBe('incompatible');
  });

  it('judges a library without a test suite on its builds alone', () => {
    expect(cellAt('x', { buildIos: 'passed', buildAndroid: 'passed', tests: 'none' }).status).toBe('compatible');
    expect(cellAt('x', { buildIos: 'failed', buildAndroid: 'passed', tests: 'none' }).status).toBe('incompatible');
  });

  it('refuses a check without a valid result', () => {
    expect(() => cellAt('x', { buildIos: 'passed', buildAndroid: 'passed' })).toThrow(/tests/);
    expect(() => cellAt('x', { buildIos: 'none', buildAndroid: 'passed', tests: 'passed' })).toThrow(/buildIos/);
  });
});

describe('applyCell', () => {
  const at = (reactNativeLine, c = cell) => ({ libraryLine: '2.1', reactNativeLine, cell: c });

  it('starts a results file for a package that has none', () => {
    const { file, applied } = applyCell(undefined, 'example', at('0.87'));
    expect(applied).toBe(true);
    expect(file).toEqual({ schemaVersion: 2, package: 'example', results: { '2.1': { '0.87': cell } } });
  });

  it('adds to an existing file without changing the input', () => {
    const first = applyCell(emptyResults('example'), 'example', at('0.87')).file;
    const older = { ...cell, tested: { library: '2.1.3', reactNative: '0.85.3' } };
    const { file } = applyCell(first, 'example', at('0.85', older));
    expect(Object.keys(file.results['2.1']).sort()).toEqual(['0.85', '0.87']);
    expect(Object.keys(first.results['2.1'])).toEqual(['0.87']);
  });

  it('applies a result only when it is newer than the cell, so recording again changes nothing', () => {
    const real = applyCell(undefined, 'example', at('0.87')).file;
    expect(applyCell(real, 'example', at('0.87')).applied).toBe(false);
    const older = applyCell(real, 'example', at('0.87', cellAt('2026-09-28T10:00:00Z')));
    expect(older.applied).toBe(false);
    expect(older.file).toBe(real);
    const newer = applyCell(real, 'example', at('0.87', cellAt('2026-09-30T10:00:00Z')));
    expect(newer.applied).toBe(true);
    expect(newer.file.results['2.1']['0.87'].testedAt).toBe('2026-09-30T10:00:00Z');
  });
});

describe('tidyResults', () => {
  it('keeps only lines the catalog lists, library lines newest first and React Native lines ascending', () => {
    const file = {
      schemaVersion: 2,
      package: 'example',
      results: {
        '1.9': { '0.87': cell },
        '2.1': { '0.88': cell, '0.70': cell, '0.87': cell },
        '2.10': { '0.87': cell },
        '0.1': { '0.87': cell },
      },
    };
    const tidy = tidyResults(file, ['2.10', '2.1', '1.9'], ['0.87', '0.88']);
    expect(Object.keys(tidy.results)).toEqual(['2.10', '2.1', '1.9']);
    expect(Object.keys(tidy.results['2.1'])).toEqual(['0.87', '0.88']);
    expect(tidyResults(file, ['3.0'], ['0.87']).results).toEqual({});
  });
});

describe('recording helpers', () => {
  it('links the Codemagic build', () => {
    expect(buildUrlFor('p1', 'b1')).toBe('https://codemagic.io/app/p1/build/b1');
  });

  it('writes whole-second UTC timestamps', () => {
    expect(timestamp(new Date('2026-09-29T10:00:00.123Z'))).toBe('2026-09-29T10:00:00Z');
  });
});

describe('formatJson', () => {
  it('matches the hand-written layout of the data files', () => {
    const text = [
      '{',
      '  "schemaVersion": 1,',
      '  "package": {',
      '    "name": "example",',
      '    "repository": "https://github.com/example/example"',
      '  },',
      '  "lines": {',
      '    "0.87": { "version": "0.87.1", "channel": "stable" },',
      '    "2.1": {',
      '      "version": "2.1.3",',
      '      "results": {',
      '        "0.87": {',
      '          "status": "compatible",',
      '          "tested": { "library": "2.1.3", "reactNative": "0.87.1" },',
      '          "testedAt": "2026-09-06T02:14:09Z"',
      '        }',
      '      }',
      '    },',
      '    "2.0": {',
      '      "version": "2.0.0",',
      '      "results": {}',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(formatJson(JSON.parse(text))).toBe(text);
  });
});
