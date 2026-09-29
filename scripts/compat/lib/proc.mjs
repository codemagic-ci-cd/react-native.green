// Running commands for the compatibility scripts.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Credentials never reach a child process. This only keeps them out of the child's own environment:
// on macOS any process can read its parent's environment with `ps eww`, so it is not isolation.
export const SECRET_VARIABLES = ['GITHUB_TOKEN', 'CM_API_TOKEN'];

export function childEnv(extra = {}, base = process.env) {
  const env = { ...base, ...extra };
  for (const name of SECRET_VARIABLES) delete env[name];
  return env;
}

/**
 * Runs a command without a shell (arguments are never re-parsed), streaming output to the console
 * and, when `log` is given, to that file too.
 * @returns {Promise<number>} the exit code (1 when the process could not start or was killed)
 */
export function run(command, args, { cwd, env = {}, log, secrets = false } = {}) {
  return new Promise((resolve) => {
    let logStream;
    if (log) {
      mkdirSync(dirname(log), { recursive: true });
      logStream = createWriteStream(log, { flags: 'a' });
      logStream.write(`$ ${[command, ...args].join(' ')}\n  (in ${cwd ?? process.cwd()})\n`);
    }
    const child = spawn(command, args, {
      cwd,
      env: secrets ? { ...process.env, ...env } : childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (target) => (chunk) => {
      target.write(chunk);
      logStream?.write(chunk);
    };
    child.stdout.on('data', forward(process.stdout));
    child.stderr.on('data', forward(process.stderr));
    const finish = (code) => {
      logStream?.write(`\n[exit ${code}]\n\n`);
      logStream?.end();
      resolve(code);
    };
    child.on('error', (error) => {
      process.stderr.write(`${command}: ${error.message}\n`);
      logStream?.write(`${command}: ${error.message}\n`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Like run, but captures stdout instead of streaming it; stderr still streams. */
export function capture(command, args, { cwd, env = {}, secrets = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: secrets ? { ...process.env, ...env } : childEnv(env),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ code: 1, stdout }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
