import { describe, expect, it } from 'vitest';
import tags from '../fixtures/library-manifests.json' with { type: 'json' };
import registryFixture from '../fixtures/registry.json' with { type: 'json' };
import { lineOf } from './semver.mjs';
import { chooseExpoSdk, chooseJestPreset, formatSwap, isRegistrySpec, localSpec, pickLineVersion, planSwap, swapCase } from './swap.mjs';

// Registry data captured from npm on 2026-09-29 (see fixtures/registry.json), shaped as
// gatherSwapRegistry returns it for one target.
function registryFor(target, overrides = {}) {
  return {
    versions: registryFixture.versions,
    template: registryFixture.templates[lineOf(target)] ?? null,
    reactNativePeers: registryFixture.reactNativePeers[target],
    expoSdks: registryFixture.expoSdks,
    ...overrides,
  };
}

const KIND = { 'v2.1.3': 'expo', 'v2.0.0': 'expo', 'v1.3.21': 'bare' };
const TARGETS = ['0.78.3', '0.84.1', '0.85.3', '0.87.1', '0.88.0-rc.3'];

function swap(tag, target, overrides) {
  const plan = planSwap({
    manifests: [
      { file: 'package.json', manifest: tags[tag].root },
      { file: 'example/package.json', manifest: tags[tag].example },
    ],
    demoFile: 'example/package.json',
    demoKind: KIND[tag],
    target,
    registry: registryFor(target, overrides),
  });
  const byFile = Object.fromEntries(plan.manifests.map((m) => [m.file, m.manifest]));
  return { ...plan, root: byFile['package.json'], example: byFile['example/package.json'] };
}

const deps = (manifest) => ({ ...manifest.dependencies, ...manifest.devDependencies });

describe('swapCase', () => {
  it('tells the three cases apart from the demo app’s pin', () => {
    expect(swapCase('0.87.1', '0.87.1')).toBe('same');
    expect(swapCase('0.83.2', '0.83.10')).toBe('patch');
    expect(swapCase('^0.78.0', '0.78.3')).toBe('patch');
    expect(swapCase('0.87.1', '0.88.0-rc.3')).toBe('line');
    expect(swapCase('workspace:*', '0.87.1')).toBe('line');
    expect(swapCase(undefined, '0.87.1')).toBe('line');
  });
});

describe('the library’s own setup is left alone', () => {
  it('changes nothing when the target is what the demo app already uses', () => {
    for (const [tag, target] of [['v2.1.3', '0.87.1'], ['v1.3.21', '0.84.1']]) {
      const plan = swap(tag, target);
      expect(plan.swapCase).toBe('same');
      expect(plan.changes).toEqual([]);
      expect(plan.root).toEqual(tags[tag].root);
      expect(plan.example).toEqual(tags[tag].example);
    }
  });

  it('moves only react-native and the @react-native/* packages in step within a line', () => {
    const plan = swap('v2.0.0', '0.83.10'); // the demo app pins 0.83.2
    expect(plan.swapCase).toBe('patch');
    expect(plan.example.dependencies['react-native']).toBe('0.83.10');
    // The root pins 0.84.1 with its @react-native/* packages in step; both follow to the target.
    expect(plan.root.devDependencies['react-native']).toBe('0.83.10');
    expect(plan.root.devDependencies['@react-native/babel-preset']).toBe('0.83.10');
    // Nothing else moves: react, expo and the jest setup stay the library's own.
    expect(plan.root.devDependencies.react).toBe(tags['v2.0.0'].root.devDependencies.react);
    expect(plan.example.dependencies.expo).toBe(tags['v2.0.0'].example.dependencies.expo);
    expect(plan.root.jest).toEqual(tags['v2.0.0'].root.jest);
    expect(plan.changes.map((c) => c.name).sort()).toEqual(
      ['@react-native/babel-preset', '@react-native/eslint-config', 'react-native', 'react-native'].sort(),
    );
  });
});

describe('another line: template, Expo and jest rules', () => {
  for (const tag of Object.keys(KIND)) {
    for (const target of TARGETS) {
      const plan = swap(tag, target);
      if (plan.swapCase !== 'line') continue;
      it(`${tag} on ${target}`, () => {
        const line = lineOf(target);
        const template = registryFixture.templates[line];
        for (const manifest of [plan.root, plan.example]) {
          const all = deps(manifest);
          if (all['react-native']) expect(all['react-native']).toBe(target);
          if (all.react) expect(all.react).toBe(template.dependencies.react);
          if (all['react-test-renderer']) expect(all['react-test-renderer']).toBe(template.devDependencies['react-test-renderer']);
          for (const [name, version] of Object.entries(all)) {
            if (!name.startsWith('@react-native/')) continue;
            expect(lineOf(version), `${name}@${version}`).toBe(line);
            expect(version).not.toMatch(/nightly/);
          }
        }
        // Only dependencies already present change, apart from the jest preset.
        for (const [key, manifest] of [['root', plan.root], ['example', plan.example]]) {
          const names = (m) => Object.keys(deps(m)).filter((n) => n !== '@react-native/jest-preset').sort();
          expect(names(manifest)).toEqual(names(tags[tag][key]));
        }
      });
    }
  }
});

describe('Expo', () => {
  const sdks = registryFixture.expoSdks;

  it('picks the SDK whose React Native line is closest, the lower one on a tie', () => {
    expect(chooseExpoSdk('0.78', sdks).sdk).toBe(53);
    expect(chooseExpoSdk('0.85', sdks).sdk).toBe(56);
    expect(chooseExpoSdk('0.88', sdks).sdk).toBe(57);
    expect(chooseExpoSdk('0.84', sdks).sdk).toBe(55); // between 0.83 and 0.85
    expect(chooseExpoSdk('0.82', sdks).sdk).toBe(54);
  });

  it('moves to another SDK with its bundled modules, keeping the manifest range style', () => {
    const plan = swap('v2.1.3', '0.85.3');
    const sdk56 = sdks.find((s) => s.sdk === 56);
    expect(plan.expoSdk).toBe(56);
    expect(plan.example.dependencies.expo).toBe(`~${sdk56.version}`);
    expect(plan.root.devDependencies.expo).toBe(sdk56.version);
    expect(plan.example.dependencies['expo-splash-screen']).toBe(sdk56.bundled['expo-splash-screen']);
    expect(plan.example.dependencies.react).toBe(registryFixture.templates['0.85'].dependencies.react);
  });

  it('keeps the Expo versions of a demo app already on the chosen SDK', () => {
    const rc = swap('v2.1.3', '0.88.0-rc.3'); // SDK 57 is closest, and the demo app uses 57
    expect(rc.keptExpo).toBe(true);
    expect(rc.expoSdk).toBeNull();
    expect(rc.example.dependencies.expo).toBe(tags['v2.1.3'].example.dependencies.expo);
    expect(rc.example.dependencies['expo-splash-screen']).toBe(tags['v2.1.3'].example.dependencies['expo-splash-screen']);
    expect(rc.example.dependencies['react-native']).toBe('0.88.0-rc.3');

    const tie = swap('v2.0.0', '0.84.1'); // tie resolves to SDK 55, which the demo app uses
    expect(tie.keptExpo).toBe(true);
    expect(tie.example.dependencies.expo).toBe(tags['v2.0.0'].example.dependencies.expo);
  });

  it('leaves expo alone in a bare demo app', () => {
    const plan = swap('v1.3.21', '0.78.3');
    expect(plan.expoSdk).toBeNull();
    expect(plan.root.devDependencies.expo).toBe(tags['v1.3.21'].root.devDependencies.expo);
  });
});

describe('jest preset', () => {
  it('uses @react-native/jest-preset where the line has one, adding the dependency', () => {
    const plan = swap('v2.0.0', '0.87.1');
    expect(plan.root.jest.preset).toBe('@react-native/jest-preset');
    expect(plan.root.devDependencies['@react-native/jest-preset']).toBe('0.87.1');
  });

  it('falls back to the built-in preset below 0.85, removing the dependency', () => {
    const plan = swap('v2.1.3', '0.84.1');
    expect(plan.root.jest.preset).toBe('react-native');
    expect(plan.root.devDependencies).not.toHaveProperty('@react-native/jest-preset');
  });

  it('uses the release candidate of the preset for a release candidate', () => {
    expect(swap('v2.1.3', '0.88.0-rc.3').root.devDependencies['@react-native/jest-preset']).toBe('0.88.0-rc.3');
  });

  it('chooses from the published versions only', () => {
    expect(chooseJestPreset('0.84.1', registryFixture.versions['@react-native/jest-preset']).preset).toBe('react-native');
    expect(chooseJestPreset('0.85.3', ['0.85.1', '0.85.2'])).toEqual({ preset: '@react-native/jest-preset', version: '0.85.2' });
  });
});

describe('fallbacks and monorepos', () => {
  it("uses react-native's peer range for react when the line has no template", () => {
    const plan = swap('v1.3.21', '0.88.0-rc.3', { template: null });
    expect(plan.example.dependencies.react).toBe(registryFixture.reactNativePeers['0.88.0-rc.3'].react);
    expect(plan.root.devDependencies['react-test-renderer']).toBe(tags['v1.3.21'].root.devDependencies['react-test-renderer']);
  });

  it('prefers the exact version, then the newest stable or rc on the line, never a nightly', () => {
    expect(pickLineVersion('0.85.3', ['0.85.2', '0.85.3', '0.85.4'])).toBe('0.85.3');
    expect(pickLineVersion('0.85.9', ['0.85.2', '0.85.4', '0.86.0'])).toBe('0.85.4');
    expect(pickLineVersion('0.88.0-rc.3', ['0.88.0-rc.1', '0.88.0-nightly-20260901-a'])).toBe('0.88.0-rc.1');
    expect(pickLineVersion('0.89.0', ['0.89.0-nightly-20260928-d7ff82ebe'])).toBeNull();
  });

  it('swaps every manifest that pins React Native in a monorepo', () => {
    const manifest = (rn) => ({ devDependencies: { 'react-native': rn, '@react-native/babel-preset': rn } });
    const plan = planSwap({
      manifests: [
        { file: 'package.json', manifest: manifest('0.86.0') },
        { file: 'packages/lib/package.json', manifest: manifest('0.86.0') },
        { file: 'apps/demo/package.json', manifest: { dependencies: { 'react-native': '0.86.0' } } },
      ],
      demoFile: 'apps/demo/package.json',
      demoKind: 'bare',
      target: '0.87.1',
      registry: registryFor('0.87.1'),
    });
    expect(plan.swapCase).toBe('line');
    for (const { manifest: m } of plan.manifests) expect(deps(m)['react-native']).toBe('0.87.1');
    expect(plan.manifests[1].manifest.devDependencies['@react-native/babel-preset']).toBe('0.87.1');
  });

  it('writes a summary that names the case', () => {
    expect(formatSwap(swap('v2.1.3', '0.87.1'), '0.87.1')).toContain('Case: same');
    const text = formatSwap(swap('v2.1.3', '0.84.1'), '0.84.1');
    expect(text).toContain('Case: line');
    expect(text).toContain('package.json  react-native: 0.87.1 -> 0.84.1');
  });
});

describe('pointing the demo app at the checked-out package', () => {
  const library = { name: '@codemagic/react-native-patch', spec: localSpec('yarn', '../../client') };
  const demo = (spec) => ({ dependencies: { 'react-native': '0.84.1', '@codemagic/react-native-patch': spec } });
  const plan = (spec, target = '0.84.1', lib = library) =>
    planSwap({
      manifests: [
        { file: 'package.json', manifest: { devDependencies: {} } },
        { file: 'examples/on-device-demo/package.json', manifest: demo(spec) },
      ],
      demoFile: 'examples/on-device-demo/package.json',
      demoKind: 'bare',
      target,
      registry: registryFor(target),
      library: lib,
    });
  const demoDeps = (p) => p.manifests[1].manifest.dependencies;

  it('replaces a registry version, even when no package version changes', () => {
    const same = plan('0.1.0');
    expect(same.swapCase).toBe('same');
    expect(demoDeps(same)['@codemagic/react-native-patch']).toBe('link:../../client');
    expect(same.changes).toEqual([
      {
        file: 'examples/on-device-demo/package.json',
        name: '@codemagic/react-native-patch',
        from: '0.1.0',
        to: 'link:../../client',
        reason: 'the checked-out package instead of the published one',
      },
    ]);
    expect(formatSwap(same, '0.84.1')).toContain('@codemagic/react-native-patch: 0.1.0 -> link:../../client');
  });

  it('replaces ranges and tags too, in the other two cases as well', () => {
    expect(demoDeps(plan('^0.1.0', '0.84.1'))['@codemagic/react-native-patch']).toBe('link:../../client');
    expect(demoDeps(plan('latest', '0.87.1'))['@codemagic/react-native-patch']).toBe('link:../../client');
  });

  it('leaves a dependency that already points elsewhere', () => {
    for (const spec of ['workspace:*', 'link:../', 'file:..', 'portal:../client', '../client', './lib', 'github:owner/repo', 'https://example.com/x.tgz']) {
      expect(isRegistrySpec(spec), spec).toBe(false);
      const p = plan(spec);
      expect(demoDeps(p)['@codemagic/react-native-patch'], spec).toBe(spec);
      expect(p.changes, spec).toEqual([]);
    }
  });

  it('uses file: for npm, and touches only the demo app', () => {
    expect(localSpec('npm', '..')).toBe('file:..');
    expect(localSpec('pnpm', '..')).toBe('link:..');
    const root = planSwap({
      manifests: [
        { file: 'package.json', manifest: demo('0.1.0') },
        { file: 'example/package.json', manifest: { dependencies: { 'react-native': '0.84.1' } } },
      ],
      demoFile: 'example/package.json',
      demoKind: 'bare',
      target: '0.84.1',
      registry: registryFor('0.84.1'),
      library,
    });
    expect(root.manifests[0].manifest.dependencies['@codemagic/react-native-patch']).toBe('0.1.0');
    expect(root.changes).toEqual([]);
  });

  it('does nothing when the demo app does not name the library', () => {
    expect(swap('v1.3.21', '0.84.1').changes).toEqual([]);
  });
});

