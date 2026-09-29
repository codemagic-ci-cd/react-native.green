// The fallback for `pod install` when the demo app's own way (its Gemfile: `bundle install`, then
// `bundle exec pod install`) fails, for example because the repository pins a Ruby version this
// machine does not have. The fallback uses the machine's own Ruby and CocoaPods, without the Gemfile
// and without the repository's Ruby pin.
//
// Ruby version managers (rbenv, asdf, mise, chruby's auto-switching, rvm) read the pin from the
// folders above the current one, through shims or shell hooks. So the machine's own setup is looked up
// from the file system root, where no repository pin applies, and then called by its real path, so no
// shim runs inside the repository:
//   1. the default Ruby, if it has the CocoaPods gem: `<ruby> <pod script> install`;
//   2. otherwise the first `pod` on PATH that works from the root, such as Homebrew's standalone
//      CocoaPods, which carries its own Ruby. A version manager's shim fails that test when the
//      default Ruby has no CocoaPods.
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** Where the machine's own setup is looked up: no repository's version pin applies here. */
export const NEUTRAL_DIR = '/';

/** Ruby that reports the real interpreter (not a shim) and the CocoaPods gem's `pod` script, as JSON. */
export const PROBE_SCRIPT = [
  'require "rbconfig"',
  'require "json"',
  'pod = begin; Gem.bin_path("cocoapods", "pod"); rescue Exception; nil; end',
  'print JSON.generate({ "ruby" => RbConfig.ruby, "version" => RUBY_VERSION, "pod" => pod })',
].join('\n');

/** The probe's answer, or null when it is not what PROBE_SCRIPT prints. */
export function parseProbe(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (typeof value?.ruby !== 'string' || !value.ruby.startsWith('/') || typeof value.version !== 'string') return null;
    return { ruby: value.ruby, version: value.version, pod: typeof value.pod === 'string' && value.pod.startsWith('/') ? value.pod : null };
  } catch {
    return null;
  }
}

const pointsAtBundler = (name) => name.startsWith('BUNDLE_') || name === 'RUBYOPT' || name === 'RUBYLIB';

/**
 * The environment for the fallback: nothing that points Ruby at the Gemfile or at Bundler, and, when
 * the default Ruby is used, its own folder first in PATH, so any `ruby` CocoaPods starts is that one
 * too and not a shim. Commands get `env` over the script's own environment (`base`), so those
 * variables are set to undefined, which leaves them out of the child's environment.
 */
export function fallbackEnv(env, rubyPath, base = process.env) {
  const next = { ...env };
  for (const name of [...Object.keys(base), ...Object.keys(env)]) if (pointsAtBundler(name)) next[name] = undefined;
  if (rubyPath) next.PATH = [dirname(rubyPath), env.PATH ?? base.PATH ?? ''].join(delimiter);
  return next;
}

/** Every `pod` executable on PATH, in PATH order. */
export function podsOnPath(pathValue) {
  const found = [];
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'pod');
    try {
      accessSync(candidate, constants.X_OK);
      if (!found.includes(candidate)) found.push(candidate);
    } catch {
      // not here
    }
  }
  return found;
}

/**
 * Finds the machine's own CocoaPods. `capture(command, args, options)` runs a command and returns
 * { code, stdout }.
 * @returns {Promise<{ command: string, args: string[], env: object, description: string } | { reason: string }>}
 */
export async function findMachinePod(env, capture) {
  const probed = await capture('ruby', ['-e', PROBE_SCRIPT], { cwd: NEUTRAL_DIR, env });
  const ruby = probed.code === 0 ? parseProbe(probed.stdout) : null;
  if (ruby?.pod) {
    return {
      command: ruby.ruby,
      args: [ruby.pod, 'install'],
      env: fallbackEnv(env, ruby.ruby),
      description: `the default Ruby ${ruby.version} (${ruby.ruby}) with its CocoaPods (${ruby.pod})`,
    };
  }
  for (const pod of podsOnPath(env.PATH)) {
    const version = await capture(pod, ['--version'], { cwd: NEUTRAL_DIR, env: fallbackEnv(env) });
    if (version.code === 0) {
      return {
        command: pod,
        args: ['install'],
        env: fallbackEnv(env),
        description: `CocoaPods ${version.stdout.trim()} at ${pod}${ruby ? ` (the default Ruby ${ruby.version} has no CocoaPods)` : ''}`,
      };
    }
  }
  return {
    reason: ruby
      ? `the default Ruby ${ruby.version} (${ruby.ruby}) has no CocoaPods, and no pod on PATH works outside the repository`
      : 'no Ruby answers outside the repository, and no pod on PATH works there',
  };
}

/**
 * One line that says why the last command in a log failed: a Ruby exception line (CocoaPods prints
 * `LoadError - cannot load such file -- kconv` inside a long report), else the last line that reads
 * like an error, else the last line of its output.
 */
export function failureLine(logText) {
  const lines = logText.split('\n');
  let end = lines.length;
  while (end > 0 && !/^\[exit \d+\]$/.test(lines[end - 1])) end -= 1;
  let start = end - 1;
  while (start > 0 && !lines[start - 1].startsWith('$ ')) start -= 1;
  const output = lines.slice(start, Math.max(start, end - 1)).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('(in '));
  const pick =
    output.find((line) => /^[A-Z]\w*(Error|Exception)\b.* - /.test(line)) ??
    output.findLast((line) => /error|not installed|could not|cannot|no such/i.test(line)) ??
    output.at(-1);
  if (!pick) return null;
  return pick.length > 300 ? `${pick.slice(0, 300)}...` : pick;
}
