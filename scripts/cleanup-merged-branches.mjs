#!/usr/bin/env node
// Retire only branches whose work is already merged, content-equivalent, or explicitly superseded.
// The script defaults to dry-run; only the main-branch GitHub workflow passes --apply.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;

export const AUDITED_SUPERSEDED_HEADS = new Map([
  ['chore/current-head-verification-status', { sha: '5c719841bc2a399b7668467d6998685ff5d93278', paths: ['STATUS.md', 'CHANGELOG.md'] }],
  ['docs/termux-install-guide-2026-10-29', { sha: 'c676743c1ac889de78a09ac1dcbf18114045a50d', paths: ['docs/TERMUX.md'] }],
  ['installer/painless-cli-2026-10-29', { sha: '984e6c6bfb8ddbd151bdcf4b63ef81e494b739ef', paths: ['scripts/install.sh'] }],
  ['installer/windows-powershell-2026-10-29', { sha: '69b5e88dfc546ed16dafabd436fa8deaec530840', paths: ['scripts/install.ps1'] }]
]);

export function classifyRetirement(branch, comparison, defaultBranch, openPrBranches, mainTree, mergedPrHeads = new Map()) {
  if (!branch?.name) return { retire: false, reason: 'invalid branch record' };
  if (branch.name === defaultBranch) return { retire: false, reason: 'default branch' };
  if (branch.protected) return { retire: false, reason: 'protected branch' };
  if (openPrBranches.has(branch.name)) return { retire: false, reason: 'branch has an open pull request' };

  const audited = AUDITED_SUPERSEDED_HEADS.get(branch.name);
  if (audited && branch.commit?.sha === audited.sha && audited.paths.every((file) => mainTree.has(file))) {
    return { retire: true, reason: 'exact audited branch head is superseded by canonical files on main' };
  }
  if (mergedPrHeads.get(branch.name)?.has(branch.commit?.sha)) {
    return { retire: true, reason: 'exact branch head was merged into the default branch' };
  }
  if (!comparison || !Number.isInteger(comparison.ahead_by) || !Number.isInteger(comparison.behind_by)) {
    return { retire: false, reason: 'comparison is incomplete' };
  }
  if (comparison.status === 'behind' && comparison.ahead_by === 0 && comparison.behind_by > 0) {
    return { retire: true, reason: 'fully behind with zero unique commits' };
  }
  if (comparison.status === 'identical' && comparison.ahead_by === 0 && comparison.behind_by === 0) {
    return { retire: true, reason: 'identical to default branch' };
  }
  if (comparison.ahead_by <= 0 || comparison.too_large === true ||
      !Array.isArray(comparison.files) || comparison.files.length >= 300) {
    return { retire: false, reason: 'branch has unverified or oversized unique changes' };
  }
  const equivalent = comparison.files.every((file) => {
    if (!file || typeof file.filename !== 'string' || !file.filename) return false;
    if (file.status === 'removed') return !mainTree.has(file.filename);
    if (file.status === 'renamed') {
      return typeof file.sha === 'string' && mainTree.get(file.filename) === file.sha &&
        typeof file.previous_filename === 'string' && !mainTree.has(file.previous_filename);
    }
    return typeof file.sha === 'string' && mainTree.get(file.filename) === file.sha;
  });
  return equivalent
    ? { retire: true, reason: 'all net changed file states match the default branch' }
    : { retire: false, reason: 'at least one changed file is not byte-identical to the default branch' };
}

function apiRoot() { return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''); }

async function githubRequest(repository, token, pathname, method = 'GET') {
  const response = await fetch(apiRoot() + pathname, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'oasis-branch-cleanup'
    }
  });
  if (response.status === 204) return null;
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch {}
  if (!response.ok) {
    const error = new Error('GitHub API ' + method + ' failed (' + response.status + '): ' + String(data?.message || body || 'unknown error').slice(0, 300));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function listPages(repository, token, resource) {
  const items = [];
  const [pathname, existingQuery] = resource.split('?', 2);
  for (let page = 1; page <= 100; page++) {
    const query = (existingQuery ? existingQuery + '&' : '') + 'per_page=' + PAGE_SIZE + '&page=' + page;
    const result = await githubRequest(repository, token, '/repos/' + repository + '/' + pathname + '?' + query);
    if (!Array.isArray(result)) throw new Error('GitHub API did not return a list for ' + resource + '.');
    items.push(...result);
    if (result.length < PAGE_SIZE) return items;
  }
  throw new Error('Refusing to process more than 10,000 results for ' + resource + '.');
}

function refPath(pathname) { return pathname.split('/').map((part) => encodeURIComponent(part)).join('/'); }

async function defaultBranchTree(repository, token, defaultBranch) {
  const ref = await githubRequest(repository, token, '/repos/' + repository + '/git/ref/heads/' + refPath(defaultBranch));
  if (!ref?.object?.sha) throw new Error('Unable to resolve the default branch tip.');
  const commit = await githubRequest(repository, token, '/repos/' + repository + '/git/commits/' + ref.object.sha);
  if (!commit?.tree?.sha) throw new Error('Unable to resolve the default branch tree.');
  const tree = await githubRequest(repository, token, '/repos/' + repository + '/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated) throw new Error('Default branch tree is incomplete; no refs will be deleted.');
  return new Map(tree.tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]));
}

async function runCleanup() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const apply = process.argv.includes('--apply');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/name.');
  if (!token) throw new Error('GITHUB_TOKEN is required for authenticated branch inventory.');
  const repositoryInfo = await githubRequest(repository, token, '/repos/' + repository);
  const defaultBranch = String(repositoryInfo?.default_branch || '');
  if (!defaultBranch) throw new Error('Unable to determine the default branch.');

  const [branches, openPRs, closedPRs, mainTree] = await Promise.all([
    listPages(repository, token, 'branches'),
    listPages(repository, token, 'pulls?state=open'),
    listPages(repository, token, 'pulls?state=closed'),
    defaultBranchTree(repository, token, defaultBranch)
  ]);
  const openPrBranches = new Set(openPRs
    .filter((pr) => pr?.head?.repo?.full_name === repository && typeof pr.head.ref === 'string')
    .map((pr) => pr.head.ref));
  const mergedPrHeads = new Map();
  for (const pr of closedPRs) {
    if (!pr?.merged_at || pr?.base?.ref !== defaultBranch ||
        pr?.head?.repo?.full_name !== repository || typeof pr.head.ref !== 'string' ||
        typeof pr.head.sha !== 'string') continue;
    if (!mergedPrHeads.has(pr.head.ref)) mergedPrHeads.set(pr.head.ref, new Set());
    mergedPrHeads.get(pr.head.ref).add(pr.head.sha);
  }

  let retired = 0, kept = 0, eligible = 0;
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    let decision = classifyRetirement(branch, null, defaultBranch, openPrBranches, mainTree, mergedPrHeads);
    // Exact merged heads and audited replacements need no compare API call; this also means
    // a transient compare endpoint failure cannot strand a branch already proven merged.
    if (decision.reason === 'comparison is incomplete') {
      let comparison;
      try {
        const suffix = encodeURIComponent(defaultBranch) + '...' + encodeURIComponent(branch.name);
        comparison = await githubRequest(repository, token, '/repos/' + repository + '/compare/' + suffix);
      } catch (error) {
        kept++;
        console.log('[keep] ' + branch.name + ': unable to compare (' + error.message + ')');
        continue;
      }
      decision = classifyRetirement(branch, comparison, defaultBranch, openPrBranches, mainTree, mergedPrHeads);
    }
    if (!decision.retire) {
      kept++;
      console.log('[keep] ' + branch.name + ': ' + decision.reason);
      continue;
    }
    eligible++;
    console.log('[' + (apply ? 'retire' : 'dry-run') + '] ' + branch.name + ': ' + decision.reason);
    if (!apply) continue;
    try {
      await githubRequest(repository, token, '/repos/' + repository + '/git/refs/heads/' + refPath(branch.name), 'DELETE');
      retired++;
    } catch (error) {
      if (error.status === 404) {
        console.log('[skip] ' + branch.name + ': ref already disappeared');
        continue;
      }
      throw error;
    }
  }
  console.log('Branch cleanup summary: ' + (apply ? retired + ' retired' : eligible + ' eligible in dry run') +
    ', ' + kept + ' preserved. Default branch: ' + defaultBranch +
    '. Open-PR branches and branches with non-equivalent changes are never removed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCleanup().catch((error) => {
    console.error('Branch cleanup failed closed: ' + error.message);
    process.exitCode = 1;
  });
}
