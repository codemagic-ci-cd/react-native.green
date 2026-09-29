// Where the compatibility scripts read and write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog } from './catalog.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = 'compatibility-data';

/** The library is checked out and built here, outside the repository clone. */
export function workDir(env = process.env) {
  return resolve(env.COMPAT_WORK_DIR ?? join(homedir(), 'rn-green-compat-work'));
}

/** Logs, check outcomes and the result: kept as build artifacts. */
export function outDir(env = process.env) {
  return resolve(env.COMPAT_OUT_DIR ?? join(REPO_ROOT, 'compat-results'));
}

export const libraryDir = (env) => join(workDir(env), 'library');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** compatibility-data/<package>/compatibility.json, repository-relative. */
export const resultsPath = (name) => `${DATA_DIR}/${name}/compatibility.json`;

/**
 * The validated catalog of a clone, and its results files. Throws when the catalog is invalid.
 * `resultsFile(name)` is the raw results file, or undefined when the package has none yet. Only call
 * it with a name from the catalog: the name becomes part of a path.
 */
export function readRepoData(repoRoot = REPO_ROOT) {
  const catalog = readCatalog(repoRoot);
  if (!catalog.ok) throw new Error(`green-packages.toml is invalid:\n${catalog.errors.map((e) => `  - ${e}`).join('\n')}`);
  return {
    catalog: catalog.value,
    resultsFile: (name) => {
      const path = join(repoRoot, resultsPath(name));
      return existsSync(path) ? readJson(path) : undefined;
    },
  };
}
