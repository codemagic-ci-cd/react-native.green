import { describe, expect, it } from 'vitest';
import api from '../fixtures/api-builds.json' with { type: 'json' };
import { busyCells, cellKey, interestOf, planRecording, recordedBuildIds } from './collect.mjs';
import { parseCatalog } from './catalog.mjs';
import { applyCell } from './record.mjs';

const NOW = new Date('2026-09-29T12:00:00Z');
const withTests = { dir: '.', run: ['yarn', 'test'] };

// The repository data the watcher reads: a catalog with one package that has settings and one that
// has none, and example's results file.
function repo({ test = withTests, results = {} } = {}) {
  const parsed = parseCatalog(
    {
      schema: 1,
      'react-native': { versions: ['0.88.0-rc.3', '0.87.1', '0.86.3'] },
      package: [
        { name: 'example', repository: 'https://github.com/example/example', versions: ['2.1.3', '2.0.0'], test: test === 'none' ? { run: 'none' } : { ...test }, demo: { dir: 'example' } },
        { name: 'other', repository: 'https://github.com/example/other', versions: ['1.0.0'] },
      ],
    },
    'green-packages.toml',
  );
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return { catalog: parsed.value, results: { schemaVersion: 2, package: 'example', results: { '2.1': results } } };
}

const result = (checks) => Buffer.from(JSON.stringify({ schemaVersion: 1, checks }));
const PASSED = { buildIos: 'passed', buildAndroid: 'passed', tests: 'passed' };

// A finished build as the watcher hands it to planRecording.
function finished(overrides = {}) {
  const detail = api.details['b-new'];
  return {
    id: detail.id,
    appId: detail.app_id,
    finishedAt: detail.finished_at,
    buildInputs: detail.build_inputs,
    artifact: result({ buildIos: 'passed', buildAndroid: 'failed', tests: 'passed' }),
    ...overrides,
  };
}

describe('planRecording', () => {
  it('composes the cell from the API facts and only the checks from the artifact', () => {
    const { results, rejected } = planRecording([finished()], repo());
    expect(rejected).toEqual([]);
    expect(results).toEqual([
      {
        buildId: 'b-new',
        package: 'example',
        libraryLine: '2.1',
        reactNativeLine: '0.87',
        cell: {
          status: 'incompatible',
          tested: { library: '2.1.3', reactNative: '0.87.1' },
          checks: { buildIos: 'passed', buildAndroid: 'failed', tests: 'passed' },
          buildUrl: 'https://codemagic.io/app/app1/build/b-new',
          testedAt: '2026-09-29T09:40:12Z',
        },
      },
    ]);
  });

  it('cannot be pointed at another package by the artifact', () => {
    const claims = Buffer.from(JSON.stringify({ schemaVersion: 1, checks: PASSED, package: 'other' }));
    const { results, rejected } = planRecording([finished({ artifact: claims })], repo());
    expect(results).toEqual([]);
    expect(rejected[0].reason).toMatch(/expected shape/);
  });

  it('rejects an invalid check value, an oversized artifact and a missing one', () => {
    const invalid = planRecording([finished({ artifact: result({ ...PASSED, buildIos: 'skipped' }) })], repo());
    expect(invalid.rejected[0].reason).toMatch(/checks\.buildIos/);
    const oversized = planRecording([finished({ artifact: Buffer.alloc(5000, 0x20) })], repo());
    expect(oversized.rejected[0].reason).toMatch(/larger than/);
    const failedDownload = planRecording([finished({ artifact: null, artifactError: 'result.json is 90000 bytes, over the limit' })], repo());
    expect(failedDownload.rejected[0].reason).toMatch(/over the limit/);
    expect(planRecording([finished({ artifact: null })], repo()).rejected[0].reason).toBe('no result.json artifact');
  });

  it('checks the inputs the API reports, including the package settings', () => {
    const hostile = planRecording([finished({ buildInputs: { package: '../../etc', library_version: '2.1.3', react_native_version: '0.87.1' } })], repo());
    expect(hostile.rejected[0].reason).toMatch(/not a valid npm package name/);
    const untracked = planRecording([finished({ buildInputs: { package: 'other', library_version: '1.0.0', react_native_version: '0.87.1' } })], repo());
    expect(untracked.rejected[0].reason).toMatch(/has no settings in green-packages\.toml/);
    const numeric = planRecording([finished({ buildInputs: { package: 'example', library_version: 2.1, react_native_version: '0.87.1' } })], repo());
    expect(numeric.rejected[0].reason).toMatch(/library_version/);
  });

  it('leaves a newer cell alone when an older build is recorded', () => {
    const newer = {
      status: 'compatible',
      tested: { library: '2.1.3', reactNative: '0.87.1' },
      checks: PASSED,
      buildUrl: 'https://codemagic.io/app/app1/build/b-later',
      testedAt: '2026-09-29T11:30:00Z',
    };
    const data = repo({ results: { '0.87': newer } });
    const [planned] = planRecording([finished()], data).results; // finished 09:40, before 11:30
    const { applied, file } = applyCell(data.results, 'example', planned);
    expect(applied).toBe(false);
    expect(file.results['2.1']['0.87']).toBe(newer);
  });

  it('writes nothing for a build started with record off', () => {
    const off = finished({ buildInputs: { ...api.details['b-new'].build_inputs, record: false } });
    expect(planRecording([off], repo())).toEqual({ results: [], rejected: [] });
  });

  it('takes "none" for tests from our settings, never from the artifact', () => {
    const noTests = repo({ test: 'none' });
    const forced = planRecording([finished({ artifact: result(PASSED) })], noTests);
    expect(forced.results[0].cell.checks.tests).toBe('none');
    expect(forced.results[0].cell.status).toBe('compatible');
    const claimed = planRecording([finished({ artifact: result({ ...PASSED, tests: 'none' }) })], repo());
    expect(claimed.rejected[0].reason).toMatch(/green-packages\.toml names a test command/);
  });
});

describe('which builds the watcher looks at', () => {
  const recordedFile = repo({
    results: {
      '0.86': {
        status: 'compatible',
        tested: { library: '2.1.3', reactNative: '0.86.3' },
        checks: PASSED,
        buildUrl: 'https://codemagic.io/app/app1/build/b-recorded',
        testedAt: '2026-09-27T09:40:00Z',
      },
    },
  }).results;

  it('knows a build is recorded when a cell links to it', () => {
    expect(recordedBuildIds([recordedFile])).toEqual(new Set(['b-recorded']));
  });

  it('fetches details only for unrecorded finished builds and for busy cells', () => {
    const recorded = recordedBuildIds([recordedFile]);
    const interest = Object.fromEntries(api.list.data.map((b) => [b.id, interestOf(b, recorded, NOW)]));
    expect(interest).toEqual({
      'b-running': 'busy',
      'b-new': 'record',
      'b-failed-recent': 'busy',
      'b-recorded': null,
      'b-failed-old': null,
      'b-skipped': null,
    });
  });
});

describe('busyCells', () => {
  const unsettled = ['b-running', 'b-failed-recent', 'b-failed-old'].map((id) => {
    const d = api.details[id];
    return { status: d.status, createdAt: d.created_at, finishedAt: d.finished_at, buildInputs: d.build_inputs };
  });

  it('holds cells with a check running or failed in the last three days', () => {
    const busy = busyCells(unsettled, NOW);
    expect([...busy.entries()]).toEqual([
      [cellKey('example', '2.1.3', '0.88.0-rc.3'), 'building'],
      [cellKey('example', '2.0.0', '0.87.1'), 'failed recently'],
    ]);
  });

  it('lets a cell go again once its failure is older than three days', () => {
    const later = new Date('2026-10-01T09:06:00Z');
    expect(busyCells(unsettled, later).has(cellKey('example', '2.0.0', '0.87.1'))).toBe(false);
  });
});
