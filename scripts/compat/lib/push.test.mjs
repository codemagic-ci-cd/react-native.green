import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPackageName } from './catalog.mjs';
import { REPO_ROOT } from './config.mjs';
import { packageOfBranch } from './pull-request.mjs';
import { checkWriteAccess, judgePush, PushDenied, WRITE_CHECK_BRANCH } from './push.mjs';

const DENIED = [
  'remote: Permission to o/n.git denied to someone.',
  "fatal: unable to access 'https://github.com/o/n.git/': The requested URL returned error: 403",
].join('\n');

describe('judgePush', () => {
  const judge = (result) => {
    const said = [];
    try {
      return { moved: judgePush(result, { what: 'The push', repository: 'o/n', say: (line) => said.push(line) }), said };
    } catch (error) {
      return { error, said };
    }
  };

  it('says whether the push landed or the branch only moved', () => {
    expect(judge({ code: 0, output: '' }).moved).toBe(false);
    expect(judge({ code: 1, output: ' ! [rejected]        HEAD -> compat/x (stale info)' }).moved).toBe(true);
  });

  it('throws PushDenied for a refusal, after printing what git said', () => {
    const { error, said } = judge({ code: 128, output: DENIED });
    expect(error).toBeInstanceOf(PushDenied);
    expect(error.message).toMatch(/^GitHub refused to let the token push to o\/n \(it reported the account someone\)\./);
    expect(said).toEqual([DENIED]);
  });

  it("throws git's own message for anything else", () => {
    const { error } = judge({ code: 1, output: 'remote: error: GH013: Repository rule violations found' });
    expect(error).not.toBeInstanceOf(PushDenied);
    expect(error.message).toBe('The push failed; git said:\nremote: error: GH013: Repository rule violations found');
  });
});

describe('checkWriteAccess', () => {
  const fakeGit = (result) => {
    const calls = [];
    return { calls, all: async (args, cwd) => (calls.push({ args, cwd }), result) };
  };

  it('dry-runs a push of HEAD to the branch, and passes when the remote accepts', async () => {
    const git = fakeGit({ code: 0, output: '' });
    await checkWriteAccess(git, { remote: 'https://github.com/o/n.git', branch: 'compat/x', cwd: '/tmp/c', repository: 'o/n' });
    expect(git.calls).toEqual([{ args: ['push', '--dry-run', '--force', '--quiet', 'https://github.com/o/n.git', 'HEAD:refs/heads/compat/x'], cwd: '/tmp/c' }]);
  });

  it('is refused the way a push is', async () => {
    await expect(checkWriteAccess(fakeGit({ code: 128, output: DENIED }), { remote: 'r', branch: 'compat/x', cwd: '.', repository: 'o/n' })).rejects.toBeInstanceOf(PushDenied);
  });
});

describe('WRITE_CHECK_BRANCH', () => {
  it('is a valid branch that no package can have', () => {
    expect(spawnSync('git', ['check-ref-format', '--branch', WRITE_CHECK_BRANCH]).status).toBe(0);
    expect(isPackageName(packageOfBranch(WRITE_CHECK_BRANCH))).toBe(false);
  });
});

describe('check-token.mjs', () => {
  const script = join(REPO_ROOT, 'scripts/compat/check-token.mjs');
  const runScript = (env) => spawnSync(process.execPath, [script], { cwd: REPO_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });

  it('runs before `npm ci`: it and everything it imports use only Node’s own modules', () => {
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)) {
        if (spec.startsWith('node:')) continue;
        expect([file, spec.startsWith('./') || spec.startsWith('../')]).toEqual([file, true]);
        walk(resolve(dirname(file), spec));
      }
    };
    walk(script);
    const names = [...seen].map((f) => f.slice(REPO_ROOT.length + 1));
    expect(names).not.toContain('scripts/compat/lib/config.mjs');
    expect(names).not.toContain('scripts/compat/lib/catalog.mjs');
  });

  it('does nothing when COMPAT_RECORD is off (local runs)', () => {
    const result = runScript({ COMPAT_RECORD: 'false' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/COMPAT_RECORD is off/);
  });

  it('fails clearly without GITHUB_TOKEN', () => {
    const result = runScript({});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GITHUB_TOKEN is not set/);
  });
});
