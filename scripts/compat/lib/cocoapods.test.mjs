import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureLine, fallbackEnv, findMachinePod, NEUTRAL_DIR, parseProbe, podsOnPath } from './cocoapods.mjs';

describe('parseProbe', () => {
  it('reads the real interpreter and the CocoaPods script', () => {
    expect(parseProbe('{"ruby":"/usr/local/bin/ruby","version":"4.0.5","pod":"/gems/bin/pod"}')).toEqual({
      ruby: '/usr/local/bin/ruby',
      version: '4.0.5',
      pod: '/gems/bin/pod',
    });
    expect(parseProbe('{"ruby":"/usr/bin/ruby","version":"2.6.10","pod":null}').pod).toBeNull();
  });

  it('refuses anything else', () => {
    expect(parseProbe('rbenv: version `3.3.7\' is not installed')).toBeNull();
    expect(parseProbe('{"ruby":"ruby","version":"3.4.8"}')).toBeNull();
  });
});

describe('fallbackEnv', () => {
  it('leaves out everything that points at the Gemfile or Bundler, from both environments', () => {
    const next = fallbackEnv({ PATH: '/a', BUNDLE_GEMFILE: '/x/Gemfile', CI: '1' }, undefined, { BUNDLE_PATH: 'vendor', RUBYOPT: '-rbundler/setup', HOME: '/h' });
    expect(next).toEqual({ PATH: '/a', CI: '1', BUNDLE_GEMFILE: undefined, BUNDLE_PATH: undefined, RUBYOPT: undefined });
  });

  it("puts the default Ruby's folder first, so no shim answers for ruby", () => {
    expect(fallbackEnv({ PATH: '/shims:/usr/bin' }, '/opt/ruby/bin/ruby', {}).PATH).toBe('/opt/ruby/bin:/shims:/usr/bin');
  });
});

describe('podsOnPath', () => {
  it('lists executable pods in PATH order, once each', () => {
    const root = mkdtempSync(join(tmpdir(), 'pods-'));
    for (const dir of ['shims', 'brew', 'empty']) mkdirSync(join(root, dir));
    for (const dir of ['shims', 'brew']) {
      writeFileSync(join(root, dir, 'pod'), '#!/bin/sh\n');
      chmodSync(join(root, dir, 'pod'), 0o755);
    }
    writeFileSync(join(root, 'empty', 'pod'), 'not executable');
    const path = [join(root, 'empty'), join(root, 'shims'), join(root, 'brew'), join(root, 'shims')].join(':');
    expect(podsOnPath(path)).toEqual([join(root, 'shims', 'pod'), join(root, 'brew', 'pod')]);
  });
});

describe('findMachinePod', () => {
  const calls = [];
  const stubCapture = (answers) => async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return answers[command] ?? { code: 127, stdout: '' };
  };

  it("uses the default Ruby's CocoaPods by its real path, looked up outside any repository", async () => {
    calls.length = 0;
    const found = await findMachinePod(
      { PATH: '/shims' },
      stubCapture({ ruby: { code: 0, stdout: '{"ruby":"/opt/ruby/bin/ruby","version":"4.0.5","pod":"/opt/ruby/gems/bin/pod"}' } }),
    );
    expect(found.command).toBe('/opt/ruby/bin/ruby');
    expect(found.args).toEqual(['/opt/ruby/gems/bin/pod', 'install']);
    expect(found.description).toMatch(/default Ruby 4\.0\.5/);
    expect(calls.every((c) => c.cwd === NEUTRAL_DIR)).toBe(true);
  });

  it('otherwise takes the first pod on PATH that works outside the repository, skipping a shim that does not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pods-'));
    for (const dir of ['shims', 'brew']) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, 'pod'), '#!/bin/sh\n');
      chmodSync(join(root, dir, 'pod'), 0o755);
    }
    const shim = join(root, 'shims', 'pod');
    const brew = join(root, 'brew', 'pod');
    const found = await findMachinePod(
      { PATH: `${join(root, 'shims')}:${join(root, 'brew')}` },
      stubCapture({
        ruby: { code: 0, stdout: '{"ruby":"/r/bin/ruby","version":"3.4.8","pod":null}' },
        [shim]: { code: 127, stdout: '' },
        [brew]: { code: 0, stdout: '1.17.0\n' },
      }),
    );
    expect(found.command).toBe(brew);
    expect(found.args).toEqual(['install']);
    expect(found.description).toBe(`CocoaPods 1.17.0 at ${brew} (the default Ruby 3.4.8 has no CocoaPods)`);
  });

  it('says why there is no fallback', async () => {
    const found = await findMachinePod({ PATH: '' }, stubCapture({ ruby: { code: 0, stdout: '{"ruby":"/r/bin/ruby","version":"3.4.8","pod":null}' } }));
    expect(found.reason).toMatch(/3\.4\.8 .* has no CocoaPods, and no pod on PATH/);
  });
});

describe('failureLine', () => {
  it("finds the version manager's complaint", () => {
    const log = [
      '$ bundle install',
      '  (in /w/library/examples/on-device-demo/ios)',
      "rbenv: version `3.3.7' is not installed (set by /w/library/.ruby-version)",
      '',
      '[exit 1]',
      '',
    ].join('\n');
    expect(failureLine(log)).toBe("rbenv: version `3.3.7' is not installed (set by /w/library/.ruby-version)");
  });

  it("finds the exception inside CocoaPods' crash report, and only in the last command's output", () => {
    const log = [
      '$ bundle install',
      'Bundle complete!',
      '',
      '[exit 0]',
      '',
      '$ bundle exec pod install',
      '  (in /w/ios)',
      '### Error',
      '```',
      'LoadError - cannot load such file -- kconv',
      '/gems/cocoapods/lib/cocoapods.rb:1:in `require`',
      '```',
      '[!] Oh no, an error occurred.',
      'https://github.com/CocoaPods/CocoaPods/issues/new',
      '',
      '[exit 1]',
      '',
    ].join('\n');
    expect(failureLine(log)).toBe('LoadError - cannot load such file -- kconv');
  });
});
