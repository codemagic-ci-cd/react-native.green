# rn.green

rn.green shows whether a React Native library works on each React Native version. A cell is
**compatible** only when the library's demo app builds on iOS and Android **and** its test suite
passes. Patch versions are folded into minor lines (`2.1.3` counts as `2.1.x`).

The site is static, built with [Astro](https://astro.build). The results in this repository are
mock data until the first Codemagic run.

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
  "mock": true,
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
- A missing cell means the combination has not been tested yet ("Queued" on the site).
- `status` must be `compatible` exactly when all three checks are `passed`.
- Every `results` key must be a line in `react-native.json`.
- `buildUrl` (optional) links the cell to its Codemagic build and must start with `https://codemagic.io/`. `mock`, `description` and `license`
  are optional.
