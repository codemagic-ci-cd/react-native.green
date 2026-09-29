// Step 1 of compatibility-check: validate the build inputs, which arrive as environment variables
// (see codemagic.yaml), and save them for the later steps.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { outDir, readRepoData, writeJson } from './lib/config.mjs';
import { validateCheckInputs } from './lib/inputs.mjs';
import { fail } from './lib/proc.mjs';

let data;
try {
  data = readRepoData();
} catch (error) {
  fail(error.message);
}
const result = validateCheckInputs(
  {
    package: process.env.COMPAT_PACKAGE,
    libraryVersion: process.env.COMPAT_LIBRARY_VERSION,
    reactNativeVersion: process.env.COMPAT_REACT_NATIVE_VERSION,
    record: process.env.COMPAT_RECORD,
  },
  data,
);

if (!result.ok) fail(`Invalid inputs:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);

rmSync(outDir(), { recursive: true, force: true });
writeJson(join(outDir(), 'inputs.json'), result.value);
const v = result.value;
process.stdout.write(
  `Checking ${v.package} ${v.libraryVersion} on React Native ${v.reactNativeVersion}` +
    ` (cell ${v.libraryLine} x ${v.reactNativeLine}; ${v.record ? 'the result goes to a pull request' : 'COMPAT_RECORD is off: no pull request'}).\n`,
);
