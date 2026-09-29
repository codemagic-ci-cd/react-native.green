// The Codemagic v3 API calls the watcher makes. Everything that talks to Codemagic is here.
import { MAX_RESULT_BYTES, RESULT_FILE } from './artifact.mjs';

const API = 'https://codemagic.io/api/v3';
// Hosts that may receive the API token. An artifact's download URL can point at a storage host
// instead; the token is never sent there.
const CODEMAGIC_HOSTS = new Set(['codemagic.io', 'api.codemagic.io']);

export function client({ token, teamId, appId }) {
  const headers = { 'x-auth-token': token, accept: 'application/json' };

  async function call(method, path, { query, body } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) {
        const text = (await response.text().catch(() => '')).slice(0, 300);
        throw new Error(`${method} ${url.pathname} answered ${response.status}: ${text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  return {
    /** compatibility-check builds of this app, newest first, until one was created before `since`. */
    async listBuilds({ workflowId, since, maxPages = 20 }) {
      const builds = [];
      let cursor;
      for (let page = 0; page < maxPages; page += 1) {
        const body = await call('GET', `/teams/${encodeURIComponent(teamId)}/builds`, {
          query: { app_id: appId, workflow_id: workflowId, page_size: 100, cursor },
        });
        builds.push(...body.data);
        const oldest = body.data.at(-1)?.created_at;
        if (!body.cursor || body.data.length === 0 || (oldest && Date.parse(oldest) < since.getTime())) break;
        cursor = body.cursor;
      }
      return builds.filter((build) => Date.parse(build.created_at) >= since.getTime());
    },

    async getBuild(buildId) {
      return (await call('GET', `/builds/${encodeURIComponent(buildId)}`)).data;
    },

    async startBuild(request) {
      return (await call('POST', `/apps/${encodeURIComponent(appId)}/builds`, { body: request })).data;
    },

    /**
     * Downloads a build's result.json, as-is or zipped, or returns null when it has none. The URL is
     * tried without credentials first; the token is added only for a Codemagic host that asks for it.
     */
    async downloadResult(build) {
      const artifact = build.artifacts?.find((a) => a.name === RESULT_FILE || a.name.endsWith(`/${RESULT_FILE}`) || a.name === `${RESULT_FILE}.zip`);
      if (!artifact) return null;
      if (artifact.size_in_bytes > MAX_RESULT_BYTES * 2) throw new Error(`${artifact.name} is ${artifact.size_in_bytes} bytes, over the limit`);
      const url = new URL(artifact.short_lived_download_url);
      if (url.protocol !== 'https:') throw new Error('artifact download URL is not https');
      let response = await fetch(url);
      if ((response.status === 401 || response.status === 403) && CODEMAGIC_HOSTS.has(url.hostname)) {
        response = await fetch(url, { headers: { 'x-auth-token': token } });
      }
      if (!response.ok) throw new Error(`downloading ${artifact.name} answered ${response.status}`);
      // Read at most a little more than the limit, so an oversized body is detected without keeping it.
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size > MAX_RESULT_BYTES * 2) {
          await reader.cancel();
          break;
        }
      }
      return Buffer.concat(chunks);
    },
  };
}
