// Steps 5 to 7 of compatibility-check: one check per call, `tests`, `android` or `ios`.
//
// A check's outcome is a result, not a build failure: it records passed or failed from the exit
// status, keeps its log, and exits 0 so the remaining checks still run. Everything needed to build a
// platform counts as that platform's build: the package's prepare commands, `expo prebuild`,
// `pod install`. A package whose settings in green-packages.toml say it has no test suite records `none` for tests.
//
// Network fetches inside a check are retried, because a failed download would otherwise be recorded
// as the library's failure: the Gradle wrapper's download of Gradle, Gradle's dependency downloads
// (through its own retry settings), `pod install` and `expo prebuild`. When the demo app's own
// CocoaPods setup fails, `pod install` is tried once more with the machine's own (podInstall).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { failureLine, findMachinePod } from './lib/cocoapods.mjs';
import { outDir, readJson, workDir, writeJson } from './lib/config.mjs';
import { gradleVersionOf, planGradleWrapper, withDistributionUrl, WRAPPER_PROPERTIES } from './lib/gradle.mjs';
import { commands, packageManager, readInputs, repoPath, toolEnv } from './lib/library.mjs';
import { capture, fail, run } from './lib/proc.mjs';

const CHECKS = { tests: 'tests', android: 'buildAndroid', ios: 'buildIos' };
const NETWORK_ATTEMPTS = 3;
// Gradle's own settings for retrying dependency downloads, passed on the command line so they reach
// the build JVM.
const GRADLE_NETWORK = [
  '-Dorg.gradle.internal.repository.max.retries=5',
  '-Dorg.gradle.internal.repository.initial.backoff=1000',
  '-Dorg.gradle.internal.http.connectionTimeout=60000',
  '-Dorg.gradle.internal.http.socketTimeout=120000',
];

const which = process.argv[2];
if (!Object.hasOwn(CHECKS, which)) fail(`usage: check.mjs ${Object.keys(CHECKS).join('|')}`);

const { settings } = readInputs();
const swap = readJson(join(outDir(), 'swap.json'));
const env = toolEnv(settings);
const log = join(outDir(), 'logs', `${which}.log`);
const demo = repoPath(settings.demoApp);
// Which CocoaPods setup the iOS build used: "demo app", "machine", or "none" when both failed.
let cocoapods;

function note(message) {
  mkdirSync(join(outDir(), 'logs'), { recursive: true });
  appendFileSync(log, `${message}\n`);
  process.stdout.write(`${message}\n`);
}

// Runs commands in order and stops at the first failure. Returns the failing exit code, or 0.
async function steps(list) {
  for (const [command, args, options] of list) {
    const code = await run(command, args, { env, log, ...options });
    if (code !== 0) return code;
  }
  return 0;
}

// For steps whose failures are mostly network: a real failure fails the same way three times.
async function withRetries(label, list) {
  for (let attempt = 1; ; attempt += 1) {
    const code = await steps(list);
    if (code === 0 || attempt === NETWORK_ATTEMPTS) return code;
    note(`${label} failed (attempt ${attempt} of ${NETWORK_ATTEMPTS}); retrying.`);
  }
}

// The package's own build (bob, tsc, ...) that the tests and the demo app consume.
async function prepare() {
  return steps(settings.prepare.map(({ dir, run: [command, ...args] }) => [command, args, { cwd: repoPath(dir) }]));
}

async function expoPrebuild(platform) {
  const [command, args] = commands(packageManager(demo)).exec('expo', ['prebuild', '--platform', platform, '--no-install']);
  return withRetries('expo prebuild', [[command, args, { cwd: demo }]]);
}

async function tests() {
  if (settings.test === 'none') return null;
  const prepared = await prepare();
  if (prepared !== 0) return prepared;
  const [command, ...args] = settings.test.run;
  return steps([[command, args, { cwd: repoPath(settings.test.dir) }]]);
}

async function android() {
  const prepared = (await prepare()) || (swap.demoKind === 'expo' ? await expoPrebuild('android') : 0);
  if (prepared !== 0) return prepared;

  const androidDir = join(demo, 'android');
  // An Expo demo app's wrapper exists only now; set it to the template's Gradle (see swap.mjs).
  if (swap.demoKind === 'expo' && swap.gradleDistributionUrl) {
    const wrapper = join(demo, WRAPPER_PROPERTIES);
    const current = existsSync(wrapper) ? readFileSync(wrapper, 'utf8') : '';
    const change = planGradleWrapper(current, swap.gradleDistributionUrl);
    if (change) {
      writeFileSync(wrapper, withDistributionUrl(current, change.to));
      note(`Set the generated Gradle wrapper to Gradle ${gradleVersionOf(change.to)} (expo prebuild wrote ${gradleVersionOf(change.from)}).`);
    }
  }
  // The wrapper downloads Gradle itself, with a 10-second read timeout.
  const bootstrapped = await withRetries('Gradle wrapper bootstrap', [
    ['./gradlew', ['--version', '--no-daemon', '--console=plain'], { cwd: androidDir }],
  ]);
  if (bootstrapped !== 0) return bootstrapped;
  // One architecture keeps the build short; arm64-v8a matches the Apple silicon build machines.
  return steps([
    [
      './gradlew',
      ['assembleDebug', '-PreactNativeArchitectures=arm64-v8a', '--no-daemon', '--console=plain', ...GRADLE_NETWORK],
      { cwd: androidDir },
    ],
  ]);
}

/**
 * `pod install` the demo app's own way first: with its Gemfile, `bundle install` and
 * `bundle exec pod install`, else plain `pod install`. If that fails, once more with this machine's
 * own Ruby and CocoaPods, without the Gemfile and without the repository's Ruby version pin (see
 * lib/cocoapods.mjs). The log says which one was used and why the first failed.
 */
async function podInstall(iosDir) {
  const gemfile = [join(demo, 'Gemfile'), join(iosDir, 'Gemfile')].find(existsSync);
  let failed;
  if (gemfile) {
    const bundleEnv = { ...env, BUNDLE_GEMFILE: gemfile };
    const bundled = await withRetries('bundle install', [['bundle', ['install'], { cwd: iosDir, env: bundleEnv }]]);
    if (bundled !== 0) failed = { step: 'bundle install', code: bundled };
    else {
      const installed = await withRetries('bundle exec pod install', [['bundle', ['exec', 'pod', 'install'], { cwd: iosDir, env: bundleEnv }]]);
      if (installed !== 0) failed = { step: 'bundle exec pod install', code: installed };
    }
  } else {
    const installed = await withRetries('pod install', [['pod', ['install'], { cwd: iosDir }]]);
    if (installed !== 0) failed = { step: 'pod install', code: installed };
  }
  if (!failed) {
    note(`CocoaPods: the demo app's own way (${gemfile ? `its Gemfile, ${relative(demo, gemfile)}` : 'plain pod install'}).`);
    cocoapods = 'demo app';
    return 0;
  }

  const why = failureLine(readFileSync(log, 'utf8')) ?? 'no output';
  note(`CocoaPods: the demo app's own way failed at \`${failed.step}\` (exit ${failed.code}): ${why}`);
  const machine = await findMachinePod(env, capture);
  if (machine.reason) {
    note(`CocoaPods: no fallback, because ${machine.reason}.`);
    cocoapods = 'none';
    return failed.code;
  }
  note(`CocoaPods: trying once more with this machine's own setup, without the Gemfile and without the repository's Ruby pin: ${machine.description}.`);
  const code = await withRetries('pod install (machine)', [[machine.command, machine.args, { cwd: iosDir, env: machine.env }]]);
  note(code === 0 ? "CocoaPods: used this machine's own setup." : `CocoaPods: this machine's own setup failed too (exit ${code}).`);
  cocoapods = code === 0 ? 'machine' : 'none';
  return code;
}

async function ios() {
  const prepared = (await prepare()) || (swap.demoKind === 'expo' ? await expoPrebuild('ios') : 0);
  if (prepared !== 0) return prepared;

  const iosDir = join(demo, 'ios');
  // ios/.xcode.env.local is per machine (React Native's template keeps it out of git). A committed
  // copy points NODE_BINARY at its author's computer and breaks every build elsewhere, so it goes.
  const machineEnv = join(iosDir, '.xcode.env.local');
  if (swap.demoKind === 'bare' && existsSync(machineEnv)) {
    rmSync(machineEnv);
    note("Removed the committed ios/.xcode.env.local (it is specific to its author's machine).");
  }

  const installed = await podInstall(iosDir);
  if (installed !== 0) return installed;

  // Find the workspace (react-native-test-app demos generate it during pod install) and the scheme:
  // the catalog may name it (demo.ios-scheme); otherwise it is named after the workspace or the app's own .xcodeproj.
  const entries = readdirSync(iosDir);
  const workspace = entries.find((name) => name.endsWith('.xcworkspace'));
  if (!workspace) {
    note(`No .xcworkspace in ${iosDir}`);
    return 1;
  }
  let scheme = settings.ios?.scheme;
  if (!scheme) {
    const listed = await capture('xcodebuild', ['-list', '-json', '-workspace', workspace], { cwd: iosDir, env });
    let schemes = [];
    try {
      schemes = JSON.parse(listed.stdout).workspace?.schemes ?? [];
    } catch {
      schemes = [];
    }
    const names = [
      basename(workspace, '.xcworkspace'),
      ...entries.filter((name) => name.endsWith('.xcodeproj') && name !== 'Pods.xcodeproj').map((name) => basename(name, '.xcodeproj')),
    ];
    scheme = names.find((name) => schemes.includes(name));
    if (!scheme) {
      note(`No app scheme in ${workspace}; looked for ${names.join(', ')} among ${schemes.length} schemes. Set demo.ios-scheme in green-packages.toml.`);
      return 1;
    }
  }
  note(`Building ${workspace}, scheme ${scheme}`);

  return steps([
    [
      'xcodebuild',
      [
        '-workspace', workspace,
        '-scheme', scheme,
        '-configuration', 'Debug',
        '-sdk', 'iphonesimulator',
        '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', join(workDir(), 'DerivedData'),
        'CODE_SIGNING_ALLOWED=NO',
        'build',
      ],
      { cwd: iosDir },
    ],
  ]);
}

const started = Date.now();
const code = await { tests, android, ios }[which]();
const outcome = {
  check: CHECKS[which],
  result: code === null ? 'none' : code === 0 ? 'passed' : 'failed',
  exitCode: code,
  seconds: Math.round((Date.now() - started) / 1000),
  log: code === null ? null : `logs/${which}.log`,
  ...(cocoapods ? { cocoapods } : {}),
};
writeJson(join(outDir(), 'checks', `${CHECKS[which]}.json`), outcome);
process.stdout.write(
  code === null
    ? '\ntests: none (green-packages.toml says the library has no test suite)\n'
    : `\n${CHECKS[which]}: ${outcome.result} (exit ${code}, ${outcome.seconds} s)\n`,
);
