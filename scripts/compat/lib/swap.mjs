// Points a library's workspace at one React Native version, changing as little as the target
// requires. Pure: every registry fact arrives in `registry`, gathered beforehand by registry.mjs.
//
// Three cases, decided by the React Native version the demo app already uses:
//   same     it is the target: nothing changes, so the check runs the library's own setup.
//   patch    same line, other patch: react-native and the @react-native/* packages pinned in step
//            with it move to the target; nothing else.
//   line     another line: the template and Expo rules below apply, except that an Expo demo already
//            on the chosen SDK keeps its expo and Expo module versions.
//
// registry = {
//   versions: { [packageName]: string[] }   every published version of each @react-native/*
//                                           package in the manifests, plus @react-native/jest-preset
//   template: { dependencies, devDependencies } | null
//                                           @react-native-community/template's template/package.json
//                                           for the target line, or null when that line has none
//   reactNativePeers: { [name]: range }     peerDependencies of react-native@target
//   expoSdks: [{ sdk, version, reactNativeLine, bundled }]
//                                           every Expo SDK tag: expo's version, the React Native line
//                                           it bundles, and its bundledNativeModules.json
// }
import { isReleaseCandidate, isStable, lineOf, newestOnLine, parseVersion } from './semver.mjs';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
const JEST_PRESET_PACKAGE = '@react-native/jest-preset';
const TEMPLATE_PACKAGES = (name) =>
  name === 'react' || name === 'react-test-renderer' || name.startsWith('@react-native-community/cli');

/**
 * The target version itself if published, else the newest published patch on its line, else null.
 * The fallback considers stable releases and release candidates only, never nightlies.
 */
export function pickLineVersion(target, versions = []) {
  if (versions.includes(target)) return target;
  return newestOnLine(versions, lineOf(target), (v) => isStable(v) || isReleaseCandidate(v));
}

/** The Expo SDK whose bundled React Native line is closest to `targetLine`; ties go to the lower SDK. */
export function chooseExpoSdk(targetLine, sdks) {
  const distance = (line) => {
    const [aMajor, aMinor] = line.split('.').map(Number);
    const [bMajor, bMinor] = targetLine.split('.').map(Number);
    return Math.abs((aMajor - bMajor) * 1000 + (aMinor - bMinor));
  };
  return (
    [...sdks].sort((a, b) => distance(a.reactNativeLine) - distance(b.reactNativeLine) || a.sdk - b.sdk)[0] ??
    null
  );
}

/** @react-native/jest-preset when it exists for the target line, else React Native's built-in preset. */
export function chooseJestPreset(target, jestPresetVersions = []) {
  const version = pickLineVersion(target, jestPresetVersions);
  return version ? { preset: JEST_PRESET_PACKAGE, version } : { preset: 'react-native', version: null };
}

/** "~57.0.18" -> "57.0.18"; ranges and protocols such as "*" or "workspace:*" -> null. */
function exactPart(spec) {
  const version = typeof spec === 'string' ? spec.replace(/^[~^=]/, '') : '';
  return parseVersion(version) ? version : null;
}

/** Keeps a range operator the manifest already used ("~57.0.5" stays "~"), so only the version moves. */
function withOperator(previous, version) {
  const operator = /^[~^]/.exec(previous)?.[0] ?? '';
  return /^[~^<>=]/.test(version) ? version : `${operator}${version}`;
}

const dependencyOf = (manifest, name) =>
  DEPENDENCY_FIELDS.map((field) => manifest[field]?.[name]).find((value) => value !== undefined);

/**
 * True for a dependency spec that installs from the registry: a version, a range or a tag. False for
 * the protocols that already point elsewhere (workspace:, link:, file:, portal:, git and URLs) and for
 * paths.
 */
export function isRegistrySpec(spec) {
  return typeof spec === 'string' && !spec.includes(':') && !/^[./~]/.test(spec);
}

/**
 * How the demo app should depend on the checked-out package: `link:` for yarn and pnpm, `file:` for
 * npm, with the path from the demo app's folder to the package's folder.
 */
export function localSpec(manager, relativePath) {
  return `${manager === 'npm' ? 'file' : 'link'}:${relativePath}`;
}

/** Which of the three cases applies, from the React Native version the demo app already pins. */
export function swapCase(demoReactNative, target) {
  const current = exactPart(demoReactNative);
  if (current === target) return 'same';
  if (current && lineOf(current) === lineOf(target)) return 'patch';
  return 'line';
}

/**
 * @param {object} options
 * @param {Array<{ file: string, manifest: object }>} options.manifests  every package.json to swap:
 *   the repository root, the package's own, the demo app's (each once); none is modified
 * @param {string} options.demoFile  which of them is the demo app's
 * @param {'bare' | 'expo'} options.demoKind
 * @param {string} options.target  exact React Native version
 * @param {{ name: string, spec: string }} [options.library]  the package under test, and the spec
 *   (from localSpec) that points the demo app at its checked-out folder
 */
export function planSwap({ manifests, demoFile, demoKind, target, registry, library }) {
  const targetLine = lineOf(target);
  const demo = manifests.find((m) => m.file === demoFile)?.manifest ?? {};
  const demoReactNative =
    dependencyOf(demo, 'react-native') ?? manifests.map((m) => dependencyOf(m.manifest, 'react-native')).find(Boolean);
  const kind = swapCase(demoReactNative, target);
  const changes = [];

  let expo = null;
  let keepExpo = false;
  if (kind === 'line' && demoKind === 'expo') {
    expo = chooseExpoSdk(targetLine, registry.expoSdks ?? []);
    const currentExpoMajor = parseVersion(exactPart(dependencyOf(demo, 'expo')) ?? '')?.major;
    keepExpo = expo !== null && currentExpoMajor === expo.sdk;
  }
  const jest = kind === 'line' ? chooseJestPreset(target, registry.versions?.[JEST_PRESET_PACKAGE]) : null;
  const templateVersions = { ...registry.template?.devDependencies, ...registry.template?.dependencies };

  // Decide what one dependency of `manifest` becomes. Returns [version, reason], or null to leave it.
  const decide = (name, current, manifest) => {
    if (kind === 'same') return null;
    if (name === 'react-native') return [target, 'the React Native version under test'];

    if (kind === 'patch') {
      // Only @react-native/* packages that track this manifest's react-native line move with it.
      const ownLine = lineOf(exactPart(dependencyOf(manifest, 'react-native')) ?? exactPart(demoReactNative) ?? '');
      if (!name.startsWith('@react-native/') || lineOf(exactPart(current) ?? '') !== ownLine) return null;
      const version = pickLineVersion(target, registry.versions?.[name]);
      return version ? [version, 'pinned in step with react-native'] : null;
    }

    if (name === JEST_PRESET_PACKAGE) return null; // handled with the jest configuration below
    if (TEMPLATE_PACKAGES(name)) {
      if (registry.template) {
        return templateVersions[name]
          ? [templateVersions[name], `from @react-native-community/template for ${targetLine}`]
          : null;
      }
      if (name === 'react' && registry.reactNativePeers?.react) {
        return [registry.reactNativePeers.react, `no template for ${targetLine}; react-native's peer range`];
      }
      return null;
    }
    if (name.startsWith('@react-native/')) {
      const version = pickLineVersion(target, registry.versions?.[name]);
      if (!version) return null;
      return [version, version === target ? 'matches react-native' : `newest ${name} on ${targetLine}`];
    }
    if (expo && !keepExpo && name === 'expo') {
      return [withOperator(current, expo.version), `Expo SDK ${expo.sdk} bundles React Native ${expo.reactNativeLine}`];
    }
    if (expo && !keepExpo && Object.hasOwn(expo.bundled, name)) {
      return [expo.bundled[name], `bundled with Expo SDK ${expo.sdk}`];
    }
    return null;
  };

  const swapManifest = ({ file, manifest }) => {
    const next = structuredClone(manifest);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, current] of Object.entries(next[field] ?? {})) {
        const decision = decide(name, current, manifest);
        if (!decision || decision[0] === current) continue;
        next[field][name] = decision[0];
        changes.push({ file, name, from: current, to: decision[0], reason: decision[1] });
      }
    }

    // The jest preset is the one change allowed to add or remove a dependency, and only across lines.
    if (jest && typeof next.jest?.preset === 'string') {
      if (next.jest.preset !== jest.preset) {
        changes.push({
          file,
          name: 'jest.preset',
          from: next.jest.preset,
          to: jest.preset,
          reason: jest.version ? `${JEST_PRESET_PACKAGE} exists for ${targetLine}` : `no ${JEST_PRESET_PACKAGE} for ${targetLine}`,
        });
        next.jest.preset = jest.preset;
      }
      const field = DEPENDENCY_FIELDS.find((f) => next[f]?.[JEST_PRESET_PACKAGE]) ?? 'devDependencies';
      const current = next[field]?.[JEST_PRESET_PACKAGE] ?? null;
      if (jest.version && current !== jest.version) {
        next[field] = { ...next[field], [JEST_PRESET_PACKAGE]: jest.version };
        changes.push({ file, name: JEST_PRESET_PACKAGE, from: current, to: jest.version, reason: 'jest preset for this line' });
      } else if (!jest.version && current !== null) {
        delete next[field][JEST_PRESET_PACKAGE];
        changes.push({ file, name: JEST_PRESET_PACKAGE, from: current, to: null, reason: 'built-in react-native preset instead' });
      }
    }
    return { file, manifest: next };
  };

  // In every case, "same" included: a demo app that names the library under test with a registry
  // version would build that published version, not the tagged code, so it is pointed at the
  // checked-out package instead.
  const pointAtCheckout = ({ file, manifest }) => {
    if (file !== demoFile || !library) return { file, manifest };
    for (const field of DEPENDENCY_FIELDS) {
      const current = manifest[field]?.[library.name];
      if (!isRegistrySpec(current)) continue;
      manifest[field][library.name] = library.spec;
      changes.push({ file, name: library.name, from: current, to: library.spec, reason: 'the checked-out package instead of the published one' });
    }
    return { file, manifest };
  };

  return {
    manifests: manifests.map(swapManifest).map(pointAtCheckout),
    swapCase: kind,
    fromReactNative: demoReactNative ?? null,
    expoSdk: expo && !keepExpo ? expo.sdk : null,
    keptExpo: keepExpo,
    jestPreset: jest?.preset ?? null,
    changes,
  };
}

const CASE_TEXT = {
  same: 'the demo app already uses this version: no package version changed',
  patch: 'same line as the demo app: only react-native and the @react-native/* packages in step with it changed',
  line: 'another line than the demo app: template and Expo rules applied',
};

/** Human-readable summary for the build log. */
export function formatSwap(plan, target) {
  const lines = [
    `React Native ${target}; the demo app had ${plan.fromReactNative ?? 'no react-native dependency'}.`,
    `Case: ${plan.swapCase}, ${CASE_TEXT[plan.swapCase]}.`,
  ];
  if (plan.keptExpo) lines.push('Expo: the demo app is already on the chosen SDK, so its Expo versions were kept.');
  else if (plan.expoSdk) lines.push(`Expo: moved to SDK ${plan.expoSdk}.`);
  if (plan.jestPreset) lines.push(`Jest preset: ${plan.jestPreset}.`);
  for (const note of plan.notes ?? []) lines.push(note);
  lines.push('');
  lines.push(
    plan.changes.length === 0
      ? 'No dependency changes.'
      : plan.changes.map((c) => `${c.file}  ${c.name}: ${c.from ?? '(absent)'} -> ${c.to ?? '(removed)'}  (${c.reason})`).join('\n'),
  );
  return `${lines.join('\n')}\n`;
}
