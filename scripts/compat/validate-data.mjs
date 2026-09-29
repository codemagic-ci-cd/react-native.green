// Validates green-packages.toml and compatibility-data/ with the site's own rules. Handy before
// committing by hand:
//   node --experimental-strip-types scripts/compat/validate-data.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_FILE } from './lib/catalog.mjs';
import { REPO_ROOT } from './lib/config.mjs';
import { fail } from './lib/proc.mjs';
import { readResultsFiles, validateData } from './lib/validate.mjs';

try {
  const results = readResultsFiles();
  await validateData({ catalogText: readFileSync(join(REPO_ROOT, CATALOG_FILE), 'utf8'), results });
  process.stdout.write(`${CATALOG_FILE} and ${results.length} results file${results.length === 1 ? '' : 's'} are valid.\n`);
} catch (error) {
  fail(error.message);
}
