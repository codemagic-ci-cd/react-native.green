// Step 2 of compatibility-check: check the library out at its release tag, outside the repository.
// The repository and the tag pattern come from the package's entry in green-packages.toml.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tagFor } from './lib/catalog.mjs';
import { libraryDir, outDir, readRepoData, workDir } from './lib/config.mjs';
import { readInputs } from './lib/library.mjs';
import { capture, fail, run } from './lib/proc.mjs';

const inputs = readInputs();
const repository = readRepoData().catalog.packages.find((p) => p.name === inputs.package).repository;
const tag = tagFor(inputs.settings, inputs.libraryVersion);
const env = { GIT_TERMINAL_PROMPT: '0' };

const remote = await capture('git', ['ls-remote', '--tags', repository, `refs/tags/${tag}`], { env });
if (remote.code !== 0) fail(`Could not list the tags of ${repository}.`);
if (!remote.stdout.split('\n').some((line) => line.endsWith(`\trefs/tags/${tag}`))) {
  fail(`${repository} has no tag ${tag} (source.tag "${inputs.settings.tag}" in green-packages.toml).`);
}

mkdirSync(workDir(), { recursive: true });
rmSync(libraryDir(), { recursive: true, force: true });
const code = await run(
  'git',
  ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', tag, repository, libraryDir()],
  { env, log: join(outDir(), 'logs', 'checkout.log') },
);
if (code !== 0) fail(`Could not check out ${repository} at ${tag}.`);
process.stdout.write(`Checked out ${repository} at ${tag} into ${libraryDir()}.\n`);
