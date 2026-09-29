// The catalog, green-packages.toml: which packages are covered, which versions are checked, and how
// each package is tested and built. The workflows and the site both validate it with this module.
//
// Plain JavaScript on purpose: compatibility-check may run on a Node version without type stripping,
// and the site imports the same module, so there is one validator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { compareLines, lineOf, parseVersion, SEMVER, MAX_VERSION_LENGTH } from './semver.mjs';

export const CATALOG_FILE = 'green-packages.toml';

/**
 * Top-level outputs of the site itself, which a package page at /<name>/ must not collide with:
 * the files in public/ and the pages in src/pages/ as built. A site test compares this list with
 * those folders, so adding a page or a public file without listing it here fails `npm test`.
 */
export const RESERVED_NAMES = new Set(['404.html', 'index.html', 'favicon.svg', 'badge']);

// npm's naming rules: lowercase, URL-safe, optionally scoped, at most 214 characters, and no leading
// hyphen ("npm install -rf@1.3" would be read as an option).
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** @param {unknown} name */
export function isPackageName(name) {
  return typeof name === 'string' && name.length <= 214 && PACKAGE_NAME.test(name) && !name.startsWith('-');
}

/**
 * @typedef {{ dir: string, run: string[] }} Step
 * @typedef {{
 *   tag: string, packageDir: string, demoApp: string, installs: string[], prepare: Step[],
 *   test: Step | 'none', ios?: { scheme: string }, env: Record<string, string>, node?: string
 * }} Settings
 *   How compatibility-check checks a package. The check scripts read this from inputs.json.
 * @typedef {{ line: string, version: string, channel: 'stable' | 'rc' }} CatalogReactNative
 * @typedef {{ line: string, version: string }} CatalogLine
 * @typedef {{
 *   name: string, repository: string, description?: string, license?: string, enabled: boolean,
 *   lines: CatalogLine[], settings: Settings | null
 * }} CatalogPackage
 *   `lines` is newest first. `settings` is null for a package that is listed and never checked.
 * @typedef {{ reactNative: CatalogReactNative[], packages: CatalogPackage[] }} Catalog
 *   `reactNative` is ascending; `packages` is sorted by name.
 */

const FORBIDDEN_ENV = new Set(['GITHUB_TOKEN', 'CM_API_TOKEN', 'PATH', 'HOME']);

/** A relative path inside the repository: no absolute paths, no "..", no empty segments. */
function isInsidePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false;
  if (path === '.') return true;
  if (path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '..' && segment !== '.' && /^[\w@.+-]+$/.test(segment));
}

const isCommand = (run) =>
  Array.isArray(run) &&
  run.length > 0 &&
  run.length <= 20 &&
  run.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= 200 && !arg.includes('\0'));

const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * Keys such as "@scope/name" or "ios-scheme" in brackets, the rest dotted. A package is always named
 * in brackets (passed as { name }), so package["example"] reads the same as package["@scope/x"].
 */
function formatPath(path) {
  return path
    .map((key, i) => {
      if (typeof key === 'number') return `[${key}]`;
      if (typeof key === 'object') return `[${JSON.stringify(key.name)}]`;
      return /^[A-Za-z_][\w]*$/.test(key) ? (i === 0 ? key : `.${key}`) : `[${JSON.stringify(key)}]`;
    })
    .join('');
}

/**
 * Validates the parsed TOML of green-packages.toml.
 * @param {unknown} raw  the object smol-toml returns
 * @param {string} file  shown in error messages
 * @returns {{ ok: true, value: Catalog } | { ok: false, errors: string[] }}
 */
export function parseCatalog(raw, file) {
  const errors = [];
  const at = (path, message) => errors.push(`${file}: ${formatPath(path)}: ${message}`);
  const unknownKeys = (table, known, path) => {
    for (const key of Object.keys(table)) if (!known.includes(key)) at([...path, key], 'is not a known field');
  };

  // Exact versions, at most one per minor line. Returns [{ line, version }] or null.
  const versionList = (value, path) => {
    if (!Array.isArray(value) || value.length === 0) {
      at(path, 'must list one or more exact versions');
      return null;
    }
    const lines = new Map();
    let good = true;
    value.forEach((version, i) => {
      if (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH || !SEMVER.test(version)) {
        at([...path, i], `must be an exact version such as "0.87.1" or "0.88.0-rc.3" (at most ${MAX_VERSION_LENGTH} characters)`);
        good = false;
        return;
      }
      const line = lineOf(version);
      if (lines.has(line)) {
        at([...path, i], `"${version}" is on line ${line}, which already has "${lines.get(line)}": list one version per line`);
        good = false;
      }
      lines.set(line, version);
    });
    return good ? [...lines].map(([line, version]) => ({ line, version })) : null;
  };

  if (!isTable(raw)) return { ok: false, errors: [`${file}: must be a TOML document`] };
  unknownKeys(raw, ['schema', 'react-native', 'package'], []);
  if (raw.schema !== 1) at(['schema'], 'must be 1');

  // React Native
  let reactNative = [];
  if (!isTable(raw['react-native'])) {
    at(['react-native'], 'is required: a [react-native] table with versions');
  } else {
    unknownKeys(raw['react-native'], ['versions'], ['react-native']);
    const lines = versionList(raw['react-native'].versions, ['react-native', 'versions']);
    reactNative = (lines ?? [])
      .map(({ line, version }) => ({ line, version, channel: parseVersion(version).prerelease.length > 0 ? 'rc' : 'stable' }))
      .sort((a, b) => compareLines(a.line, b.line));
  }

  // Packages
  const packages = [];
  const rawPackages = raw.package;
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    at(['package'], 'must list one or more [[package]] entries');
  } else {
    const seen = new Set();
    rawPackages.forEach((entry, index) => {
      if (!isTable(entry)) {
        at(['package', index], 'must be a table');
        return;
      }
      // Name the entry by its package name once that is known to be printable.
      const label = isPackageName(entry.name) ? { name: entry.name } : index;
      const p = (...rest) => ['package', label, ...rest];
      unknownKeys(entry, ['name', 'repository', 'description', 'license', 'versions', 'enabled', 'source', 'setup', 'test', 'demo'], p());

      if (!isPackageName(entry.name)) at(p('name'), 'must be a valid npm package name (lowercase, at most 214 characters, no leading hyphen)');
      else if (RESERVED_NAMES.has(entry.name)) at(p('name'), `"${entry.name}" is taken by a page or file of the site itself`);
      else if (seen.has(entry.name)) at(p('name'), `"${entry.name}" is listed twice`);
      else seen.add(entry.name);

      let repositoryOk = false;
      try {
        repositoryOk = typeof entry.repository === 'string' && new URL(entry.repository).protocol === 'https:';
      } catch {
        repositoryOk = false;
      }
      if (!repositoryOk) at(p('repository'), 'must be an https:// link');
      for (const key of ['description', 'license']) {
        if (key in entry && typeof entry[key] !== 'string') at(p(key), 'must be a string');
      }
      if ('enabled' in entry && typeof entry.enabled !== 'boolean') at(p('enabled'), 'must be true or false');
      const lines = versionList(entry.versions, p('versions'));

      const settings = parseSettings(entry, p, at, unknownKeys);
      packages.push({
        name: entry.name,
        repository: entry.repository,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        ...(typeof entry.license === 'string' ? { license: entry.license } : {}),
        enabled: entry.enabled !== false,
        lines: (lines ?? []).sort((a, b) => compareLines(b.line, a.line)),
        settings,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, value: { reactNative, packages } };
}

/** The source, setup, test and demo tables of one package, as Settings, or null when none is present. */
function parseSettings(entry, p, at, unknownKeys) {
  const has = ['source', 'setup', 'test', 'demo'].some((key) => key in entry);
  if (!has) return null;

  const table = (key) => {
    if (!(key in entry)) return {};
    if (!isTable(entry[key])) {
      at(p(key), 'must be a table');
      return {};
    }
    return entry[key];
  };
  const source = table('source');
  const setup = table('setup');
  const test = table('test');
  const demo = table('demo');
  unknownKeys(source, ['tag', 'dir'], p('source'));
  unknownKeys(setup, ['install', 'prepare', 'env', 'node'], p('setup'));
  unknownKeys(test, ['run', 'dir'], p('test'));
  unknownKeys(demo, ['dir', 'ios-scheme'], p('demo'));

  const tag = source.tag ?? 'v{version}';
  if (
    typeof tag !== 'string' ||
    !tag.includes('{version}') ||
    !/^[\w@/.{}+-]+$/.test(tag) ||
    /[{}]/.test(tag.replaceAll('{version}', ''))
  ) {
    at(p('source', 'tag'), 'must contain {version} (the only placeholder) and only tag-safe characters');
  }
  const packageDir = source.dir ?? '.';
  if (!isInsidePath(packageDir)) at(p('source', 'dir'), 'must be a relative path inside the repository');

  const installs = setup.install ?? ['.'];
  if (!Array.isArray(installs) || installs.length === 0 || !installs.every(isInsidePath)) {
    at(p('setup', 'install'), 'must list one or more folders inside the repository');
  }
  const checkStep = (step, path) => {
    if (!isTable(step) || !isInsidePath(step.dir ?? '') || !isCommand(step.run)) {
      at(path, 'must be { dir = <folder>, run = [<command>, <arguments>...] }');
    } else if (Object.keys(step).some((k) => k !== 'dir' && k !== 'run')) {
      at(path, 'only "dir" and "run" are allowed');
    }
  };
  const prepare = setup.prepare ?? [];
  if (!Array.isArray(prepare)) at(p('setup', 'prepare'), 'must be a list of { dir, run }');
  else prepare.forEach((step, i) => checkStep(step, p('setup', 'prepare', i)));

  const env = setup.env ?? {};
  if (!isTable(env)) at(p('setup', 'env'), 'must be a table');
  else {
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof value !== 'string' || value.length > 200) {
        at(p('setup', 'env', name), 'must be an UPPER_CASE name with a string value');
      }
      if (FORBIDDEN_ENV.has(name)) at(p('setup', 'env', name), 'may not be set');
    }
  }
  if ('node' in setup && (typeof setup.node !== 'string' || !/^\d{2}(\.\d+){0,2}$/.test(setup.node))) {
    at(p('setup', 'node'), 'must be a Node version such as "24" or "22.14"');
  }

  // Required on purpose: a forgotten test setting must not turn "tests not run" into "compatible".
  let testSettings = 'none';
  if (!('test' in entry)) at(p('test'), 'is required with settings: run = [<command>...] with a dir, or run = "none"');
  else if (test.run === 'none') {
    if ('dir' in test) at(p('test', 'dir'), 'is not allowed with run = "none"');
  } else if (!isCommand(test.run)) {
    at(p('test', 'run'), 'must be an argument list such as ["yarn", "test"], or "none" when the library has no test suite');
  } else if (!('dir' in test)) {
    at(p('test', 'dir'), 'is required with a test command');
  } else if (!isInsidePath(test.dir)) {
    at(p('test', 'dir'), 'must be a relative path inside the repository');
  } else {
    testSettings = { dir: test.dir, run: [...test.run] };
  }

  if (!('demo' in entry)) at(p('demo'), 'is required with settings: dir = <demo app folder>');
  else if (!isInsidePath(demo.dir ?? '') || demo.dir === '.') at(p('demo', 'dir'), 'must be a folder inside the repository');
  const scheme = demo['ios-scheme'];
  if (scheme !== undefined && (typeof scheme !== 'string' || !/^[\w .+-]{1,100}$/.test(scheme))) {
    at(p('demo', 'ios-scheme'), 'must be a scheme name');
  }

  return {
    tag,
    packageDir,
    demoApp: demo.dir,
    installs: Array.isArray(installs) ? [...installs] : ['.'],
    prepare: Array.isArray(prepare) ? prepare.map((step) => ({ dir: step?.dir, run: step?.run })) : [],
    test: testSettings,
    ...(typeof scheme === 'string' ? { ios: { scheme } } : {}),
    env: isTable(env) ? { ...env } : {},
    ...(typeof setup.node === 'string' ? { node: setup.node } : {}),
  };
}

/**
 * Parses TOML text and validates it. A syntax error is reported with the file name and line.
 * @returns {{ ok: true, value: Catalog } | { ok: false, errors: string[] }}
 */
export function parseCatalogText(text, file = CATALOG_FILE) {
  let raw;
  try {
    raw = parseToml(text);
  } catch (error) {
    const where = error?.line ? `${file}:${error.line}:${error.column ?? 1}` : file;
    return { ok: false, errors: [`${where}: ${String(error?.message ?? error).split('\n')[0]}`] };
  }
  return parseCatalog(raw, file);
}

/** Reads and validates green-packages.toml at the root of a clone. */
export function readCatalog(repoRoot) {
  return parseCatalogText(readFileSync(join(repoRoot, CATALOG_FILE), 'utf8'), CATALOG_FILE);
}

/** The release tag for a version: "v{version}" -> "v2.1.3", "@react-navigation/core@{version}" -> ... */
export function tagFor(settings, version) {
  return settings.tag.replaceAll('{version}', version);
}
