// First step of compatibility-check: check that GITHUB_TOKEN may push to the repository the result
// will go to, so a token that cannot fails in seconds instead of after the checks. It runs before
// `npm ci` and before any library code is on the machine, so it uses Node's own modules only (see
// lib/push.mjs).
// open-pr.mjs checks again at the end, because the token can change or expire during a long build.
//
// The check is a dry run of pushing an empty commit, made in a temporary folder, to a branch no package
// uses (WRITE_CHECK_BRANCH). Nothing is created on the remote.
//
// Environment: GITHUB_TOKEN; COMPAT_REPOSITORY, else CM_REPO_SLUG, else the origin remote;
// COMPAT_REMOTE_URL for local trials; COMPAT_RECORD=false (local runs only) skips the check.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTHOR } from './lib/git.mjs';
import { fail } from './lib/proc.mjs';
import { checkWriteAccess, pushTarget, PushDenied, tokenGit, WRITE_CHECK_BRANCH } from './lib/push.mjs';

const env = process.env;
const say = (line = '') => process.stdout.write(`${line}\n`);

if (env.COMPAT_RECORD === 'false') {
  say('COMPAT_RECORD is off: no pull request will be opened, so the token is not checked.');
  process.exit(0);
}
if (!env.GITHUB_TOKEN) fail('GITHUB_TOKEN is not set. Add the variable group `default` to the workflow (see the README, "Credentials").');

const target = await pushTarget(env);
if (target.error) fail(target.error);

const git = tokenGit(env);
const dir = mkdtempSync(join(tmpdir(), 'rn-green-token-'));
let problem;
try {
  if ((await git.run(['init', '--quiet', '--template=', dir])) !== 0) throw new Error('git init failed');
  if ((await git.run([...AUTHOR, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'write check'], dir)) !== 0) {
    throw new Error('git commit failed');
  }
  await checkWriteAccess(git, { remote: target.remote, branch: WRITE_CHECK_BRANCH, cwd: dir, repository: target.fullName, say });
} catch (error) {
  problem = error;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (problem instanceof PushDenied) fail(problem.message);
if (problem) fail(`Could not check the token: ${problem.message}`);
say(`The token may push to ${target.fullName} (from ${target.source}).`);
