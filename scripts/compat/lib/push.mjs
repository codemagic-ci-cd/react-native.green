// Pushing to the repository with GITHUB_TOKEN, shared by check-token.mjs (the workflow's first step)
// and open-pr.mjs (its last). check-token.mjs runs before `npm ci`, so this module and what it
// imports use Node's own modules only.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPushFailure, credentialArgs, deniedMessage, ISOLATED_GIT_ARGS, ISOLATED_GIT_ENV, redact } from './git.mjs';
import { pickRepository } from './github.mjs';
import { capture, captureAll, run } from './proc.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The branch the early write check aims at. Package branches come from branchFor, which never has
 * capital letters (npm names are lowercase), so no package can have this one.
 */
export const WRITE_CHECK_BRANCH = 'compat/WRITE-CHECK';

/**
 * git with the token available through the credential helper, and nothing from the machine's git
 * configuration: `run` streams its output, `out` captures stdout, `all` keeps stdout and stderr to be
 * read, with the token taken out in case any tool echoes it.
 */
export function tokenGit(env = process.env) {
  const args = (rest) => [...ISOLATED_GIT_ARGS, ...credentialArgs(env), ...rest];
  const options = (cwd) => ({ cwd, env: { ...ISOLATED_GIT_ENV }, secrets: true });
  return {
    run: (rest, cwd) => run('git', args(rest), options(cwd)),
    out: (rest, cwd) => capture('git', args(rest), options(cwd)),
    all: async (rest, cwd) => {
      const result = await captureAll('git', args(rest), options(cwd));
      return { code: result.code, output: redact(result.output, env.GITHUB_TOKEN).trim() };
    },
  };
}

/**
 * The repository the result goes to (COMPAT_REPOSITORY, else CM_REPO_SLUG, else the origin remote)
 * and the URL to push to (COMPAT_REMOTE_URL, for local trials, else github.com).
 * @returns {Promise<{ fullName: string, source: string, remote: string } | { error: string }>}
 */
export async function pushTarget(env = process.env) {
  const picked = await pickRepository(env, async () => {
    const origin = await capture('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
    return origin.code === 0 ? origin.stdout : null;
  });
  if (picked.error) return picked;
  return { fullName: picked.slug, source: picked.source, remote: env.COMPAT_REMOTE_URL || `https://github.com/${picked.slug}.git` };
}

/** A push the remote refused; trying again cannot help. */
export class PushDenied extends Error {}

/**
 * Judges a push from git's exit code and output: false when it landed, true when the branch only
 * moved (start again). Throws PushDenied when the remote refused the token, and an Error with git's
 * own message for anything else. `say` prints git's lines before a refusal.
 */
export function judgePush({ code, output }, { what, repository, say = () => {} }) {
  if (code === 0) return false;
  const failure = classifyPushFailure(output);
  if (failure.kind === 'moved') return true;
  if (failure.kind === 'denied') {
    if (output) say(output);
    throw new PushDenied(deniedMessage(repository, failure.account));
  }
  throw new Error(`${what} failed; git said:\n${output || '(nothing)'}`);
}

/**
 * Checks that the token may write, without changing anything: a dry run of pushing the commit at
 * HEAD of `cwd` to `branch` reaches the remote's receive-pack with the token, which refuses exactly as
 * a real push would. Throws as judgePush does.
 */
export async function checkWriteAccess(git, { remote, branch, cwd, repository, say }) {
  const result = await git.all(['push', '--dry-run', '--force', '--quiet', remote, `HEAD:refs/heads/${branch}`], cwd);
  judgePush(result, { what: 'The write check', repository, say });
}
