// Facts about the checked-out library that several steps need. Paths come from the package's
// settings in green-packages.toml (saved in inputs.json by validate-inputs.mjs).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { libraryDir, outDir, readJson, workDir } from './config.mjs';
import { nodeDir } from './node-dist.mjs';

/** The validated inputs, with the package's settings from the catalog. */
export function readInputs(env = process.env) {
  return readJson(join(outDir(env), 'inputs.json'));
}

/** A folder of the checked-out repository, from a settings path such as "." or "apps/fabric-example". */
export function repoPath(relative, env = process.env) {
  return relative === '.' ? libraryDir(env) : join(libraryDir(env), relative);
}

/** Native folders present means a bare app; otherwise an `expo` dependency means Expo. */
export function detectDemoKind(demoPath, manifest) {
  if (existsSync(join(demoPath, 'android')) && existsSync(join(demoPath, 'ios'))) return 'bare';
  if (manifest.dependencies?.expo || manifest.devDependencies?.expo) return 'expo';
  return null;
}

/**
 * The package manager used in a folder: its package.json's `packageManager`, else its lockfile,
 * else npm. Each install folder is judged on its own (some demos use another manager than the root).
 */
export function packageManager(dir) {
  const manifestPath = join(dir, 'package.json');
  const declared = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).packageManager : undefined;
  const named = /^(npm|pnpm|yarn)@/.exec(declared ?? '')?.[1];
  if (named) return named;
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

/** Commands to install and to run a package binary with that package manager. */
export function commands(manager) {
  switch (manager) {
    case 'yarn':
      return { install: ['yarn', ['install']], exec: (bin, args) => ['yarn', [bin, ...args]] };
    case 'pnpm':
      return { install: ['pnpm', ['install', '--no-frozen-lockfile']], exec: (bin, args) => ['pnpm', ['exec', bin, ...args]] };
    default:
      return { install: ['npm', ['install']], exec: (bin, args) => ['npx', ['--no-install', bin, ...args]] };
  }
}

/**
 * Environment for every command that runs library code: the package's own settings, then ours.
 * Corepack shims live in the work folder so each folder's declared package manager is used without
 * touching the machine's global install. The Node that setup.node asks for, when the install step
 * downloaded one, comes first. Lockfile changes are expected after the swap, so installs are never
 * immutable.
 */
export function toolEnv(settings, env = process.env) {
  const bin = join(workDir(env), 'bin');
  mkdirSync(bin, { recursive: true });
  const nodeBin = join(nodeDir(workDir(env)), 'bin');
  const first = existsSync(nodeBin) ? [nodeBin, bin] : [bin];
  return {
    ...settings.env,
    PATH: [...first, env.PATH ?? ''].join(delimiter),
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_GIT_STATUS: '1',
  };
}
