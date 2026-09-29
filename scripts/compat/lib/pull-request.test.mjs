import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bodyFor, branchFor, changedCells, nextResultsFile, packageOfBranch, titleFor } from './pull-request.mjs';
import { composeCell, emptyResults } from './record.mjs';

const validRef = (branch) => spawnSync('git', ['check-ref-format', '--branch', branch]).status === 0;

// npm names that are valid (lowercase letters, digits, - . _ ~, an optional scope) but awkward in a ref.
const NAMES = [
  'react-native-screens',
  'react-native-screenshot-aware',
  '@react-navigation/core',
  '@codemagic/react-native-patch',
  'lodash.merge',
  'a..b',
  'a.',
  'x.lock',
  'x..lock',
  '~tilde',
  'a~b',
  '@s~/n~',
  '@a.b/c.lock',
  '-leading',
  '_under',
];

describe('branchFor', () => {
  it('keeps ordinary names readable', () => {
    expect(branchFor('react-native-screens')).toBe('compat/react-native-screens');
    expect(branchFor('@react-navigation/core')).toBe('compat/@react-navigation/core');
    expect(branchFor('lodash.merge')).toBe('compat/lodash.merge');
  });

  it('gives a branch git accepts for every awkward name', () => {
    for (const name of NAMES) expect([name, validRef(branchFor(name))]).toEqual([name, true]);
  });

  it('never gives two packages the same branch: the name can be read back', () => {
    for (const name of NAMES) expect(packageOfBranch(branchFor(name))).toBe(name);
    expect(new Set(NAMES.map(branchFor)).size).toBe(NAMES.length);
    // A prefix of another name is its own branch.
    expect(branchFor('react-native-screens')).not.toBe(branchFor('react-native-screenshot-aware'));
  });
});

const cellOf = (library, reactNative, testedAt, buildIos = 'passed') =>
  composeCell({
    checks: { buildIos, buildAndroid: 'passed', tests: 'passed' },
    library,
    reactNative,
    testedAt,
    buildUrl: `https://codemagic.io/app/app1/build/${testedAt.replace(/\D/g, '')}`,
  });
const at = (libraryLine, reactNativeLine, cell) => ({ libraryLine, reactNativeLine, cell });
const lines = { libraryLines: ['2.1', '2.0'], reactNativeLines: ['0.86', '0.87'] };

describe('nextResultsFile', () => {
  const first = cellOf('2.1.3', '0.87.1', '2026-09-29T10:00:00Z');
  const second = cellOf('2.1.3', '0.86.3', '2026-09-29T11:00:00Z');

  it('starts from the base branch and adds the new cell', () => {
    const next = nextResultsFile({ name: 'example', base: undefined, branch: undefined, result: at('2.1', '0.87', first), ...lines });
    expect(next).toEqual({ schemaVersion: 2, package: 'example', results: { '2.1': { '0.87': first } } });
  });

  it('carries the cells the branch already holds', () => {
    const branch = { schemaVersion: 2, package: 'example', results: { '2.1': { '0.87': first } } };
    const next = nextResultsFile({ name: 'example', base: undefined, branch, result: at('2.1', '0.86', second), ...lines });
    expect(next.results['2.1']).toEqual({ '0.86': second, '0.87': first });
    expect(changedCells(undefined, next)).toHaveLength(2);
  });

  it('keeps nothing twice once the base branch has taken the cells', () => {
    const base = { schemaVersion: 2, package: 'example', results: { '2.1': { '0.87': first } } };
    // The branch is stale: it still holds the merged cell.
    const branch = structuredClone(base);
    const third = cellOf('2.0.0', '0.87.1', '2026-09-29T12:00:00Z');
    const next = nextResultsFile({ name: 'example', base, branch, result: at('2.0', '0.87', third), ...lines });
    expect(changedCells(base, next).map((c) => c.cell)).toEqual([third]);
  });

  it('never replaces a newer cell with an older one', () => {
    const newer = cellOf('2.1.3', '0.87.1', '2026-09-30T10:00:00Z', 'failed');
    const base = { schemaVersion: 2, package: 'example', results: { '2.1': { '0.87': newer } } };
    const next = nextResultsFile({ name: 'example', base, branch: undefined, result: at('2.1', '0.87', first), ...lines });
    expect(next.results['2.1']['0.87']).toEqual(newer);
    expect(changedCells(base, next)).toEqual([]);
  });

  it('drops cells on lines the catalog no longer lists', () => {
    const retired = cellOf('1.3.21', '0.87.1', '2026-09-29T09:00:00Z');
    const branch = { schemaVersion: 2, package: 'example', results: { '1.3': { '0.87': retired } } };
    const next = nextResultsFile({ name: 'example', base: emptyResults('example'), branch, result: at('2.1', '0.87', first), ...lines });
    expect(Object.keys(next.results)).toEqual(['2.1']);
  });
});

describe('titleFor and bodyFor', () => {
  it('counts the results', () => {
    expect(titleFor('example', 1)).toBe('compat: example: 1 result');
    expect(titleFor('@scope/example', 3)).toBe('compat: @scope/example: 3 results');
  });

  it('lists one row per cell, with its build link', () => {
    const cells = [at('2.1', '0.87', cellOf('2.1.3', '0.87.1', '2026-09-29T10:00:00Z')), at('2.1', '0.86', { ...cellOf('2.1.3', '0.86.3', '2026-09-29T11:00:00Z', 'failed'), buildUrl: undefined })];
    const body = bodyFor('example', cells, 'main');
    const rows = body.split('\n').filter((line) => line.startsWith('| 2.1.3'));
    expect(rows).toEqual([
      '| 2.1.3 | 0.87.1 | Compatible | passed | passed | passed | 2026-09-29T10:00:00Z | [build](https://codemagic.io/app/app1/build/20260929100000) |',
      '| 2.1.3 | 0.86.3 | Incompatible | failed | passed | passed | 2026-09-29T11:00:00Z | local run |',
    ]);
    expect(body).toMatch(/delete the branch/);
  });
});
