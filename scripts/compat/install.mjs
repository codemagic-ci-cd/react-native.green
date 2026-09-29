// Step 4 of compatibility-check: provide the Node that setup.node asks for, then install, in each
// folder setup.install lists (usually just the root; some demo apps install separately), with the
// package manager that folder declares. Lockfile changes are expected after the swap, so installs are
// never immutable. A failed install is retried twice; if it still fails, the build fails and nothing
// is recorded.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outDir, readJson, workDir, writeJson } from './lib/config.mjs';
import { commands, packageManager, readInputs, repoPath, toolEnv } from './lib/library.mjs';
import { provideNode } from './lib/node-dist.mjs';
import { capture, fail, run } from './lib/proc.mjs';

const ATTEMPTS = 3;
const { settings } = readInputs();
const log = join(outDir(), 'logs', 'install.log');

// Before corepack is enabled, so corepack and every library command come from that Node.
let node;
try {
  node = await provideNode(settings.node, workDir(), { log });
} catch (error) {
  fail(`Could not provide Node ${settings.node} (setup.node): ${error.message}`);
}
const env = toolEnv(settings);
const reported = (await capture('node', ['--version'], { env })).stdout.trim();
if (reported !== node.version) fail(`Library commands would run Node ${reported || '(none)'}, not ${node.version}.`);
const swapFile = join(outDir(), 'swap.json');
writeJson(swapFile, { ...readJson(swapFile), libraryNode: node.version });
process.stdout.write(
  `Library commands use Node ${node.version}` +
    (node.downloaded ? `, downloaded for setup.node "${settings.node}"` : settings.node ? `, which matches setup.node "${settings.node}"` : '') +
    `; the check's own scripts use Node ${process.version}.\n`,
);

// Yarn's npmMinimalAgeGate refuses packages published more recently than the gate allows. A very new
// React Native release then fails to install by design; say so, so nobody hunts for another cause.
function ageGateHint(dir) {
  const yarnrc = join(dir, '.yarnrc.yml');
  const gate = existsSync(yarnrc) ? /^npmMinimalAgeGate:\s*(\S+)/m.exec(readFileSync(yarnrc, 'utf8'))?.[1] : undefined;
  return gate
    ? `\nThis repository's .yarnrc.yml sets npmMinimalAgeGate: ${gate}. Yarn refuses packages published more recently` +
        ' than that, so a React Native version newer than the gate cannot be installed until it is old enough.'
    : '';
}

for (const folder of settings.installs) {
  const dir = repoPath(folder);
  const manager = packageManager(dir);
  if (manager !== 'npm') {
    const enabled = await run('corepack', ['enable', '--install-directory', join(workDir(), 'bin'), manager], { env, log });
    if (enabled !== 0) fail(`corepack could not provide ${manager}.`);
  }
  const [command, args] = commands(manager).install;
  let installed = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !installed; attempt += 1) {
    process.stdout.write(`Installing in ${folder} with ${manager} (attempt ${attempt} of ${ATTEMPTS}).\n`);
    installed = (await run(command, args, { cwd: dir, env, log })) === 0;
  }
  if (!installed) fail(`${manager} install in ${folder} failed ${ATTEMPTS} times; see ${log}.${ageGateHint(dir)}`);
}
