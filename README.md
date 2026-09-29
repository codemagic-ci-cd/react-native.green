# rn.green

rn.green shows whether a React Native library works on each React Native version. A cell is
**compatible** only when the library's demo app builds on iOS and Android **and** its test suite
passes, if it has one. Patch versions are folded into minor lines (`2.1.3` counts as `2.1.x`).

The site is static, built with [Astro](https://astro.build). The packages in this repository are
skeletons: no cell has a result until the first Codemagic run.

## Commands

Requires Node 22.12 or newer.

| Command           | What it does                                 |
| ----------------- | -------------------------------------------- |
| `npm install`     | Install dependencies                         |
| `npm run dev`     | Start the dev server at http://localhost:4321 |
| `npm run build`   | Validate the data and build the site to `dist/` |
| `npm run preview` | Serve the built site                          |
| `npm run check`   | Type check (`astro check`)                    |
| `npm test`        | Run the unit tests (`vitest`)                 |

## Data format

All data lives in `compatibility-data/`. The build fails with the file and field named if anything
is invalid.

`compatibility-data/react-native.json` lists the React Native lines, which become the table
columns. `channel` is `stable` or `rc`.

```json
{
  "schemaVersion": 1,
  "lines": {
    "0.87": { "version": "0.87.1", "channel": "stable" },
    "0.88": { "version": "0.88.0-rc.3", "channel": "rc" }
  }
}
```

Each package has `compatibility-data/<package name>/compatibility.json`, which becomes the page
`/<package name>/` and the badge `/badge/<package name>.svg`.

```json
{
  "schemaVersion": 1,
  "package": {
    "name": "react-native-screenshot-aware",
    "repository": "https://github.com/huextrat/react-native-screenshot-aware",
    "description": "React Native module for real-time screenshot detection on Android and iOS",
    "license": "MIT"
  },
  "lines": {
    "2.1": {
      "version": "2.1.3",
      "results": {
        "0.87": {
          "status": "compatible",
          "tested": { "library": "2.1.3", "reactNative": "0.87.1" },
          "checks": { "buildIos": "passed", "buildAndroid": "passed", "tests": "passed" },
          "testedAt": "2026-09-06T02:14:09Z"
        }
      }
    }
  }
}
```

- Keys of `lines` and `results` are minor lines without leading zeros (`0.80`, not `0.080`). The
  exact versions tested are in `tested`, and every version is semver (`0.88.0-rc.3` is fine).
- Unknown keys are an error, so a misspelt field fails the build instead of being ignored.
- `package.name` must be a valid npm package name and match its folder.
- `repository` must be an `https://` link.
- A missing cell means the combination has not been tested yet ("Untested" on the site).
- `buildIos` and `buildAndroid` are `passed` or `failed`. `tests` is `passed`, `failed` or `none`,
  which means the library has no test suite and is judged on its builds alone.
- `status` must be `compatible` exactly when both builds are `passed` and `tests` is `passed` or
  `none`.
- Every `results` key must be a line in `react-native.json`.
- `buildUrl` (optional) links the cell to its Codemagic build and must start with
  `https://codemagic.io/`. `mock`, `description` and `license` are optional.

## Compatibility workflows

`codemagic.yaml` defines two workflows. Their scripts are in `scripts/compat/`: plain Node, no build
step, with the logic in `scripts/compat/lib/` and its tests beside it.

- **`compatibility-check`** tests one cell: one library version on one React Native version. It
  checks the library out at its release tag, points the library's own demo app at that React Native
  version, installs, runs the library's test suite, builds the demo app for Android and for iOS, and
  saves the three outcomes as a build artifact, `result.json`. It runs the library's own code, so it
  has **no credentials at all** and writes nothing to this repository.
- **`watch-releases`** runs on a schedule and is the only workflow that writes here. Each run:
  1. records the results of finished checks from their `result.json` artifacts,
  2. refreshes the tracked versions from npm,
  3. finds the cells that need a build (never tested, or tested on an older patch of either line),
  4. commits and pushes all of that in one commit,
  5. starts one `compatibility-check` build per cell, newest React Native line first, up to
     `max_builds` per run. The rest wait for the next run.

Two consequences: a result appears on the next watcher run, not when its check finishes; and a check
whose setup fails leaves no result, so it records nothing.

Only packages with a `harness.json` (below) take part. The watcher lists the others as "not checked".

### Credentials

Set these as environment variable groups in the Codemagic app. Never commit their values.

| Group | Variable | Used by | Notes |
| --- | --- | --- | --- |
| `rn_green_push` | `GITHUB_TOKEN` | `watch-releases` | Fine-grained token for this repository only, contents read and write |
| `rn_green_api` | `CM_API_TOKEN` | `watch-releases` | Codemagic API token: reads builds and artifacts, starts checks |
| `rn_green_api` | `CM_TEAM_ID` | `watch-releases` | The Codemagic team that owns the app, for listing builds. `GET https://codemagic.io/api/v3/user/teams` with the token lists the token owner's teams |

`compatibility-check` uses no variable group. The push token is handed to git through a credential
helper that reads the variable, so it never appears in a remote URL, in `.git/config` or in a log.
Why the check has no credentials: on a build machine, any process can read the environment of the
processes that started it (`ps eww` on macOS), and code that runs before a later step can change
what that step runs. A library's install scripts, tests and build scripts run in the check, so
nothing there may be able to reach a credential.

### Per-package settings: `harness.json`

Libraries differ in where their code, demo app and tests live, so each checked package has
`compatibility-data/<package>/harness.json`. We write it, so it is trusted configuration; the site
ignores it. Every field except `schemaVersion` and `test` is optional:

```json
{
  "schemaVersion": 1,
  "tag": "v{version}",
  "packageDir": ".",
  "demoApp": "example",
  "installs": ["."],
  "prepare": [{ "dir": ".", "run": ["yarn", "prepare"] }],
  "test": { "dir": ".", "run": ["yarn", "test"] },
  "ios": { "scheme": "ScreenshotAwareExample" },
  "env": {},
  "node": "22"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `tag` | `v{version}` | Release tag. `{version}` is the version, `{name}` the package name without its scope (`@react-navigation/{name}@{version}`) |
| `packageDir` | `.` | Where the package sits in its repository (`packages/react-native-reanimated`) |
| `demoApp` | `example` | The demo app that is built (`apps/fabric-example`) |
| `installs` | `["."]` | Folders to install in, in order, each with the package manager it declares. Some demo apps install separately (`[".", "example"]`) |
| `prepare` | none | Commands run before the tests and before each native build, such as the package's own build (`yarn prepare`, `yarn build`) |
| `test` | required | `{ "dir", "run" }`, or `"none"` when the library has no test suite. Required on purpose: a forgotten field must not turn "tests not run" into "compatible" |
| `ios.scheme` | found from the workspace | Only when the app's scheme is not named after its workspace or project (`Debug FabricExample`, `ReactTestApp`) |
| `env` | `{}` | Extra environment for every library command (`{ "RNS_GAMMA_ENABLED": "1" }`) |
| `node` | the workflow's (22) | Node version for the check, passed when the watcher starts it |

Commands are argument lists run without a shell, and every folder must stay inside the repository.

### Scheduling `watch-releases`

Codemagic schedules are set in the UI, not in YAML: open the app, choose **Scheduled builds**, add a
schedule for the `watch-releases` workflow on the branch that holds the data, and leave the inputs at
their defaults. Run it once by hand with `dry_run` on first: it prints the results it would record,
the version changes and the builds it would start, and does nothing else.

The watcher looks back over the last 7 days of `compatibility-check` builds. It does not start a
cell whose check is queued or running, or failed, was cancelled or timed out in the last 3 days, so a
setup that fails every time is not restarted on every run.

### Starting one check by hand

In the Codemagic UI, start `compatibility-check` and fill in `package`, `library_version` and
`react_native_version` with exact versions that the data already tracks. Turn `record` off to run
the checks without the watcher recording them. Through the API:

```sh
curl -X POST "https://codemagic.io/api/v3/apps/$APP_ID/builds" \
  -H "x-auth-token: $CM_API_TOKEN" -H 'content-type: application/json' \
  -d '{"workflow_id": "compatibility-check", "branch": "main",
       "inputs": {"package": "react-native-screenshot-aware", "library_version": "2.1.3",
                  "react_native_version": "0.87.1", "record": false}}'
```

Inputs are checked before anything runs: the package must be tracked and have a valid
`harness.json`, versions must be exact, and both lines must already be in the data.

### How React Native is swapped in

The library's own demo app is what gets built, so a red cell can be caused by the demo app rather
than the library. The swap changes as little as the target needs, in the repository's root
`package.json`, the package's own and the demo app's, so the workspace resolves one React Native
version. The build log (`swap.txt`) says which case applied and lists every change.

- **Same version.** When the demo app already uses the version under test, no package version
  changes: the check runs the library's own setup (apart from the Gradle wrapper, below).
- **Same line, other patch.** `react-native` and the `@react-native/*` packages pinned in step with
  it move to the target; nothing else.
- **Another line.**
  - `react-native` becomes the version under test.
  - `react`, `react-test-renderer` and the `@react-native-community/cli` packages take the versions
    from the React Native app template for that line. A line without a template (a very new release
    candidate) takes `react` from React Native's own peer range and leaves the others.
  - Every `@react-native/*` package takes the same version as React Native, or the newest release or
    release candidate on that line when that exact version was never published. Nightlies are never
    used.
  - Tests use `@react-native/jest-preset` when it exists for the line, otherwise React Native's
    built-in `react-native` preset (only a `jest.preset` in `package.json` is adjusted).
  - Expo demo apps move to the Expo SDK whose React Native line is closest (the lower SDK on a tie),
    with every Expo-managed module at the version that SDK bundles, unless the demo app is already
    on that SDK, in which case its Expo versions are kept. Bare demo apps keep their Expo packages.
  - Nothing else changes, and nothing is added apart from the jest preset.

Lockfiles are regenerated. Each check then runs the package's `prepare` commands; each platform build
runs `expo prebuild` for Expo demo apps, and iOS runs `pod install` and builds for the simulator
without code signing, while Android builds one architecture in debug. All of that counts as the
platform's build.

#### What the harness changes in a demo app

A failed build may come from the demo app and not from the library; the checks panel shows which
check failed, and the build's `swap.txt` lists every change below that was made. Compared with what
the library published at its tag:

1. **Package versions**: React Native and what moves with it, by the three cases above.
2. **Jest preset**: switched only across lines, when `@react-native/jest-preset` exists or stops
   existing for the target line.
3. **Expo SDK**: across lines only, and only when the closest SDK is not the one the demo app uses.
4. **Gradle wrapper**: always set to the Gradle version of the React Native app template for the
   target line, because the React Native version dictates it and a demo app's committed wrapper can
   be too old even for its own React Native version. For Expo demo apps it is set right after
   `expo prebuild` generates it. A line without a template keeps the demo app's wrapper.
5. **`ios/.xcode.env.local`**: removed from bare demo apps that commit it. It is per machine by
   design and points Xcode at its author's own Node.
6. **The library's own build**: the `prepare` commands from `harness.json` run before the tests and
   before each native build, because the demo app consumes the compiled library.

Nothing else in the demo app is touched.

Network fetches inside a check are retried so a download failure is not recorded as the library's
failure: the Gradle wrapper's download of Gradle and `pod install`, `bundle install` and
`expo prebuild` get three tries, and Gradle retries its own dependency downloads. Network access
inside `xcodebuild` and inside a library's own scripts is not retried.

### What is and is not recorded

- `buildIos` and `buildAndroid` record `passed` or `failed`. `tests` records `passed` or `failed`, or
  `none` when `harness.json` says the library has no test suite. A failing check never stops the
  others, so the page can show which one failed.
- If the setup fails (bad inputs, no such tag, the swap, the install), the check fails and leaves no
  result: the cell keeps its previous one.
- The watcher takes the package and both versions from the build's inputs as Codemagic reports them,
  and from `result.json` only the three outcomes, which must be exactly `passed` or `failed` (or
  `none` for tests, and only where `harness.json` says so). A small, strictly shaped file is required.
- A result is written only when its cell is missing or older, and a build whose id already appears in
  a cell's `buildUrl` is not looked at again, so recording is idempotent.
- If a package file still has the optional `mock` flag, its first real result removes the mock
  results and the flag.
- Every write is validated with the site's own rules first, then committed with `[skip ci]` and
  pushed; a rejected push is retried on a fresh copy of the branch, up to five times.
- Logs, `swap.json` and the per-check outcomes are kept as build artifacts next to `result.json`.

### Running a check locally

You need Node 22, corepack, the Android SDK, Java 17, Xcode and CocoaPods. From the repository, with
the work and output folders somewhere outside it:

```sh
export COMPAT_WORK_DIR=/tmp/rn-green-work COMPAT_OUT_DIR=/tmp/rn-green-out
export COMPAT_PACKAGE=react-native-screenshot-aware COMPAT_LIBRARY_VERSION=2.1.3
export COMPAT_REACT_NATIVE_VERSION=0.87.1 COMPAT_RECORD=false
node scripts/compat/validate-inputs.mjs && node scripts/compat/checkout.mjs &&
  node scripts/compat/swap.mjs && node scripts/compat/install.mjs &&
  node scripts/compat/check.mjs tests && node scripts/compat/check.mjs android &&
  node scripts/compat/check.mjs ios && node scripts/compat/compose-result.mjs
```

The outcomes are in `$COMPAT_OUT_DIR/result.json` and the logs in `$COMPAT_OUT_DIR/logs/`. To preview
what the watcher would do, without writing, pushing or starting anything (without API credentials it
skips the Codemagic part):

```sh
WATCH_DRY_RUN=true node --experimental-strip-types scripts/compat/watch.mjs
```

`node --experimental-strip-types scripts/compat/validate-data.mjs` checks `compatibility-data/` with
the site's rules.
