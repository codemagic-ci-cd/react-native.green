import { describe, expect, it } from 'vitest';
import { classifyPushFailure, deniedMessage, redact } from './git.mjs';

describe('classifyPushFailure', () => {
  it('reads a refusal from GitHub, with the account it names', () => {
    const github403 = [
      'remote: Permission to codemagic-ci-cd/reactnative.green.git denied to CHOIMINSEOK.',
      "fatal: unable to access 'https://github.com/codemagic-ci-cd/reactnative.green.git/': The requested URL returned error: 403",
    ].join('\n');
    expect(classifyPushFailure(github403)).toEqual({ kind: 'denied', account: 'CHOIMINSEOK' });
  });

  it('reads other refusals as refusals too', () => {
    for (const output of [
      "fatal: unable to access 'https://github.com/o/n.git/': The requested URL returned error: 401",
      "fatal: Authentication failed for 'https://github.com/o/n.git/'",
      'remote: Invalid username or token. Password authentication is not supported for Git operations.',
      "remote: Repository not found.\nfatal: repository 'https://github.com/o/n.git/' not found",
    ]) {
      expect([output, classifyPushFailure(output).kind]).toEqual([output, 'denied']);
    }
  });

  it('reads a moved branch: a lease that no longer matches, or a non-fast-forward', () => {
    for (const output of [
      "To https://github.com/o/n.git\n ! [rejected]        HEAD -> compat/x (stale info)\nerror: failed to push some refs to 'https://github.com/o/n.git'",
      ' ! [rejected]        HEAD -> compat/x (fetch first)',
      ' ! [rejected]        HEAD -> compat/x (non-fast-forward)',
      "remote: error: cannot lock ref 'refs/heads/compat/x': is at 47cf788 but expected 272b8e8\n ! [remote rejected] HEAD -> compat/x (failed to update ref)",
    ]) {
      expect([output, classifyPushFailure(output).kind]).toEqual([output, 'moved']);
    }
  });

  it('leaves anything else to git’s own message', () => {
    expect(classifyPushFailure('remote: error: GH013: Repository rule violations found for refs/heads/compat/x.\n ! [remote rejected] HEAD -> compat/x (push declined due to repository rule violations)').kind).toBe('other');
    expect(classifyPushFailure("fatal: unable to access 'https://github.com/o/n.git/': Could not resolve host: github.com").kind).toBe('other');
  });
});

describe('deniedMessage', () => {
  it('names the repository and the account, and lists the causes in order', () => {
    const message = deniedMessage('codemagic-ci-cd/reactnative.green', 'CHOIMINSEOK');
    expect(message.split('\n')).toEqual([
      'GitHub refused to let the token push to codemagic-ci-cd/reactnative.green (it reported the account CHOIMINSEOK).',
      'Likely causes, most likely first:',
      "  - the token's resource owner is a personal account, not the organization that owns the repository;",
      '  - the organization has not approved the token yet;',
      "  - the repository is not among the token's selected repositories;",
      "  - the token's Contents permission is not read and write.",
      'For a classic token: it lacks the public_repo or repo scope.',
    ]);
    expect(deniedMessage('o/n')).toMatch(/^GitHub refused to let the token push to o\/n\.\n/);
  });
});

describe('redact', () => {
  it('takes every occurrence of the secret out', () => {
    expect(redact('a ghp_x b ghp_x', 'ghp_x')).toBe('a *** b ***');
    expect(redact('nothing to hide', undefined)).toBe('nothing to hide');
  });
});
