# rn.green

rn.green shows whether a React Native library works on each React Native version. A cell is
**compatible** only when the library's demo app builds on iOS and Android **and** its test suite
passes, if it has one. Patch versions are folded into minor lines (`2.1.3` counts as `2.1.x`).

The site is static, built with [Astro](https://astro.build). No cell has a result until the first
Codemagic run.

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

Two kinds of file. The build fails, naming the file and field, if either is invalid.

- **`green-packages.toml`**, the catalog: which packages are covered, which versions are checked, and
  how each package is tested and built. We write it by hand, new releases included for now.
- **`compatibility-data/<package name>/compatibility.json`**: the results. They arrive through the
  pull requests that `compatibility-check` opens; nobody edits them by hand.

### The catalog: `green-packages.toml`

```toml
schema = 1

[react-native]
versions = ["0.88.0-rc.3", "0.87.1", "0.86.3"]

[[package]]
name = "react-native-screenshot-aware"
repository = "https://github.com/huextrat/react-native-screenshot-aware"
description = "React Native module for real-time screenshot detection on Android and iOS"
license = "MIT"
versions = ["2.1.3", "2.0.0", "1.3.21"]

[package.source]
tag = "v{version}"
dir = "."

[package.setup]
install = ["."]
prepare = [{ dir = ".", run = ["yarn", "prepare"] }]

[package.test]
dir = "."
run = ["yarn", "test"]

[package.demo]
dir = "example"
```

- `[react-native] versions` are the table columns. Each version is exact and stands for its minor
  line, one version per line. A version with a prerelease tag (`-rc.3`) is shown as a release
  candidate.
- Each `[[package]]` gets a page at `/<name>/` and a badge at `/badge/<name>.svg`. `name` follows
  npm's rules and must be unique. `repository` is an `https://` link. `description` and `license` are
  optional.
- `versions` are the library versions that are checked, one per minor line, newest first by
  convention.
- `enabled = false` keeps a package on the site and refuses checks for it with `record` on. It is
  optional; the default is `true`.
- Unknown keys are an error at every level, so a misspelt field fails the build.

The `source`, `setup`, `test` and `demo` tables are the package's **settings**: how a check builds and
tests it. A package without any of them is listed on the site and never checked. Once one is
present, `test` and `demo` are both required, so a forgotten `test` can never turn "tests not run"
into "compatible".

| Setting | Default | Meaning |
| --- | --- | --- |
| `source.tag` | `v{version}` | Release tag. `{version}` is the only placeholder (`@react-navigation/core@{version}`) |
| `source.dir` | `.` | Where the package sits in its repository (`packages/react-native-reanimated`) |
| `setup.install` | `["."]` | Folders to install in, in order, each with the package manager it declares. Some demo apps install separately (`[".", "example"]`) |
| `setup.prepare` | `[]` | Commands run before the tests and before each native build, such as the package's own build: `[{ dir = ".", run = ["yarn", "prepare"] }]` |
| `setup.env` | `{}` | Extra environment for every library command (`{ RNS_GAMMA_ENABLED = "1" }`) |
| `setup.node` | the workflow's (22) | Node version for library commands (`"24"`, `"24.9"`). When the workflow's Node does not match, the check downloads the newest matching release from nodejs.org, checks it against the release's `SHASUMS256.txt`, and puts it first in `PATH` for library commands only |
| `test.run` | required | The test command as an argument list, or `"none"` when the library has no test suite |
| `test.dir` | | Where to run the test command. Required with a command, not allowed with `"none"` |
| `demo.dir` | required | The demo app that is built (`apps/fabric-example`). Not `.` |
| `demo.ios-scheme` | found from the workspace | Only when the app's scheme is not named after its workspace or project (`Debug FabricExample`, `ReactTestApp`) |

Commands are argument lists run without a shell. Every folder must stay inside the repository.

### The results: `compatibility.json`

```json
{
  "schemaVersion": 2,
  "package": "react-native-screenshot-aware",
  "results": {
    "2.1": {
      "0.87": {
        "status": "compatible",
        "tested": { "library": "2.1.3", "reactNative": "0.87.1" },
        "checks": { "buildIos": "passed", "buildAndroid": "passed", "tests": "passed" },
        "buildUrl": "https://codemagic.io/app/<app>/build/<build>",
        "testedAt": "2026-09-06T02:14:09Z"
      }
    }
  }
}
```

- Outer keys are library lines, inner keys React Native lines, without leading zeros (`0.80`, not
  `0.080`).
- `package` must be a package of the catalog and match the folder the file is in.
- The file is optional. A package without one has no results; its first pull request creates it.
- A missing cell means the combination has not been tested yet ("Untested" on the site).
- `tested` holds the exact versions tested: `tested.library` is on the outer line and
  `tested.reactNative` on the inner line.
- `buildIos` and `buildAndroid` are `passed` or `failed`. `tests` is `passed`, `failed` or `none`,
  which means the library has no test suite and is judged on its builds alone.
- `status` must be `compatible` exactly when both builds are `passed` and `tests` is `passed` or
  `none`.
- `buildUrl` (optional) links the cell to its Codemagic build and must start with
  `https://codemagic.io/`.
- Results on a line the catalog no longer lists (either axis) are valid and not shown. They are
  dropped the next time a result for that package is written. So retiring a React Native column or a
  library line is a one-line edit of the catalog.

## Adding a package

1. Add a `[[package]]` entry to `green-packages.toml` with its `versions` and settings, and
   `enabled = false`. The site lists it straight away; nothing is checked yet.
2. Start `compatibility-check` by hand with `record` off (see "Starting one check by hand"), for one of
   its versions on one React Native version. Read the logs and adjust the settings until the setup
   works. A red build is fine; a setup that fails is not.
3. Remove `enabled = false`, then start its checks by hand with `record` on, one per cell.

## Compatibility workflow

`codemagic.yaml` defines one workflow, **`compatibility-check`**. Its scripts are in `scripts/compat/`:
plain Node, no build step, with the logic in `scripts/compat/lib/` and its tests beside it.

A person starts it by hand, for one cell: one library version on one React Native version. It
checks the library out at its release tag, points the library's own demo app at that React Native
version, installs, runs the library's test suite, builds the demo app for Android and for iOS, and
saves the three outcomes as `result.json`. It follows the package's settings in the catalog. Then,
with `record` on, it sends the result to this repository as a pull request.

**One pull request per package.** Results for a package collect on the branch `compat/<package>`
(`compat/@react-navigation/core`; a character git does not allow in a branch name is written as
`%` and its hex code). The branch is always the base branch plus exactly one commit, holding every
result of that package that the base branch does not have yet. Each new result rebuilds that commit
from the base branch and pushes it with a lease on the tip it read, so two builds finishing together
never overwrite each other (the later one starts again), and the pull request never conflicts with
the base branch. Its title counts the results (`compat: react-native-screens: 3 results`) and its
description lists them, written again from the data each time.

- Review the pull request and merge it (squash is fine). The next result for that package opens a
  new one with only the new cells.
- If you close a pull request without merging, **delete its branch** too. Otherwise the next result
  for that package carries the closed cells forward.
- A result is only written over an older one: a cell the base branch already has with a newer result
  is left alone.

A check whose setup fails leaves no result and opens nothing.

### New releases

Detection of new releases is not active. Versions in `green-packages.toml` are edited by hand for
now. The code for detecting them (`scripts/compat/watch.mjs` and its libraries) is kept in the
repository for later; no workflow runs it.

### Credentials

One variable group, `default`, with one variable, `GITHUB_TOKEN`: a fine-grained GitHub token
for this repository only, with **Contents** and **Pull requests** set to read and write. The last
step uses it to push the package's branch and to open or update its pull request. Mark the value
**Secret** and give the token an expiry date.

How the token is handled:

- git gets it through a credential helper that reads the variable, so it never appears in a remote
  URL, in `.git/config` or in a log. Those git commands ignore the machine's git configuration and
  run no hooks.
- The GitHub API gets it only at `https://api.github.com`, in the `Authorization` header. Redirects to
  any other host are not followed.
- Every command the scripts start for the library (installs, tests, Gradle, CocoaPods, `xcodebuild`)
  runs without it in its environment.

**The remaining risk.** The same build runs the library's own code: its install scripts, tests and
build scripts. Keeping the token out of their environment is not isolation. On a build machine a
process can read the environment of the processes that started it (`ps eww` on macOS), and code that
runs in an early step can change what a later step runs, including the script that uses the token.
So a hostile or compromised library, or one of its dependencies, could take the token and push to
this repository or open pull requests with it. What limits the damage:

- **Protect `main`** so that it only changes through a pull request with an approving review, and
  so that nobody pushes to it directly. Then the token can at most push other branches and open pull
  requests, which a person reviews before anything reaches the site.
- Keep the token limited to this repository, with only the two permissions above.
- Give it an expiry date, and replace it if a check ever misbehaves.

### Setting up Codemagic

1. Add the app to Codemagic.
2. In the app's settings, create the variable group `default` with `GITHUB_TOKEN` (see
   "Credentials"), and mark the value **Secret**.
3. Start `compatibility-check` by hand with `record` off (see "Starting one check by hand"). It runs
   the checks and opens nothing. Read the logs.
4. Start it again with `record` on. It opens a pull request for the package.
5. Review the pull request and merge it.

There is no schedule, no Codemagic API token and no webhook.

### Starting one check by hand

In the Codemagic UI, start `compatibility-check` and fill in `package`, `library_version` and
`react_native_version`, and leave `record` on to get a pull request.

Inputs are checked before anything runs, and again against the base branch's catalog before the
result is sent. The package must be in the catalog with settings, and the versions must be exact.
With `record` on, the package must also be enabled and both versions must be on lines the catalog
lists. With `record` off, any exact versions and a disabled package are accepted, which is how draft
settings are tried.

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

Lockfiles are regenerated. Each check then runs the package's `setup.prepare` commands; each platform
build runs `expo prebuild` for Expo demo apps, and iOS runs `pod install` and builds for the
simulator without code signing, while Android builds one architecture in debug. All of that counts
as the platform's build.

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
6. **The library's own build**: the `setup.prepare` commands run before the tests and before each
   native build, because the demo app consumes the compiled library.
7. **The library itself**: when the demo app names the library under test with a registry version or
   range, that dependency is pointed at the checked-out package (`source.dir`) with a relative
   path: `link:` for yarn and pnpm, `file:` for npm. Otherwise the demo app would build the version
   published on npm, not the tagged code. A dependency that is already `workspace:`, `link:`,
   `file:`, `portal:` or a path is left alone. This applies in all three cases, "same version"
   included.

Nothing else in the demo app is touched.

Network fetches inside a check are retried so a download failure is not recorded as the library's
failure: the Gradle wrapper's download of Gradle and `pod install`, `bundle install` and
`expo prebuild` get three tries, and Gradle retries its own dependency downloads. Network access
inside `xcodebuild` and inside a library's own scripts is not retried.

### What is and is not recorded

- `buildIos` and `buildAndroid` record `passed` or `failed`. `tests` records `passed` or `failed`, or
  `none` when the catalog says the library has no test suite (`test.run = "none"`). A failing check
  never stops the others, so the page can show which one failed.
- If the setup fails (bad inputs, no such tag, the swap, the Node download, the install), the check
  fails and leaves no result: the cell keeps its previous one.
- The pull request step takes the package and both versions from the build's inputs, checked again,
  and from `result.json` only the three outcomes, which must be exactly `passed` or `failed` (or
  `none` for tests, and only where the catalog says so). A small, strictly shaped file is required.
- Each cell links to its Codemagic build and records when the result was sent.
- The results file is validated with the site's own rules before it is committed; a rejected push is
  retried on a fresh copy of the base branch, up to five times.
- Logs, `swap.json` (which also records the Node version library commands used) and the per-check
  outcomes are kept as build artifacts next to `result.json`.

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

The outcomes are in `$COMPAT_OUT_DIR/result.json` and the logs in `$COMPAT_OUT_DIR/logs/`. With
`COMPAT_RECORD=true` and `GITHUB_TOKEN` set, the same command line can end with
`node --experimental-strip-types scripts/compat/open-pr.mjs`, which pushes the branch and opens the
pull request on GitHub like the workflow does. `COMPAT_REMOTE_URL` sends the branch to another git
remote instead; the pull request calls still go to GitHub.

`node --experimental-strip-types scripts/compat/validate-data.mjs` checks `green-packages.toml` and
`compatibility-data/` with the site's rules.
