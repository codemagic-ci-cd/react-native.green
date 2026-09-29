// Last step of compatibility-check: send the result to the repository as a pull request.
//
// One open pull request per package, from the branch compat/<package> (see lib/pull-request.mjs). The
// branch is rebuilt on each result as the base branch plus one commit holding every result the base
// branch does not have, and pushed with a lease on the tip that was read, so a build that finishes at
// the same moment makes this one start again instead of being overwritten.
//
// The package and versions come from the build's inputs, checked again here against the base
// branch's catalog; from compat-results/result.json only the three outcomes are taken, read strictly.
//
//   node --experimental-strip-types scripts/compat/open-pr.mjs
//
// Environment: GITHUB_TOKEN (group default); the COMPAT_* inputs; COMPAT_REPOSITORY (owner/name, set
// in codemagic.yaml), else CM_REPO_SLUG, else the origin remote; COMPAT_BRANCH / CM_BRANCH (default
// main); CM_PROJECT_ID and CM_BUILD_ID for the build link; COMPAT_REMOTE_URL to push somewhere other
// than github.com (local trials).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseResultArtifact, MAX_RESULT_BYTES, RESULT_FILE } from './lib/artifact.mjs';
import { CATALOG_FILE, parseCatalogText } from './lib/catalog.mjs';
import { outDir, REPO_ROOT, resultsPath } from './lib/config.mjs';
import { AUTHOR, classifyPushFailure, credentialArgs, deniedMessage, ISOLATED_GIT_ARGS, ISOLATED_GIT_ENV, redact } from './lib/git.mjs';
import { client, ensurePull, pickRepository } from './lib/github.mjs';
import { validateCheckInputs } from './lib/inputs.mjs';
import { formatJson } from './lib/json-format.mjs';
import { capture, captureAll, fail, run } from './lib/proc.mjs';
import { branchFor, changedCells, bodyFor, nextResultsFile, titleFor } from './lib/pull-request.mjs';
import { buildUrlFor, composeCell, timestamp } from './lib/record.mjs';
import { validateData } from './lib/validate.mjs';

const ATTEMPTS = 5;
const env = process.env;
const say = (line = '') => process.stdout.write(`${line}\n`);

// COMPAT_RECORD=false exists for local runs only; the workflow has no way to set it.
if (env.COMPAT_RECORD === 'false') {
  say('COMPAT_RECORD is off: no pull request is opened and nothing is pushed.');
  process.exit(0);
}
if (!env.GITHUB_TOKEN) fail('GITHUB_TOKEN is not set. Add the variable group `default` to the workflow (see the README, "Credentials").');

// ---- The outcomes, read strictly ----
const resultPath = join(outDir(), RESULT_FILE);
if (!existsSync(resultPath)) fail(`There is no ${RESULT_FILE}; the result was not saved.`);
if (statSync(resultPath).size > MAX_RESULT_BYTES) fail(`${RESULT_FILE} is larger than ${MAX_RESULT_BYTES} bytes.`);
const parsed = parseResultArtifact(readFileSync(resultPath));
if (!parsed.ok) fail(`${RESULT_FILE} is not usable: ${parsed.reason}`);
const testedAt = timestamp();
const buildUrl = env.CM_PROJECT_ID && env.CM_BUILD_ID ? buildUrlFor(env.CM_PROJECT_ID, env.CM_BUILD_ID) : undefined;

// ---- Where to send it ----
const gitEnv = { ...ISOLATED_GIT_ENV };
/** git with the token available through the credential helper, and nothing from the machine's git configuration. */
const git = (args, cwd) => run('git', [...ISOLATED_GIT_ARGS, ...credentialArgs(env), ...args], { cwd, env: gitEnv, secrets: true });
const gitOut = (args, cwd) => capture('git', [...ISOLATED_GIT_ARGS, ...credentialArgs(env), ...args], { cwd, env: gitEnv, secrets: true });
/** Like git, but keeps its output (stdout and stderr) to be read, with the token taken out in case any tool echoes it. */
const gitAll = async (args, cwd) => {
  const result = await captureAll('git', [...ISOLATED_GIT_ARGS, ...credentialArgs(env), ...args], { cwd, env: gitEnv, secrets: true });
  return { code: result.code, output: redact(result.output, env.GITHUB_TOKEN).trim() };
};

const picked = await pickRepository(env, async () => {
  const origin = await capture('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
  return origin.code === 0 ? origin.stdout : null;
});
if (picked.error) fail(picked.error);
// The name is used as given, for every API call and for the push.
const fullName = picked.slug;
const api = client({ token: env.GITHUB_TOKEN });
say(`Sending the result to ${fullName} (from ${picked.source}).`);
const remote = env.COMPAT_REMOTE_URL || `https://github.com/${fullName}.git`;

const base = env.COMPAT_BRANCH || env.CM_BRANCH || 'main';
if ((await capture('git', ['check-ref-format', '--branch', base])).code !== 0) fail('The base branch name is not a valid branch name.');

const inputs = {
  package: env.COMPAT_PACKAGE,
  libraryVersion: env.COMPAT_LIBRARY_VERSION,
  reactNativeVersion: env.COMPAT_REACT_NATIVE_VERSION,
  record: 'true',
};

/** A push the remote refused; trying again cannot help. */
class PushDenied extends Error {}

/** Throws for a failed push unless the branch only moved; returns true when it did. */
function judgePush({ code, output }, what) {
  if (code === 0) return false;
  const failure = classifyPushFailure(output);
  if (failure.kind === 'moved') return true;
  if (failure.kind === 'denied') {
    if (output) say(output);
    throw new PushDenied(deniedMessage(fullName, failure.account));
  }
  throw new Error(`${what} failed; git said:\n${output || '(nothing)'}`);
}

let writeChecked = false;

/**
 * One attempt on a fresh clone of the base branch.
 * @returns {Promise<{ pushed: boolean, branch: string, title?: string, body?: string, name: string }>}
 *   pushed false with a title means the push was rejected; without one, there was nothing to send
 */
async function attempt(dir) {
  if ((await git(['clone', '--quiet', '--template=', '--depth', '1', '--single-branch', '--no-tags', '--branch', base, remote, dir])) !== 0) {
    throw new Error(`could not clone ${base}`);
  }

  // The inputs, checked again against the catalog of the branch the result goes to, with the workflow's rules.
  const catalogText = readFileSync(join(dir, CATALOG_FILE), 'utf8');
  const catalog = parseCatalogText(catalogText, CATALOG_FILE);
  if (!catalog.ok) throw new Error(`${CATALOG_FILE} on ${base} is invalid:\n${catalog.errors.join('\n')}`);
  const checked = validateCheckInputs(inputs, { catalog: catalog.value });
  if (!checked.ok) throw new Error(`the inputs do not name a cell of ${CATALOG_FILE} on ${base}:\n${checked.errors.map((e) => `  - ${e}`).join('\n')}`);
  const cellInputs = checked.value;

  // The catalog decides whether the library has tests, not result.json.
  const checks = { ...parsed.checks };
  if (cellInputs.settings.test === 'none') checks.tests = 'none';
  else if (checks.tests === 'none') throw new Error(`${RESULT_FILE} says tests "none", but ${CATALOG_FILE} names a test command.`);

  const name = cellInputs.package;
  const branch = branchFor(name);
  const file = resultsPath(name);
  const entry = catalog.value.packages.find((p) => p.name === name);

  // Can the token write? A dry run of pushing the base commit to the package's branch reaches the
  // remote's receive-pack with the token and changes nothing, so a refusal shows before any work.
  if (!writeChecked) {
    judgePush(await gitAll(['push', '--dry-run', '--force', '--quiet', remote, `HEAD:refs/heads/${branch}`], dir), 'The write check');
    writeChecked = true;
  }
  const readBase = () => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : undefined);
  const baseFile = readBase();

  // The package's branch as it is now, if it exists. Its tip is the lease: the push only lands if
  // nobody moved the branch since.
  const listed = await gitOut(['ls-remote', remote, `refs/heads/${branch}`], dir);
  if (listed.code !== 0) throw new Error(`could not list ${branch}`);
  let tip = '';
  let branchFile;
  if (listed.stdout.trim() !== '') {
    if ((await git(['fetch', '--quiet', '--depth', '1', '--no-tags', remote, `refs/heads/${branch}`], dir)) !== 0) {
      throw new Error(`could not fetch ${branch}`);
    }
    tip = (await gitOut(['rev-parse', 'FETCH_HEAD'], dir)).stdout.trim();
    const shown = await gitOut(['show', `FETCH_HEAD:${file}`], dir);
    if (shown.code === 0) {
      try {
        const data = JSON.parse(shown.stdout);
        await validateData({ catalogText, results: [{ file, data }] });
        branchFile = data;
      } catch (error) {
        say(`The results file on ${branch} is not valid, so its cells are not carried forward:\n${error.message}`);
      }
    }
  }

  const next = nextResultsFile({
    name,
    base: baseFile,
    branch: branchFile,
    result: {
      libraryLine: cellInputs.libraryLine,
      reactNativeLine: cellInputs.reactNativeLine,
      cell: composeCell({ checks, library: cellInputs.libraryVersion, reactNative: cellInputs.reactNativeVersion, testedAt, buildUrl }),
    },
    libraryLines: entry.lines.map((l) => l.line),
    reactNativeLines: catalog.value.reactNative.map((rn) => rn.line),
  });
  const cells = changedCells(baseFile, next);
  if (cells.length === 0) return { pushed: false, branch, name };
  await validateData({ catalogText, results: [{ file, data: next }] });

  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), formatJson(next));
  const title = titleFor(name, cells.length);
  if ((await git(['add', '--', file], dir)) !== 0) throw new Error('git add failed');
  if ((await git([...AUTHOR, 'commit', '--quiet', '--no-verify', '-m', title], dir)) !== 0) throw new Error('git commit failed');
  const pushed = await gitAll(['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${tip}`, remote, `HEAD:refs/heads/${branch}`], dir);
  const moved = judgePush(pushed, 'The push');
  return { pushed: !moved, branch, name, title, body: bodyFor(name, cells, base), cells: cells.length };
}

let outcome;
for (let n = 1; n <= ATTEMPTS && !outcome; n += 1) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-green-pr-'));
  let tried;
  try {
    tried = await attempt(dir);
  } catch (error) {
    tried = { error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (tried.error instanceof PushDenied) fail(tried.error.message);
  if (tried.error) fail(`Could not send the result: ${tried.error.message}`);
  if (tried.pushed || !tried.title) outcome = tried;
  else if (n < ATTEMPTS) {
    const wait = 1000 + Math.floor(Math.random() * 4000);
    say(`The branch ${tried.branch} moved while this result was prepared (attempt ${n} of ${ATTEMPTS}); starting again in ${wait} ms.`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
if (!outcome) fail(`Gave up: the branch moved during each of ${ATTEMPTS} attempts.`);

if (!outcome.pushed) {
  say(`${base} already has this result; nothing to send.`);
  process.exit(0);
}
say(`Pushed ${outcome.branch}: ${base} plus one commit with ${outcome.cells} result${outcome.cells === 1 ? '' : 's'}.`);
const pull = await ensurePull(api, fullName, { branch: outcome.branch, base, title: outcome.title, body: outcome.body }).catch((error) =>
  fail(`The branch was pushed, but the pull request could not be opened or updated: ${error.message}`),
);
say(`${pull.created ? 'Opened' : 'Updated'} pull request ${pull.url}`);
