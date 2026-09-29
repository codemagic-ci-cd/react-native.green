// Parked: no workflow runs this at the moment. Builds are started by hand and each one sends its own
// result as a pull request (open-pr.mjs). It is kept, with lib/watch.mjs, lib/collect.mjs,
// lib/codemagic.mjs, lib/registry.mjs, lib/catalog-edit.mjs and their tests, for the later work on
// detecting new releases; the text below describes what it does when run.
//
// watch-releases, as it was: one run
//   1. records the results of finished compatibility-check builds (from their result.json artifact),
//   2. compares green-packages.toml with npm: a release that is not listed is a new target,
//   3. finds the cells that need a build,
//   4. commits and pushes all of that once,
//   5. starts compatibility-check builds, skipping cells whose check is running or failed recently.
// Versions are refreshed for every package in the catalog, because the site shows them; builds are
// started only for packages that are enabled and have settings.
//
//   node --experimental-strip-types scripts/compat/watch.mjs
//
// Environment: CM_API_TOKEN, CM_TEAM_ID and CM_PROJECT_ID (the app); WATCH_MAX_BUILDS (default 12);
// WATCH_DRY_RUN ("true": print the plan and write, push or start nothing; without API credentials
// the Codemagic part is skipped); COMPAT_BRANCH / CM_BRANCH (default main); COMPAT_REPO_DIR (default
// this clone).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_FILE, parseCatalogText } from './lib/catalog.mjs';
import { setVersions } from './lib/catalog-edit.mjs';
import { readJson, readRepoData, REPO_ROOT, resultsPath } from './lib/config.mjs';
import { busyCells, cellKey, interestOf, LOOKBACK_DAYS, planRecording, recordedBuildIds } from './lib/collect.mjs';
import { client as codemagicClient } from './lib/codemagic.mjs';
import { commitAndPush } from './lib/git.mjs';
import { formatJson } from './lib/json-format.mjs';
import { fail } from './lib/proc.mjs';
import { applyCell, tidyResults } from './lib/record.mjs';
import { fetchPackument } from './lib/registry.mjs';
import { readResultsFiles, validateData } from './lib/validate.mjs';
import { buildRequest, orderAndCut, refreshPackage, refreshReactNative, staleCells } from './lib/watch.mjs';

const env = process.env;
const dryRun = env.WATCH_DRY_RUN === 'true';
const maxBuilds = Number(env.WATCH_MAX_BUILDS ?? 12);
if (!Number.isInteger(maxBuilds) || maxBuilds < 0) fail('WATCH_MAX_BUILDS must be a whole number, 0 or more.');
const repoDir = env.COMPAT_REPO_DIR ?? REPO_ROOT;
const branch = env.COMPAT_BRANCH ?? env.CM_BRANCH ?? 'main';
const xcodeByLine = readJson(new URL('./xcode-versions.json', import.meta.url));
const say = (line = '') => process.stdout.write(`${line}\n`);
const now = new Date();

const hasApi = Boolean(env.CM_API_TOKEN && env.CM_TEAM_ID && env.CM_PROJECT_ID);
if (!hasApi && !dryRun) fail('CM_API_TOKEN, CM_TEAM_ID and CM_PROJECT_ID are needed.');
const api = hasApi ? codemagicClient({ token: env.CM_API_TOKEN, teamId: env.CM_TEAM_ID, appId: env.CM_PROJECT_ID }) : null;

let repoData;
try {
  repoData = readRepoData(repoDir);
} catch (error) {
  fail(error.message);
}

// ---- 1. What past builds tell us (the Codemagic API) ----
let recording = { results: [], rejected: [] };
let busy = new Map();
if (api) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const listed = await api.listBuilds({ workflowId: 'compatibility-check', since });
  const recorded = recordedBuildIds(readResultsFiles(repoDir).map((r) => r.data));
  const finished = [];
  const unsettled = [];
  for (const build of listed) {
    const interest = interestOf(build, recorded, now);
    if (!interest) continue;
    const detail = await api.getBuild(build.id);
    if (interest === 'busy') {
      unsettled.push({ status: detail.status, createdAt: detail.created_at, finishedAt: detail.finished_at, buildInputs: detail.build_inputs });
      continue;
    }
    let artifact = null;
    let artifactError;
    try {
      artifact = await api.downloadResult(detail);
    } catch (error) {
      artifactError = error.message;
    }
    finished.push({ id: detail.id, appId: detail.app_id, finishedAt: detail.finished_at, buildInputs: detail.build_inputs, artifact, artifactError });
  }
  recording = planRecording(finished, repoData);
  busy = busyCells(unsettled, now);
  say(`Looked at ${listed.length} compatibility-check builds from the last ${LOOKBACK_DAYS} days.`);
} else {
  say('No Codemagic credentials: finished builds are not recorded and running builds are not checked (dry run).');
}

// ---- 2. The catalog and results after this run ----
const npm = new Map(); // packuments are fetched once and reused if the push has to be retried
const packument = async (name) => {
  if (!npm.has(name)) npm.set(name, await fetchPackument(name));
  return npm.get(name);
};

/** Recording and the npm comparison applied to the files in `dir`; returns what changes. */
async function nextState(dir) {
  const text = readFileSync(join(dir, CATALOG_FILE), 'utf8');
  const before = parseCatalogText(text);
  if (!before.ok) throw new Error(`green-packages.toml is invalid:\n${before.errors.join('\n')}`);

  let catalogText = text;
  const versionChanges = [];
  const reactNative = refreshReactNative(
    before.value.reactNative.map((rn) => rn.version),
    await packument('react-native'),
  );
  if (reactNative.changes.length > 0) {
    catalogText = setVersions(catalogText, 'react-native', reactNative.versions);
    versionChanges.push(...reactNative.changes);
  }
  for (const pkg of before.value.packages) {
    const refreshed = refreshPackage(pkg.name, pkg.lines.map((l) => l.version), await packument(pkg.name));
    if (refreshed.changes.length === 0) continue;
    catalogText = setVersions(catalogText, pkg.name, refreshed.versions);
    versionChanges.push(...refreshed.changes);
  }
  const after = parseCatalogText(catalogText);
  if (!after.ok) throw new Error(`the refreshed green-packages.toml is invalid:\n${after.errors.join('\n')}`);
  const catalog = after.value;

  // Results: apply what finished builds reported, then write only the lines the catalog lists.
  const readResults = (name) => {
    const path = join(dir, resultsPath(name));
    return existsSync(path) ? readJson(path) : undefined;
  };
  const changed = new Map(); // package name -> results file after this run
  let recorded = 0;
  for (const result of recording.results) {
    const applied = applyCell(changed.get(result.package) ?? readResults(result.package), result.package, result);
    if (!applied.applied) continue;
    recorded += 1;
    changed.set(result.package, applied.file);
  }
  const files = catalogText === text ? [] : [{ path: CATALOG_FILE, content: catalogText }];
  const rnLines = catalog.reactNative.map((rn) => rn.line);
  for (const [name, file] of changed) {
    const entry = catalog.packages.find((p) => p.name === name);
    const content = formatJson(tidyResults(file, entry.lines.map((l) => l.line), rnLines));
    const path = join(dir, resultsPath(name));
    // A result on a line the catalog no longer lists is dropped again, which may leave nothing to write.
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) files.push({ path: resultsPath(name), content });
  }

  const results = new Map(catalog.packages.map((p) => [p.name, readResults(p.name)]));
  for (const file of files) {
    if (file.path !== CATALOG_FILE) results.set(JSON.parse(file.content).package, JSON.parse(file.content));
  }
  return { catalogText, catalog, versionChanges, recorded, files, results };
}

const planned = await nextState(repoDir);
const validationInput = (state) => ({
  catalogText: state.catalogText,
  results: [...state.results].filter(([, data]) => data).map(([name, data]) => ({ file: resultsPath(name), data })),
});
await validateData(validationInput(planned)).catch((error) =>
  fail(`The data after this run would not pass the site's validation:\n${error.message}`),
);

if (dryRun) say('Dry run: nothing is written, pushed or started.');
say();
say(`Finished builds with a result (${recording.results.length}; ${planned.recorded} newer than the cell they belong to):`);
for (const r of recording.results) say(`  ${r.package} ${r.cell.tested.library} on React Native ${r.cell.tested.reactNative}: ${r.cell.status} (build ${r.buildId})`);
if (recording.results.length === 0) say('  none');
if (recording.rejected.length > 0) {
  say(`Builds not recorded (${recording.rejected.length}):`);
  for (const r of recording.rejected) say(`  build ${r.buildId}: ${r.reason}`);
}
say(`Version changes (${planned.versionChanges.length}):`);
for (const change of planned.versionChanges) say(`  ${change}`);
if (planned.versionChanges.length === 0) say('  none');

const notChecked = planned.catalog.packages
  .filter((p) => !p.settings || !p.enabled)
  .map((p) => ({ name: p.name, why: !p.settings ? 'no settings' : 'disabled' }));
if (notChecked.length > 0) {
  say(`Packages not checked (${notChecked.length}):`);
  for (const p of notChecked) say(`  ${p.name}: ${p.why}`);
}

// ---- 4. One commit for the results and the version changes ----
if (!dryRun && planned.files.length > 0) {
  const parts = [
    ...(planned.recorded > 0 ? [`record ${planned.recorded} result${planned.recorded === 1 ? '' : 's'}`] : []),
    ...(planned.versionChanges.length > 0 ? ['add new releases from npm'] : []),
  ];
  const outcome = await commitAndPush({
    repoDir,
    branch,
    message: `compat: ${parts.join(', ') || 'update data'} [skip ci]`,
    // Recomputed on every attempt, so the change always applies to the newest branch state.
    apply: async (dir) => {
      const fresh = await nextState(dir);
      if (fresh.files.length === 0) return null;
      await validateData(validationInput(fresh));
      return fresh.files;
    },
  }).catch((error) => fail(`Could not push: ${error.message}`));
  say(outcome.pushed ? `Pushed to ${branch}.` : 'The branch already had these changes.');
}

// ---- 3 and 5. Cells to build, and starting them ----
const checked = planned.catalog.packages.filter((p) => p.settings && p.enabled);
const keyOf = (cell) => cellKey(cell.package, cell.libraryVersion, cell.reactNativeVersion);
const stale = checked.flatMap((p) => staleCells(p, planned.catalog.reactNative, planned.results.get(p.name)));
const cells = stale.filter((cell) => !busy.has(keyOf(cell)));
const held = stale.filter((cell) => busy.has(keyOf(cell)));
const { start, later } = orderAndCut(cells, maxBuilds);
const nodeByName = new Map(checked.map((p) => [p.name, p.settings.node]));

say();
say(`Cells to build now (${start.length} of ${cells.length}):`);
for (const cell of start) say(`  ${cell.package} ${cell.libraryVersion} on React Native ${cell.reactNativeVersion}  (${cell.reason})`);
if (!dryRun) {
  for (const cell of start) {
    const build = await api.startBuild(buildRequest(cell, { branch, xcodeByLine, node: nodeByName.get(cell.package) }));
    say(`    started ${build?.id ?? '(no id returned)'}`);
  }
}
if (held.length > 0) {
  say(`Not started, a check is running or failed recently (${held.length}):`);
  for (const cell of held) say(`  ${cell.package} ${cell.libraryVersion} on React Native ${cell.reactNativeVersion}: ${busy.get(keyOf(cell))}`);
}
const SHOWN = 20;
say(`Left for the next run (${later.length}):`);
for (const cell of later.slice(0, SHOWN)) say(`  ${cell.package} ${cell.libraryVersion} on React Native ${cell.reactNativeVersion}`);
if (later.length > SHOWN) say(`  ... and ${later.length - SHOWN} more`);
if (later.length === 0) say('  none');
