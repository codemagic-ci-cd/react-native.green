import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog.mjs';
import { buildRequest, orderAndCut, refreshPackage, refreshReactNative, staleCells } from './watch.mjs';

const reactNative = ['0.88.0-rc.2', '0.87.1', '0.86.2'];
const npm = (versions, distTags = {}) => ({ versions, distTags });

describe('refreshReactNative', () => {
  it('moves each line to its newest patch, newest first', () => {
    const { versions, changes } = refreshReactNative(
      reactNative,
      npm(['0.86.2', '0.86.3', '0.87.1', '0.88.0-rc.2', '0.88.0-rc.3', '0.88.0-nightly-20260901-a'], { latest: '0.87.1', next: '0.88.0-rc.3' }),
    );
    expect(versions).toEqual(['0.88.0-rc.3', '0.87.1', '0.86.3']);
    expect(changes).toEqual(['react-native 0.88: 0.88.0-rc.2 -> 0.88.0-rc.3', 'react-native 0.86: 0.86.2 -> 0.86.3']);
  });

  it('moves a line from its release candidate to the stable release', () => {
    expect(refreshReactNative(reactNative, npm(['0.88.0-rc.3', '0.88.0'], { latest: '0.88.0' })).versions[0]).toBe('0.88.0');
  });

  it('adds a newer line from the latest or next tag, never an older one, and never removes', () => {
    const { versions } = refreshReactNative(reactNative, npm(['0.85.3', '0.89.0-rc.0', '0.89.0-nightly-20260928-a'], { latest: '0.85.3', next: '0.89.0-rc.0' }));
    expect(versions).toEqual(['0.89.0-rc.0', '0.88.0-rc.2', '0.87.1', '0.86.2']);
  });

  it('does not add a line that only has nightlies', () => {
    expect(refreshReactNative(reactNative, npm(['0.89.0-nightly-20260928-a'], { next: '0.89.0-nightly-20260928-a' })).versions).toEqual(reactNative);
  });
});

describe('refreshPackage', () => {
  it('moves lines to their newest stable patch, ignores prereleases, adds a newer latest line', () => {
    const { versions, changes } = refreshPackage('example', ['2.1.2', '2.0.0'], npm(['2.0.0', '2.1.2', '2.1.3', '2.1.4-beta.1', '2.2.0', '3.0.0-rc.1'], { latest: '2.2.0', next: '3.0.0-rc.1' }));
    expect(versions).toEqual(['2.2.0', '2.1.3', '2.0.0']);
    expect(changes).toEqual(['example 2.1: 2.1.2 -> 2.1.3', 'example 2.2: new line at 2.2.0']);
  });

  it('ignores a latest tag on an older line', () => {
    expect(refreshPackage('example', ['2.1.2', '2.0.0'], npm(['2.0.0', '2.1.2', '1.9.0'], { latest: '1.9.0' })).changes).toEqual([]);
  });
});

const catalog = (() => {
  const parsed = parseCatalog(
    {
      schema: 1,
      'react-native': { versions: ['0.88.0-rc.3', '0.87.1', '0.86.3'] },
      package: [{ name: 'example', repository: 'https://github.com/example/example', versions: ['2.1.3', '2.0.0'], test: { run: 'none' }, demo: { dir: 'example' } }],
    },
    'green-packages.toml',
  );
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.value;
})();
const [example] = catalog.packages;
const tested = (library, rn) => ({ status: 'compatible', tested: { library, reactNative: rn } });

describe('staleCells', () => {
  it('lists every pair when there is no results file', () => {
    expect(staleCells(example, catalog.reactNative, undefined)).toHaveLength(6);
  });

  it('finds missing cells and cells tested on other versions', () => {
    const results = {
      schemaVersion: 2,
      package: 'example',
      results: {
        '2.1': { '0.87': tested('2.1.3', '0.87.1'), '0.86': tested('2.1.3', '0.86.2'), '0.88': tested('2.1.2', '0.88.0-rc.3') },
        '2.0': { '0.87': tested('2.0.0', '0.87.1') },
      },
    };
    const keys = staleCells(example, catalog.reactNative, results).map((c) => `${c.libraryLine}@${c.reactNativeLine}:${c.reason}`);
    expect(keys.sort()).toEqual(['2.0@0.86:not tested', '2.0@0.88:not tested', '2.1@0.86:newer patch', '2.1@0.88:newer patch'].sort());
  });
});

describe('orderAndCut', () => {
  const cells = staleCells(example, catalog.reactNative, undefined);

  it('orders newest React Native line first, then newest library line', () => {
    expect(orderAndCut(cells, 10).start.map((c) => `${c.reactNativeLine}/${c.libraryLine}`)).toEqual([
      '0.88/2.1', '0.88/2.0', '0.87/2.1', '0.87/2.0', '0.86/2.1', '0.86/2.0',
    ]);
  });

  it('keeps the first max_builds and leaves the rest for later', () => {
    const { start, later } = orderAndCut(cells, 4);
    expect(start).toHaveLength(4);
    expect(later.map((c) => `${c.reactNativeLine}/${c.libraryLine}`)).toEqual(['0.86/2.1', '0.86/2.0']);
    expect(orderAndCut(cells, 0).start).toEqual([]);
    expect(orderAndCut(cells, -3).start).toEqual([]);
  });
});

describe('buildRequest', () => {
  const cell = { package: 'example', libraryLine: '2.1', libraryVersion: '2.1.3', reactNativeLine: '0.78', reactNativeVersion: '0.78.3' };

  it('starts compatibility-check with the cell as inputs and labels', () => {
    expect(buildRequest(cell, { branch: 'main' })).toEqual({
      workflow_id: 'compatibility-check',
      branch: 'main',
      inputs: { package: 'example', library_version: '2.1.3', react_native_version: '0.78.3', record: true },
      labels: ['example', 'library 2.1.3', 'react-native 0.78.3'],
    });
  });

  it('passes the package Node version, and Xcode only for lines listed in the map', () => {
    expect(buildRequest(cell, { branch: 'main', xcodeByLine: { '0.78': '16.4' }, node: '24' }).environment).toEqual({
      software_versions: { xcode: '16.4', node: '24' },
    });
    expect(buildRequest(cell, { branch: 'main', xcodeByLine: { '0.87': '26.6' } })).not.toHaveProperty('environment');
  });
});
