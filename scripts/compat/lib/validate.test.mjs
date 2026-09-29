import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './config.mjs';

describe("the site's rules under plain Node", () => {
  // open-pr.mjs validates data with src/lib/compat.ts, loaded by Node's type stripping (Node 22 on
  // Codemagic). Stripping only handles erasable TypeScript: an `enum` or a constructor parameter
  // property there would break recording on Codemagic, so it has to fail here first.
  it('loads src/lib/compat.ts and validates the catalog and results the way open-pr.mjs does', () => {
    const script = [
      "import { readResultsFiles, validateData } from './scripts/compat/lib/validate.mjs';",
      "import { readFileSync } from 'node:fs';",
      "await validateData({ catalogText: readFileSync('green-packages.toml', 'utf8'), results: readResultsFiles() });",
      "process.stdout.write('ok');",
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('ok');
    expect(child.status).toBe(0);
  });
});
