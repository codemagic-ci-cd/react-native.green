// git for the scripts that write to the repository: open-pr.mjs, and commitAndPush below for the
// parked watcher.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture, run } from './proc.mjs';

export const AUTHOR = ['-c', 'user.name=rn.green bot', '-c', 'user.email=rn-green-bot@users.noreply.github.com'];

/**
 * Environment and arguments for git calls that hold the token. The library's own code ran earlier on
 * the same machine and could have changed the user's or the system's git configuration (a credential
 * helper, hooks, templates), so git reads neither, runs no hooks and never prompts. This narrows what
 * planted configuration can do; it is not isolation from a machine the library ran on.
 */
export const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
export const ISOLATED_GIT_ARGS = ['-c', 'core.hooksPath=/dev/null'];

/**
 * git arguments that supply GITHUB_TOKEN to github.com without writing it anywhere: the helper reads
 * the variable when git asks, so the token is never in a URL, in .git/config or in the log.
 */
export function credentialArgs(env) {
  if (!env.GITHUB_TOKEN) return [];
  return [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f',
  ];
}

/** The remote to fetch and push: an explicit URL, else github.com for the Codemagic app, else origin. */
export function remoteFor(env) {
  if (env.COMPAT_REMOTE_URL) return env.COMPAT_REMOTE_URL;
  if (env.CM_REPO_SLUG && /^[\w.-]+\/[\w.-]+$/.test(env.CM_REPO_SLUG)) return `https://github.com/${env.CM_REPO_SLUG}.git`;
  return 'origin';
}

/**
 * Commits a small data change to a shared branch. Many runs push to the same branch at about the same
 * time, so the change is expressed as a function that is re-applied to a fresh checkout until a push
 * lands. Used by the parked watcher (watch.mjs).
 * @param {object} options
 * @param {string} options.repoDir     a clone of the data repository (its working tree is reset)
 * @param {string} options.branch
 * @param {(repoDir: string) => Promise<Array<{ path: string, content: string }> | null>} options.apply
 *   computes the files to write from the fresh checkout, validating them; null means nothing to do
 * @param {string} options.message
 * @returns {Promise<{ pushed: boolean, attempts: number }>}
 */
export async function commitAndPush({ repoDir, branch, apply, message, env = process.env, attempts = 5, log }) {
  const remote = remoteFor(env);
  const git = (args, secrets = false) => run('git', [...credentialArgs(secrets ? env : {}), ...args], { cwd: repoDir, log, secrets });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if ((await git(['fetch', '--quiet', remote, branch], true)) !== 0) throw new Error(`could not fetch ${branch}`);
    if ((await git(['reset', '--quiet', '--hard', 'FETCH_HEAD'])) !== 0) throw new Error('could not reset to the fetched branch');

    const files = await apply(repoDir);
    if (!files) return { pushed: false, attempts: attempt };
    for (const file of files) writeFileSync(join(repoDir, file.path), file.content);

    if ((await git(['add', '--', ...files.map((f) => f.path)])) !== 0) throw new Error('git add failed');
    const staged = await capture('git', ['diff', '--cached', '--name-only'], { cwd: repoDir });
    if (staged.stdout.trim() === '') return { pushed: false, attempts: attempt };
    if ((await git([...AUTHOR, 'commit', '--quiet', '--no-verify', '-m', message])) !== 0) throw new Error('git commit failed');

    if ((await git(['push', '--quiet', remote, `HEAD:refs/heads/${branch}`], true)) === 0) {
      return { pushed: true, attempts: attempt };
    }
    // Someone else pushed first. Wait a moment, then start again from their commit.
    const wait = 1000 + Math.floor(Math.random() * 4000);
    process.stdout.write(`Push rejected (attempt ${attempt} of ${attempts}); retrying in ${wait} ms.\n`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error(`gave up after ${attempts} rejected pushes`);
}
