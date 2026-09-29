import type { CellKind, CellResult, CheckResult, ReactNativeLine } from './compat';
import type { IconName } from './icons';

export const KIND_LABEL: Record<CellKind, string> = { yes: 'Yes', no: 'No', queued: 'Untested' };
export const KIND_ICON: Record<CellKind, IconName> = { yes: 'check', no: 'cross', queued: 'dash' };
export const STATUS_LABEL: Record<CellKind, string> = {
  yes: 'Compatible',
  no: 'Not compatible',
  queued: 'Not tested',
};
/** The pill beside a release on phones: the table's words, except that untested reads as a status. */
export const PILL_LABEL: Record<CellKind, string> = { ...KIND_LABEL, queued: 'Not tested' };

/**
 * A check row reads "wait" ("Not tested") when the cell has not been tested, and "none" when the
 * library has no test suite, which is neither a pass nor a failure.
 */
export type Outcome = 'pass' | 'fail' | 'wait' | 'none';
export const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'Passed',
  fail: 'Failed',
  wait: 'Not tested',
  none: 'None',
};
export const OUTCOME_ICON: Record<Outcome, IconName> = { pass: 'check', fail: 'cross', wait: 'dash', none: 'dash' };

export const CHECKS = [
  { key: 'buildIos', name: 'iOS build of the demo app', short: 'iOS' },
  { key: 'buildAndroid', name: 'Android build of the demo app', short: 'Android' },
  { key: 'tests', name: 'Library test suite', short: 'Tests' },
] as const satisfies ReadonlyArray<{ key: keyof CellResult['checks']; name: string; short: string }>;

export function outcomeOf(check: CheckResult | undefined): Outcome {
  if (!check) return 'wait';
  if (check === 'none') return 'none';
  return check === 'passed' ? 'pass' : 'fail';
}

export function isRc(rn: ReactNativeLine): boolean {
  return rn.channel === 'rc';
}

export function rnAriaLabel(rn: ReactNativeLine): string {
  return `React Native ${rn.line}${isRc(rn) ? ' release candidate' : ''}`;
}

/** "0.88 RC" in headings, "0.87" otherwise. */
export function rnTitle(rn: ReactNativeLine): string {
  return `${rn.line}${isRc(rn) ? ' RC' : ''}`;
}
