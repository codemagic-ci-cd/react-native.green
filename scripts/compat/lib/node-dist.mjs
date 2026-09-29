// The Node version a package's settings ask for (setup.node), for library commands only. Builds are
// started by hand, so nothing passes that version to Codemagic: when the running Node does not match
// it, the check downloads the newest matching release from nodejs.org, checks it against the
// release's SHASUMS256.txt, and unpacks it into the work folder. toolEnv puts its bin folder first in
// PATH for every library command; our own scripts keep running on the workflow's Node.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.mjs';

export const NODE_DIST = 'https://nodejs.org/dist';
const ATTEMPTS = 3;

/** The folder a downloaded Node is unpacked into; its bin folder goes first in PATH when it exists. */
export const nodeDir = (workDir) => join(workDir, 'node');

/** Whether a Node version such as "v24.9.0" is what a setting such as "24", "24.9" or "24.9.0" asks for. */
export function matchesSetting(version, setting) {
  const parts = version.replace(/^v/, '').split('.');
  return setting.split('.').every((part, i) => parts[i] === String(Number(part)));
}

const numeric = (version) => version.replace(/^v/, '').split('.').map(Number);
const newerFirst = (a, b) => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

/** nodejs.org's name for a platform and architecture, as in the archive names. */
export function platformOf(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { arm64: 'arm64', x64: 'x64' }[arch];
  if (!os || !cpu) throw new Error(`no Node download for ${platform} ${arch}`);
  return `${os}-${cpu}`;
}

/** The key nodejs.org's index uses to say a release has an archive for this platform. */
const indexFileKey = (target) => (target.startsWith('darwin-') ? `osx-${target.slice(7)}-tar` : target);

/**
 * The newest release in nodejs.org's index.json that matches the setting and has an archive for the
 * platform, or null.
 * @param {Array<{ version: string, files?: string[] }>} index
 */
export function pickRelease(index, setting, target) {
  const key = indexFileKey(target);
  const matching = index
    .filter((release) => /^v\d+\.\d+\.\d+$/.test(release.version) && matchesSetting(release.version, setting))
    .filter((release) => !release.files || release.files.includes(key))
    .sort((a, b) => newerFirst(a.version, b.version));
  return matching[0]?.version ?? null;
}

export const archiveName = (version, target) => `node-${version}-${target}.tar.gz`;

/** The SHA-256 SHASUMS256.txt gives for a file, or null. */
export function checksumOf(shasums, fileName) {
  for (const line of shasums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1];
  }
  return null;
}

/** Throws unless the archive's SHA-256 is the one SHASUMS256.txt lists for it. */
export function verifyArchive(bytes, shasums, fileName) {
  const expected = checksumOf(shasums, fileName);
  if (!expected) throw new Error(`SHASUMS256.txt does not list ${fileName}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${fileName} does not match its checksum (expected ${expected}, got ${actual})`);
}

async function get(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      if (response.status < 500 || attempt === ATTEMPTS) throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
    }
    process.stdout.write(`Downloading ${url} failed (attempt ${attempt} of ${ATTEMPTS}); retrying.\n`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

/**
 * Makes the Node a setting asks for available to library commands. Removes any Node a previous run
 * left in the work folder first, so a check never uses a stale one.
 * @param {string | undefined} setting  setup.node
 * @returns {Promise<{ version: string, downloaded: boolean }>} the Node library commands use
 */
export async function provideNode(setting, workDir, { running = process.version, log } = {}) {
  const dir = nodeDir(workDir);
  rmSync(dir, { recursive: true, force: true });
  if (!setting || matchesSetting(running, setting)) return { version: running, downloaded: false };

  const target = platformOf();
  const index = await (await get(`${NODE_DIST}/index.json`)).json();
  const version = pickRelease(index, setting, target);
  if (!version) throw new Error(`nodejs.org has no Node release matching "${setting}" for ${target}`);
  const name = archiveName(version, target);
  const shasums = await (await get(`${NODE_DIST}/${version}/SHASUMS256.txt`)).text();
  const bytes = Buffer.from(await (await get(`${NODE_DIST}/${version}/${name}`)).arrayBuffer());
  verifyArchive(bytes, shasums, name);

  mkdirSync(dir, { recursive: true });
  const archive = join(workDir, name);
  writeFileSync(archive, bytes);
  const unpacked = await run('tar', ['-xzf', archive, '-C', dir, '--strip-components', '1'], { log });
  rmSync(archive, { force: true });
  if (unpacked !== 0 || !existsSync(join(dir, 'bin', 'node'))) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not unpack ${name}`);
  }
  return { version, downloaded: true };
}
