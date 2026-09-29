import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { setVersions, verifyEdit } from './catalog-edit.mjs';
import { CATALOG_FILE } from './catalog.mjs';
import { REPO_ROOT } from './config.mjs';

const TEXT = `# versions = ["9.9.9"] in a comment must not be matched
schema = 1

[react-native]
# Every package is checked against each of these.
versions = [
  # the release candidate
  "0.88.0-rc.3",
  "0.87.1", # newest stable
  "0.86.3",
  # the oldest line
] # after the array

[[package]]
name = "react-native-screenshot-aware"
description = "versions = [\\"1.0.0\\"] inside a string"
versions = ["2.1.3", "2.0.0"]

[package.test]
run = "none"

[package.demo]
dir = "example"
versions = "not the package's own key"

[[package]]
name = "react-native-screens"
versions = [ "4.28.0", "4.27.0" ]

[[package]]
name = "@react-navigation/core"
versions = [
    "7.22.1",
    "7.21.13",
]
`;

const changedLines = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return y.filter((line, i) => line !== x[i] || x.length !== y.length).length;
};

describe('setVersions', () => {
  it('rewrites a multi-line array one value per line, keeping every comment', () => {
    const next = setVersions(TEXT, 'react-native', ['0.89.0-rc.0', '0.88.0', '0.87.2', '0.86.3']);
    expect(next).toContain(
      [
        'versions = [',
        '  "0.89.0-rc.0",',
        '  # the release candidate',
        '  "0.88.0",',
        '  "0.87.2", # newest stable',
        '  "0.86.3",',
        '  # the oldest line',
        '] # after the array',
      ].join('\n'),
    );
    expect(next.startsWith('# versions = ["9.9.9"] in a comment must not be matched\n')).toBe(true);
    expect(parse(next)['react-native'].versions).toEqual(['0.89.0-rc.0', '0.88.0', '0.87.2', '0.86.3']);
  });

  it('keeps a one-line array on one line, with its spacing', () => {
    const next = setVersions(TEXT, 'react-native-screens', ['4.28.1', '4.27.0']);
    expect(next).toContain('versions = [ "4.28.1", "4.27.0" ]');
    expect(changedLines(TEXT, next)).toBe(1);
  });

  it('finds the package by exact name, not a prefix, and only its own key', () => {
    const next = setVersions(TEXT, 'react-native-screenshot-aware', ['2.2.0', '2.1.3', '2.0.0']);
    expect(next).toContain('versions = ["2.2.0", "2.1.3", "2.0.0"]');
    expect(next).toContain('versions = [ "4.28.0", "4.27.0" ]');
    expect(next).toContain('description = "versions = [\\"1.0.0\\"] inside a string"');
    expect(next).toContain(`versions = "not the package's own key"`);
    expect(changedLines(TEXT, next)).toBe(1);
  });

  it('edits a scoped package, keeping the indentation of its multi-line array', () => {
    const next = setVersions(TEXT, '@react-navigation/core', ['7.23.0', '7.22.1', '7.21.13']);
    expect(next).toContain('versions = [\n    "7.23.0",\n    "7.22.1",\n    "7.21.13",\n]');
  });

  it('refuses a target that does not exist', () => {
    expect(() => setVersions(TEXT, 'react-native-tab-view', ['1.0.0'])).toThrow(/no \[\[package\]\] named "react-native-tab-view"/);
    expect(() => setVersions('schema = 1\n', 'react-native', ['0.87.1'])).toThrow(/no versions key in \[react-native\]/);
  });

  it('refuses an edit that changes anything else', () => {
    const tampered = TEXT.replace('dir = "example"', 'dir = "elsewhere"').replace('"2.1.3", "2.0.0"', '"2.2.0", "2.1.3", "2.0.0"');
    expect(() => verifyEdit(TEXT, tampered, 'react-native-screenshot-aware', ['2.2.0', '2.1.3', '2.0.0'])).toThrow(/changed something else/);
    expect(() => verifyEdit(TEXT, TEXT, 'react-native-screenshot-aware', ['2.2.0'])).toThrow(/not \["2.2.0"\]/);
  });
});

describe('setVersions on the repository catalog', () => {
  // Diff the real file before and after, as `git diff --stat` would count it.
  const numstat = (before, after) => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-edit-'));
    writeFileSync(join(dir, 'a.toml'), before);
    writeFileSync(join(dir, 'b.toml'), after);
    let out = '';
    try {
      out = execFileSync('git', ['diff', '--no-index', '--numstat', 'a.toml', 'b.toml'], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      out = error.stdout; // git diff --no-index exits 1 when the files differ
    }
    return out.trim().split('\t').slice(0, 2).map(Number);
  };
  const text = readFileSync(join(REPO_ROOT, CATALOG_FILE), 'utf8');

  it('changes only the React Native lines it should', () => {
    const current = parse(text)['react-native'].versions;
    const next = setVersions(text, 'react-native', ['0.89.0-rc.0', ...current.map((v) => (v === '0.87.1' ? '0.87.2' : v))]);
    expect(numstat(text, next)).toEqual([2, 1]); // one line added (0.89), one replaced (0.87)
  });

  it('changes only the versions line of a scoped package', () => {
    const next = setVersions(text, '@react-navigation/core', ['7.23.0', '7.22.1', '7.21.13', '7.20.0']);
    expect(numstat(text, next)).toEqual([1, 1]);
  });
});
