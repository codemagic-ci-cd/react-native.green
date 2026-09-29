import { describe, expect, it } from 'vitest';
import {
  compareLines,
  compareVersions,
  isReleaseCandidate,
  isStable,
  isVersion,
  lineOf,
  newestOnLine,
} from './semver.mjs';

describe('semver', () => {
  it('derives the line from stable and release candidate versions', () => {
    expect(lineOf('0.87.1')).toBe('0.87');
    expect(lineOf('0.88.0-rc.3')).toBe('0.88');
    expect(lineOf('10.2.0')).toBe('10.2');
    expect(lineOf('not a version')).toBeNull();
  });

  it('orders by semver precedence', () => {
    const sorted = ['0.88.0', '0.88.0-rc.10', '0.87.1', '0.88.0-rc.2', '0.88.0-nightly-20260901-a'].sort(compareVersions);
    expect(sorted).toEqual(['0.87.1', '0.88.0-nightly-20260901-a', '0.88.0-rc.2', '0.88.0-rc.10', '0.88.0']);
    expect(compareLines('0.99', '0.100')).toBeLessThan(0);
  });

  it('tells stable, release candidate and other prereleases apart', () => {
    expect(isStable('0.87.1')).toBe(true);
    expect(isStable('0.88.0-rc.3')).toBe(false);
    expect(isReleaseCandidate('0.88.0-rc.3')).toBe(true);
    expect(isReleaseCandidate('0.89.0-nightly-20260928-d7ff82ebe')).toBe(false);
  });

  it('rejects versions the site would reject', () => {
    for (const bad of ['2.1', 'v2.1.3', '2.1.03', '2.1.3-', '1.0.0-' + 'a'.repeat(59), '0.87.1 ', '0.87.1\n']) {
      expect(isVersion(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('finds the newest version on a line', () => {
    expect(newestOnLine(['0.87.0', '0.87.1', '0.88.0-rc.1'], '0.87')).toBe('0.87.1');
    expect(newestOnLine(['0.88.0-rc.1', '0.88.0-rc.3'], '0.88', isStable)).toBeNull();
  });
});
