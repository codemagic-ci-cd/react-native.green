// What the watcher learns from past compatibility-check builds, as reported by the Codemagic API.
// Pure: the builds (with their details and artifact bytes) come in, decisions come out.
//
// Identity comes from the API, never from the artifact: the package and both versions are the
// build's inputs as Codemagic reports them, the build id and finish time are Codemagic's. From the
// artifact only the three check outcomes are taken, so a hostile library can at worst misreport its
// own cell.
import { parseResultArtifact } from './artifact.mjs';
import { validateCheckInputs } from './inputs.mjs';
import { buildUrlFor, composeCell, timestamp } from './record.mjs';

/** Builds finished longer ago than this are no longer looked at. */
export const LOOKBACK_DAYS = 7;
/** A cell whose check failed, was cancelled or timed out this recently is not started again. */
export const RECENT_FAILURE_DAYS = 3;

export const ACTIVE_STATUSES = new Set(['initializing', 'queued', 'preparing', 'fetching', 'testing', 'building', 'publishing', 'finishing']);
export const FAILED_STATUSES = new Set(['failed', 'canceled', 'timeout']);
const DAY = 24 * 60 * 60 * 1000;

export const cellKey = (name, libraryVersion, reactNativeVersion) => JSON.stringify([name, libraryVersion, reactNativeVersion]);

/** build_inputs as the API reports them, read strictly: strings for the three identity inputs. */
export function inputsOf(buildInputs) {
  const text = (value) => (typeof value === 'string' ? value : undefined);
  const record = buildInputs?.record;
  return {
    package: text(buildInputs?.package),
    libraryVersion: text(buildInputs?.library_version),
    reactNativeVersion: text(buildInputs?.react_native_version),
    record: record === undefined || record === true || record === 'true' ? 'true' : 'false',
  };
}

/** Build ids that already appear in a cell's buildUrl, in any results file. */
export function recordedBuildIds(resultsFiles) {
  const ids = new Set();
  for (const file of resultsFiles) {
    for (const row of Object.values(file.results ?? {})) {
      for (const cell of Object.values(row)) {
        const id = /\/build\/([^/?#]+)$/.exec(cell.buildUrl ?? '')?.[1];
        if (id) ids.add(decodeURIComponent(id));
      }
    }
  }
  return ids;
}

/**
 * Turns finished builds into cells to record.
 * @param {Array<{ id: string, appId: string, finishedAt: string, buildInputs: object,
 *   artifact: Buffer | null, artifactError?: string }>} builds  finished builds not yet recorded;
 *   artifact is the downloaded result.json, or null when the build has none; artifactError says why
 *   it could not be downloaded
 * @param {{ catalog: import('./catalog.mjs').Catalog }} data
 * @returns {{ results: Array<{ buildId: string, package: string, libraryLine: string,
 *   reactNativeLine: string, cell: object }>, rejected: Array<{ buildId: string, reason: string }> }}
 */
export function planRecording(builds, data) {
  const results = [];
  const rejected = [];
  for (const build of builds) {
    const reject = (reason) => rejected.push({ buildId: build.id, reason });
    const inputs = inputsOf(build.buildInputs);
    if (inputs.record === 'false') continue; // started with record off: nothing to write, by request

    const checked = validateCheckInputs(inputs, data);
    if (!checked.ok) {
      reject(`inputs: ${checked.errors.join('; ')}`);
      continue;
    }
    if (build.artifactError) {
      reject(`result.json: ${build.artifactError}`);
      continue;
    }
    if (!build.artifact) {
      reject('no result.json artifact');
      continue;
    }
    const parsed = parseResultArtifact(build.artifact);
    if (!parsed.ok) {
      reject(`result.json: ${parsed.reason}`);
      continue;
    }

    // Our settings decide whether the library has tests, not the artifact.
    const { settings } = checked.value;
    const checks = { ...parsed.checks };
    if (settings.test === 'none') {
      checks.tests = 'none';
    } else if (checks.tests === 'none') {
      reject('result.json: tests is "none" but green-packages.toml names a test command');
      continue;
    }
    if (!Number.isFinite(Date.parse(build.finishedAt ?? ''))) {
      reject('the API reports no finish time');
      continue;
    }

    results.push({
      buildId: build.id,
      package: checked.value.package,
      libraryLine: checked.value.libraryLine,
      reactNativeLine: checked.value.reactNativeLine,
      cell: composeCell({
        checks,
        library: checked.value.libraryVersion,
        reactNative: checked.value.reactNativeVersion,
        testedAt: timestamp(new Date(build.finishedAt)),
        buildUrl: buildUrlFor(build.appId, build.id),
      }),
    });
  }
  return { results, rejected };
}

/**
 * Cells not to start now: a check for them is queued or running, or failed, was cancelled or timed
 * out within RECENT_FAILURE_DAYS (a setup that fails every time would otherwise be retried forever).
 * @param {Array<{ status: string, createdAt: string, finishedAt?: string | null, buildInputs: object }>} builds
 */
export function busyCells(builds, now = new Date()) {
  const keys = new Map();
  for (const build of builds) {
    const inputs = inputsOf(build.buildInputs);
    if (!inputs.package || !inputs.libraryVersion || !inputs.reactNativeVersion) continue;
    const key = cellKey(inputs.package, inputs.libraryVersion, inputs.reactNativeVersion);
    if (ACTIVE_STATUSES.has(build.status)) {
      keys.set(key, build.status);
    } else if (FAILED_STATUSES.has(build.status)) {
      const when = Date.parse(build.finishedAt ?? build.createdAt ?? '');
      if (Number.isFinite(when) && now.getTime() - when < RECENT_FAILURE_DAYS * DAY) keys.set(key, `${build.status} recently`);
    }
  }
  return keys;
}

/** Whether a build from the list needs its details fetched, and why. */
export function interestOf(build, recorded, now = new Date()) {
  if (build.status === 'finished') return recorded.has(build.id) ? null : 'record';
  if (ACTIVE_STATUSES.has(build.status)) return 'busy';
  if (FAILED_STATUSES.has(build.status)) {
    const when = Date.parse(build.finished_at ?? build.created_at ?? '');
    return Number.isFinite(when) && now.getTime() - when < RECENT_FAILURE_DAYS * DAY ? 'busy' : null;
  }
  return null;
}
