// Last step of compatibility-check: save the three check outcomes as compat-results/result.json, the
// build artifact the watcher records from. It holds nothing else: the watcher takes the package and
// versions from the build's inputs as Codemagic reports them, and composes the cell itself. Fails if
// a check never ran.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { outDir, readJson, writeJson } from './lib/config.mjs';
import { RESULT_SCHEMA_VERSION } from './lib/artifact.mjs';
import { readInputs } from './lib/library.mjs';
import { fail } from './lib/proc.mjs';
import { CHECK_NAMES } from './lib/record.mjs';

const inputs = readInputs();
const checks = {};
for (const name of CHECK_NAMES) {
  const path = join(outDir(), 'checks', `${name}.json`);
  if (!existsSync(path)) fail(`The ${name} check did not run, so there is no result.`);
  checks[name] = readJson(path).result;
}

writeJson(join(outDir(), 'result.json'), { schemaVersion: RESULT_SCHEMA_VERSION, checks });
process.stdout.write(`${inputs.package} ${inputs.libraryVersion} on React Native ${inputs.reactNativeVersion}:\n`);
for (const name of CHECK_NAMES) process.stdout.write(`  ${name}: ${checks[name]}\n`);
