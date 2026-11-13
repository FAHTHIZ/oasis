// Latest-release lookups that survive GitHub API rate limits.
//
// Unauthenticated API calls are limited to 60 an hour per IP address, which
// shared offices, schools, VPNs and CI runners exhaust quickly. When the API
// answers 403 or 429, the same facts are read from github.com itself:
//   - the tag from the redirect of /releases/latest,
//   - the asset list from /releases/expanded_assets/<tag>,
//   - the tag's commit from the /commits/<tag>.atom feed.
// A GH_TOKEN or GITHUB_TOKEN in the environment is sent to api.github.com only.
// Downloads are verified against SHA256SUMS later, whichever path found them.

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function githubApiHeaders(env = process.env, userAgent = 'oasis') {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': userAgent };
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (token && /^[\w.-]{20,255}$/.test(token)) headers.authorization = 'Bearer ' + token;
  return headers;
}

function rateLimited(response) {
  return response && (response.status === 403 || response.status === 429);
}

function webRequest(timeoutMs, userAgent, redirect = 'follow') {
  return { headers: { 'user-agent': userAgent, accept: 'text/html,application/atom+xml' }, redirect, signal: AbortSignal.timeout(timeoutMs || 15000) };
}

// Tag of the newest stable (non-draft, non-prerelease) release, from github.com.
async function latestTagFromWeb(repository, { fetchImpl = fetch, timeoutMs, userAgent = 'oasis' } = {}) {
  const response = await fetchImpl('https://github.com/' + repository + '/releases/latest', webRequest(timeoutMs, userAgent, 'manual'));
  if (response.status === 404) return null;
  const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : '';
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(String(location || ''));
  if (!match) {
    if (response.status >= 300 && response.status < 400) return null;
    throw new Error('github.com returned HTTP ' + response.status + ' while looking up the latest release.');
  }
  const tag = decodeURIComponent(match[1]);
  return TAG.test(tag) ? tag : null;
}

export function parseExpandedAssets(html, repository, tag) {
  const prefix = '/' + repository + '/releases/download/' + tag + '/';
  const seen = new Set();
  const assets = [];
  const pattern = /href="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const href = match[1].replace(/&amp;/g, '&');
    if (!href.startsWith(prefix)) continue;
    const name = decodeURIComponent(href.slice(prefix.length));
    if (!name || name.includes('/') || seen.has(name)) continue;
    seen.add(name);
    assets.push({ name, size: 0, browser_download_url: 'https://github.com' + prefix + encodeURIComponent(name) });
  }
  return assets;
}

async function releaseFromWeb(repository, tag, { fetchImpl = fetch, timeoutMs, userAgent = 'oasis' } = {}) {
  const response = await fetchImpl('https://github.com/' + repository + '/releases/expanded_assets/' + encodeURIComponent(tag), webRequest(timeoutMs, userAgent));
  if (!response.ok) throw new Error('github.com returned HTTP ' + response.status + ' while listing release ' + tag + '.');
  return {
    tag_name: tag,
    name: 'OASIS ' + tag,
    draft: false,
    prerelease: false,
    body: '',
    published_at: '',
    html_url: 'https://github.com/' + repository + '/releases/tag/' + encodeURIComponent(tag),
    assets: parseExpandedAssets(await response.text(), repository, tag),
    source: 'web'
  };
}

// The latest stable release in GitHub API shape, or null when none exists.
export async function fetchLatestRelease(repository, { fetchImpl = fetch, env = process.env, timeoutMs, userAgent = 'oasis' } = {}) {
  const response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases/latest', {
    headers: githubApiHeaders(env, userAgent), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  if (response.status === 404) return null;
  if (response.ok) return await response.json();
  if (!rateLimited(response)) throw new Error('GitHub returned HTTP ' + response.status + ' while checking for the latest stable release.');
  const tag = await latestTagFromWeb(repository, { fetchImpl, timeoutMs, userAgent });
  return tag ? await releaseFromWeb(repository, tag, { fetchImpl, timeoutMs, userAgent }) : null;
}

export async function resolveTagCommit(repository, tag, { fetchImpl = fetch, env = process.env, timeoutMs, userAgent = 'oasis' } = {}) {
  const response = await fetchImpl('https://api.github.com/repos/' + repository + '/commits/' + encodeURIComponent(tag), {
    headers: githubApiHeaders(env, userAgent), signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  let sha = '';
  if (response.ok) {
    const commit = await response.json();
    sha = String(commit && commit.sha || '').toLowerCase();
  } else if (rateLimited(response)) {
    const feed = await fetchImpl('https://github.com/' + repository + '/commits/' + encodeURIComponent(tag) + '.atom', webRequest(timeoutMs, userAgent));
    if (!feed.ok) throw new Error('github.com returned HTTP ' + feed.status + ' while resolving release ' + tag + '.');
    const match = /Commit\/([0-9a-f]{40})/i.exec(await feed.text());
    sha = match ? match[1].toLowerCase() : '';
  } else {
    throw new Error('GitHub returned HTTP ' + response.status + ' while resolving release ' + tag + '.');
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not return a valid commit id for release ' + tag + '.');
  return sha;
}
