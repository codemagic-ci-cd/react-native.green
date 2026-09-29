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

/** `owner/name`, as GitHub spells a repository. */
export const isRepoSlug = (value) => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split('/').includes('..');

/**
 * The repository's `owner/name` from a git remote URL (https or ssh form on github.com), or null.
 */
export function slugFromRemoteUrl(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match && isRepoSlug(match[1]) ? match[1] : null;
}

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
    /** The repository, and whether the token may push to it (null when GitHub does not say). */
    async getRepo(slug) {
      const repo = await call('GET', repoPath(slug));
      if (!isRepoSlug(repo?.full_name)) throw new Error('GitHub answered without a usable full_name');
      const push = repo.permissions?.push;
      return { fullName: repo.full_name, canPush: typeof push === 'boolean' ? push : null };
    },

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
 * The repository the result goes to, `owner/name`: COMPAT_REPOSITORY (set in codemagic.yaml), else
 * the one Codemagic builds from (CM_REPO_SLUG), else the origin remote of this clone.
 * @param {Record<string, string | undefined>} env
 * @param {() => Promise<string | null>} originUrl  the origin remote's URL, asked only when needed
 * @returns {Promise<{ slug: string, source: string } | { error: string }>}
 */
export async function pickRepository(env, originUrl) {
  for (const source of ['COMPAT_REPOSITORY', 'CM_REPO_SLUG']) {
    const value = env[source];
    if (value) return isRepoSlug(value) ? { slug: value, source } : { error: `${source} is not an owner/name repository name.` };
  }
  const url = await originUrl();
  const slug = url ? slugFromRemoteUrl(url) : null;
  if (!slug) return { error: 'Could not tell the repository: COMPAT_REPOSITORY and CM_REPO_SLUG are not set and the origin remote is not a github.com repository.' };
  return { slug, source: 'the origin remote' };
}

const likelyCauses = (name) =>
  `Likely causes: the repository name is wrong or the repository was renamed (set COMPAT_REPOSITORY in codemagic.yaml); ` +
  `the organization has not approved the token yet; ${name} is not among the token's selected repositories; ` +
  "or the token's Contents permission is not read and write.";

/**
 * Checks that the token can push to the repository, with one lookup. The name is used as given for
 * everything else. When GitHub's answer does not say whether the token can push, the check passes:
 * the push itself will tell.
 * @throws with a message that names the repository and what to check
 */
export async function checkPushAccess(api, slug) {
  let repo;
  try {
    repo = await api.getRepo(slug);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) throw new Error(`GitHub does not show ${slug} to the token (404). ${likelyCauses(slug)}`);
    throw new Error(`Could not read ${slug} from GitHub: ${error.message}`);
  }
  if (repo.canPush === false) throw new Error(`The token can read ${slug} but not push to it. ${likelyCauses(slug)}`);
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
