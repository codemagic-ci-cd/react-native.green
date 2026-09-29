import type { CellKind, CellResult, CheckResult, ReactNativeLine } from './compat';
import type { IconName } from './icons';

export const KIND_LABEL: Record<CellKind, string> = { yes: 'Yes', no: 'No', queued: 'Queued' };
export const KIND_ICON: Record<CellKind, IconName> = { yes: 'check', no: 'cross', queued: 'clock' };
export const STATUS_LABEL: Record<CellKind, string> = {
  yes: 'Compatible',
  no: 'Not compatible',
  queued: 'Queued',
};

/** A check row reads "wait" when the cell has not been tested. */
export type Outcome = 'pass' | 'fail' | 'wait';
export const OUTCOME_LABEL: Record<Outcome, string> = { pass: 'Passed', fail: 'Failed', wait: 'Queued' };
export const OUTCOME_ICON: Record<Outcome, IconName> = { pass: 'check', fail: 'cross', wait: 'clock' };

export const CHECKS = [
  { key: 'buildIos', name: 'iOS build of the demo app', short: 'iOS' },
  { key: 'buildAndroid', name: 'Android build of the demo app', short: 'Android' },
  { key: 'tests', name: 'Library test suite', short: 'Tests' },
] as const satisfies ReadonlyArray<{ key: keyof CellResult['checks']; name: string; short: string }>;

export function outcomeOf(check: CheckResult | undefined): Outcome {
  if (!check) return 'wait';
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
