import { describe, expect, it } from 'vitest';
import { ensurePull, GitHubError } from './github.mjs';

describe('ensurePull', () => {
  const pull = { number: 7, html_url: 'https://github.com/o/n/pull/7' };
  const fake = ({ open = [], createError } = {}) => {
    const calls = [];
    return {
      calls,
      async findOpenPull() {
        calls.push('find');
        return open.shift() ?? null;
      },
      async createPull() {
        calls.push('create');
        if (createError) throw createError;
        return pull;
      },
      async updatePull(_, number) {
        calls.push(`update ${number}`);
        return pull;
      },
    };
  };
  const args = { branch: 'compat/x', base: 'main', title: 't', body: 'b' };

  it('opens a pull request when none is open', async () => {
    const api = fake();
    expect(await ensurePull(api, 'o/n', args)).toEqual({ url: pull.html_url, number: 7, created: true });
    expect(api.calls).toEqual(['find', 'create']);
  });

  it('updates the open one', async () => {
    const api = fake({ open: [pull] });
    expect((await ensurePull(api, 'o/n', args)).created).toBe(false);
    expect(api.calls).toEqual(['find', 'update 7']);
  });

  it('updates the one another build opened a moment earlier', async () => {
    const api = fake({ open: [null, pull], createError: new GitHubError('already exists', 422) });
    expect((await ensurePull(api, 'o/n', args)).created).toBe(false);
    expect(api.calls).toEqual(['find', 'create', 'find', 'update 7']);
  });

  it('passes on any other failure', async () => {
    const api = fake({ createError: new GitHubError('forbidden', 403) });
    await expect(ensurePull(api, 'o/n', args)).rejects.toThrow(/forbidden/);
  });
});
