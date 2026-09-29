import { describe, expect, it } from 'vitest';
import { distributionUrlOf, gradleVersionOf, planGradleWrapper, withDistributionUrl } from './gradle.mjs';

// The committed wrapper of react-native-screenshot-aware 1.3.21's demo app, and the template's for 0.84.
const committed = [
  'distributionBase=GRADLE_USER_HOME',
  'distributionPath=wrapper/dists',
  'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12-all.zip',
  'networkTimeout=10000',
  'validateDistributionUrl=true',
  '',
].join('\n');
const template84 = 'https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip';

describe('Gradle wrapper', () => {
  it('reads and replaces distributionUrl, keeping every other line', () => {
    expect(distributionUrlOf(committed)).toBe('https\\://services.gradle.org/distributions/gradle-8.12-all.zip');
    const next = withDistributionUrl(committed, template84);
    expect(distributionUrlOf(next)).toBe(template84);
    expect(next.replace(template84, '')).toBe(committed.replace(distributionUrlOf(committed), ''));
  });

  it('changes the wrapper to the template value, and only when it differs', () => {
    expect(planGradleWrapper(committed, template84)).toEqual({ from: distributionUrlOf(committed), to: template84 });
    expect(planGradleWrapper(withDistributionUrl(committed, template84), template84)).toBeNull();
  });

  it('leaves the wrapper alone without a template value or a wrapper file', () => {
    expect(planGradleWrapper(committed, null)).toBeNull();
    expect(planGradleWrapper('', template84)).toBeNull();
  });

  it('names versions for the log', () => {
    expect(gradleVersionOf(template84)).toBe('9.0.0');
    expect(gradleVersionOf('https\\://services.gradle.org/distributions/gradle-8.12-all.zip')).toBe('8.12');
  });
});
