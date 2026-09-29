import { describe, expect, it } from 'vitest';
import { client, ensurePull, GitHubError, isRepoSlug, pickRepository, slugFromRemoteUrl } from './github.mjs';

const TOKEN = 'ghp_example_not_a_real_token';

/** A stand-in fetch: answers from `routes` ("METHOD url" -> response) and keeps every request. */
function stub(routes) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.origin}${parsed.pathname}`;
    requests.push({ url: String(url), method: init.method, headers: init.headers, redirect: init.redirect });
    const answer = routes[key];
    if (!answer) return new Response('not found', { status: 404 });
    const { status = 200, body, headers } = typeof answer === 'function' ? answer() : answer;
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, requests };
}

describe('slugFromRemoteUrl', () => {
  it('reads https and ssh remotes on github.com', () => {
    expect(slugFromRemoteUrl('git@github.com:codemagic-ci-cd/rn.green.git\n')).toBe('codemagic-ci-cd/rn.green');
    expect(slugFromRemoteUrl('https://github.com/codemagic-ci-cd/react-native.green')).toBe('codemagic-ci-cd/react-native.green');
    expect(slugFromRemoteUrl('ssh://git@github.com/owner/name.git')).toBe('owner/name');
  });

  it('refuses other hosts and odd names', () => {
    expect(slugFromRemoteUrl('https://gitlab.com/owner/name.git')).toBeNull();
    expect(slugFromRemoteUrl('/tmp/remote.git')).toBeNull();
    expect(isRepoSlug('owner/..')).toBe(false);
    expect(isRepoSlug('owner/name/extra')).toBe(false);
  });
});

describe('client', () => {
  const PULLS = 'GET https://api.github.com/repos/o/n/pulls';
  const find = (fetchImpl, repo = 'o/n') => client({ token: TOKEN, fetchImpl, wait: async () => {} }).findOpenPull(repo, 'compat/x', 'main');

  it('sends the token in the Authorization header only, to api.github.com', async () => {
    const { fetchImpl, requests } = stub({ [PULLS]: { body: [] } });
    expect(await find(fetchImpl)).toBeNull();
    expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].url).not.toContain(TOKEN);
    expect(requests[0].redirect).toBe('manual');
    expect(new URL(requests[0].url).searchParams.get('head')).toBe('o:compat/x');
  });

  it('follows a redirect on api.github.com', async () => {
    const { fetchImpl, requests } = stub({
      'GET https://api.github.com/repos/o/old/pulls': { status: 301, headers: { location: 'https://api.github.com/repositories/42/pulls' } },
      'GET https://api.github.com/repositories/42/pulls': { body: [{ number: 3, html_url: 'https://github.com/o/new/pull/3' }] },
    });
    expect((await find(fetchImpl, 'o/old')).number).toBe(3);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/repos/o/old/pulls', '/repositories/42/pulls']);
  });

  it('does not follow a redirect to another host, so the header never leaves', async () => {
    const { fetchImpl, requests } = stub({ [PULLS]: { status: 302, headers: { location: 'https://example.com/steal' } } });
    await expect(find(fetchImpl)).rejects.toThrow(/another host/);
    expect(requests).toHaveLength(1);
  });

  it('retries server errors, then gives up with the status', async () => {
    const { fetchImpl, requests } = stub({ [PULLS]: { status: 502, body: {} } });
    const error = await find(fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(502);
    expect(requests).toHaveLength(3);
  });
});

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

describe('pickRepository', () => {
  const origin = (url) => async () => url;

  it('takes COMPAT_REPOSITORY first, then CM_REPO_SLUG, then the origin remote', async () => {
    const env = { COMPAT_REPOSITORY: 'o/set', CM_REPO_SLUG: 'o/codemagic' };
    expect(await pickRepository(env, origin('git@github.com:o/origin.git'))).toEqual({ slug: 'o/set', source: 'COMPAT_REPOSITORY' });
    expect(await pickRepository({ CM_REPO_SLUG: 'o/codemagic' }, origin('git@github.com:o/origin.git'))).toEqual({ slug: 'o/codemagic', source: 'CM_REPO_SLUG' });
    expect(await pickRepository({}, origin('git@github.com:o/origin.git'))).toEqual({ slug: 'o/origin', source: 'the origin remote' });
  });

  it('asks for the origin remote only when neither variable is set', async () => {
    let asked = false;
    await pickRepository({ COMPAT_REPOSITORY: 'o/set' }, async () => ((asked = true), null));
    expect(asked).toBe(false);
  });

  it('refuses a name that is not owner/name, and an origin that is not on github.com', async () => {
    expect(await pickRepository({ COMPAT_REPOSITORY: 'https://github.com/o/n' }, origin(null))).toEqual({ error: 'COMPAT_REPOSITORY is not an owner/name repository name.' });
    expect((await pickRepository({}, origin('/tmp/remote.git'))).error).toMatch(/Could not tell the repository/);
  });
});
