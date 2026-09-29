// The GitHub REST API calls that open-pr.mjs makes. Everything that talks to GitHub's API is here.
//
// The token goes to https://api.github.com only, in the Authorization header. Redirects are followed
// by hand, and only to that host: a renamed repository answers with a redirect, and a redirect to any
// other host would otherwise take the header with it.
const API = 'https://api.github.com';
const API_HOST = 'api.github.com';
const MAX_REDIRECTS = 3;

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The one repository every result pull request goes to. */
export const REPOSITORY = 'codemagic-ci-cd/reactnative.green';

/** `owner/name`, as GitHub spells a repository. */
export const isRepoSlug = (value) => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split('/').includes('..');

/**
 * @param {{ token: string, fetchImpl?: typeof fetch, wait?: (ms: number) => Promise<void> }} options
 */
export function client({ token, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'rn.green-compatibility-check',
  };

  async function call(method, path, { query, body } = {}) {
    let url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    for (let attempt = 1, redirects = 0; ; ) {
      const response = await fetchImpl(url, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        const next = location ? new URL(location, url) : null;
        if (!next || next.protocol !== 'https:' || next.hostname !== API_HOST) {
          throw new GitHubError(`${method} ${url.pathname} redirected to another host; not followed`, response.status);
        }
        if ((redirects += 1) > MAX_REDIRECTS) throw new GitHubError(`${method} ${url.pathname}: too many redirects`, response.status);
        url = next;
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) {
        const text = (await response.text().catch(() => '')).slice(0, 300);
        throw new GitHubError(`${method} ${url.pathname} answered ${response.status}: ${text}`, response.status);
      }
      await wait(2000 * attempt);
      attempt += 1;
    }
  }

  const repoPath = (fullName) => {
    if (!isRepoSlug(fullName)) throw new Error(`not a repository name: ${fullName}`);
    return `/repos/${fullName}`;
  };

  return {
    /** The open pull request from `branch` into `base`, or null. */
    async findOpenPull(fullName, branch, base) {
      const owner = fullName.split('/')[0];
      const pulls = await call('GET', `${repoPath(fullName)}/pulls`, { query: { state: 'open', head: `${owner}:${branch}`, base, per_page: 10 } });
      return Array.isArray(pulls) && pulls.length > 0 ? pulls[0] : null;
    },

    async createPull(fullName, { branch, base, title, body }) {
      return call('POST', `${repoPath(fullName)}/pulls`, { body: { head: branch, base, title, body } });
    },

    async updatePull(fullName, number, { title, body }) {
      return call('PATCH', `${repoPath(fullName)}/pulls/${Number(number)}`, { body: { title, body } });
    },
  };
}

/**
 * Opens the pull request for `branch`, or updates the one that is open. Two builds can finish at the
 * same time: when creating answers 422 because the other one just opened it, it is looked up again
 * and updated.
 * @returns {Promise<{ url: string, number: number, created: boolean }>}
 */
export async function ensurePull(api, fullName, { branch, base, title, body }) {
  const open = await api.findOpenPull(fullName, branch, base);
  if (open) {
    const updated = await api.updatePull(fullName, open.number, { title, body });
    return { url: updated?.html_url ?? open.html_url, number: open.number, created: false };
  }
  try {
    const created = await api.createPull(fullName, { branch, base, title, body });
    return { url: created.html_url, number: created.number, created: true };
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    const raced = await api.findOpenPull(fullName, branch, base);
    if (!raced) throw error;
    const updated = await api.updatePull(fullName, raced.number, { title, body });
    return { url: updated?.html_url ?? raced.html_url, number: raced.number, created: false };
  }
}
