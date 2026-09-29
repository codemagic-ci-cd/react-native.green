// npm registry access for the compatibility scripts. Everything that touches the network is here, so
// the logic in swap.mjs and watch.mjs stays pure and testable with fixtures.
import { gunzipSync } from 'node:zlib';
import { distributionUrlOf, TEMPLATE_WRAPPER_PROPERTIES } from './gradle.mjs';
import { lineOf } from './semver.mjs';
import { pickLineVersion } from './swap.mjs';
import { readTarFile } from './tar.mjs';

const REGISTRY = 'https://registry.npmjs.org';
// Expo SDKs older than this bundle React Native lines far below anything tracked.
const OLDEST_EXPO_SDK = 50;

async function get(url, accept) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept } });
      if (response.ok) return response;
      if (response.status < 500 || attempt === 3) throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

/**
 * Abbreviated metadata: every version with its dependencies and peer dependencies, plus dist-tags.
 * @returns {Promise<{ versions: string[], distTags: Record<string, string>, manifests: Record<string, any> }>}
 */
export async function fetchPackument(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
  const body = await (await get(url, 'application/vnd.npm.install-v1+json')).json();
  return { versions: Object.keys(body.versions ?? {}), distTags: body['dist-tags'] ?? {}, manifests: body.versions ?? {} };
}

/** A published package's tarball, unpacked to a tar archive. */
async function fetchArchive(packument, version) {
  const tarball = packument.manifests[version]?.dist?.tarball;
  if (!tarball) throw new Error(`no tarball for version ${version}`);
  return { tarball, archive: gunzipSync(Buffer.from(await (await get(tarball, 'application/octet-stream')).arrayBuffer())) };
}

/** One JSON file from a published package, e.g. "package/bundledNativeModules.json". */
export async function fetchPackageFile(packument, version, path) {
  const { tarball, archive } = await fetchArchive(packument, version);
  const file = readTarFile(archive, path);
  if (!file) throw new Error(`${tarball} has no ${path}`);
  return JSON.parse(file.toString('utf8'));
}

/** Every Expo SDK tag with the React Native line it bundles, newest SDKs included. */
export async function fetchExpoSdks() {
  const expo = await fetchPackument('expo');
  const tags = Object.entries(expo.distTags)
    .map(([tag, version]) => [Number(/^sdk-(\d+)$/.exec(tag)?.[1]), version])
    .filter(([sdk]) => sdk >= OLDEST_EXPO_SDK);
  return Promise.all(
    tags.map(async ([sdk, version]) => {
      const bundled = await fetchPackageFile(expo, version, 'package/bundledNativeModules.json');
      return { sdk, version, reactNativeLine: lineOf(String(bundled['react-native']).replace(/^[~^]/, '')), bundled };
    }),
  );
}

/** Gathers the registry snapshot planSwap needs for these manifests ([{ file, manifest }]) and target. */
export async function gatherSwapRegistry({ manifests, demoKind, target }) {
  const names = new Set(['@react-native/jest-preset']);
  for (const { manifest } of manifests) {
    for (const field of ['dependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith('@react-native/')) names.add(name);
      }
    }
  }

  const versions = {};
  await Promise.all(
    [...names].map(async (name) => {
      versions[name] = (await fetchPackument(name)).versions;
    }),
  );

  const reactNative = await fetchPackument('react-native');
  if (!reactNative.manifests[target]) throw new Error(`react-native ${target} is not published`);

  // The template's package.json and its Gradle wrapper settings, from one download.
  const templatePackument = await fetchPackument('@react-native-community/template');
  const templateVersion = pickLineVersion(target, templatePackument.versions);
  let template = null;
  let gradleDistributionUrl = null;
  if (templateVersion) {
    const { tarball, archive } = await fetchArchive(templatePackument, templateVersion);
    const manifest = readTarFile(archive, 'package/template/package.json');
    if (!manifest) throw new Error(`${tarball} has no package/template/package.json`);
    template = JSON.parse(manifest.toString('utf8'));
    gradleDistributionUrl = distributionUrlOf(readTarFile(archive, TEMPLATE_WRAPPER_PROPERTIES)?.toString('utf8') ?? '');
  }

  return {
    versions,
    template,
    templateVersion,
    gradleDistributionUrl,
    reactNativePeers: reactNative.manifests[target].peerDependencies ?? {},
    expoSdks: demoKind === 'expo' ? await fetchExpoSdks() : [],
  };
}
