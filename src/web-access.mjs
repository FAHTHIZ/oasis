// The sites a web tool call reaches (the fetched host, or the configured search
// providers' hosts), so each new site is approved once per session.
import { searchBackends, searchBackend, keylessFallbackEnabled } from './web-search.mjs';
import { execFileSync } from 'node:child_process';

export const SEARCH_PROVIDER_HOSTS = {
  duckduckgo: 'html.duckduckgo.com',
  bing: 'www.bing.com',
  tavily: 'api.tavily.com',
  brave: 'api.search.brave.com',
  exa: 'api.exa.ai',
  firecrawl: 'api.firecrawl.dev'
};

export function webSearchHosts(args, env) {
  const configured = searchBackends(env);
  const strategy = String(args.strategy || env.OASIS_SEARCH_STRATEGY || 'auto').toLowerCase();
  let providers;
  if (strategy === 'single') {
    const preferred = searchBackend(env);
    providers = [configured.length ? (configured.includes(preferred) ? preferred : configured[0]) : 'duckduckgo'];
  } else {
    providers = configured.length ? [...configured, 'duckduckgo'] : ['duckduckgo'];
  }
  // Keyless search falls back to Bing when DuckDuckGo refuses the query, so
  // the approval names both sites up front.
  if (!configured.length && keylessFallbackEnabled(env)) providers.push('bing');
  return [...new Set(providers.map((provider) => {
    if (provider === 'searxng') {
      try { return new URL(String(env.OASIS_SEARXNG_URL)).hostname.toLowerCase(); }
      catch { return 'configured SearXNG endpoint'; }
    }
    return SEARCH_PROVIDER_HOSTS[provider] || provider;
  }))];
}

export function webAccessSites(name, args, env) {
  if (name === 'fetch_url') {
    try {
      const host = new URL(String(args.url || '')).hostname.toLowerCase();
      return host ? [host] : [];
    } catch { return []; }
  }
  return name === 'web_search' ? webSearchHosts(args, env) : [];
}

// Claude Code 2.1.317: ask before a web or shell call sends the user's own
// email address over the network. The addresses come from git config and
// OASIS_USER_EMAIL; GitHub noreply addresses are public by design and skipped.
const NETWORK_SHELL = /(?:^|[\s;&|(`'"])(?:curl|wget|http|https|xh|nc|ncat|socat|ssh|scp|sftp|rsync|ftp|telnet|sendmail|mail|mutt|aws|gcloud|az|gh)(?=$|[\s;&|)'"])|\bhttps?:\/\/|\bInvoke-(?:WebRequest|RestMethod)\b|\bfetch\(/i;

export function userEmailAddresses({ root = process.cwd(), env = process.env, gitEmail } = {}) {
  const found = new Set();
  const add = (value) => {
    for (const item of String(value || '').split(/[,\s]+/)) {
      const email = item.trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) && !/noreply|no-reply/.test(email)) found.add(email);
    }
  };
  add(env.OASIS_USER_EMAIL);
  add(env.GIT_AUTHOR_EMAIL);
  add(env.GIT_COMMITTER_EMAIL);
  if (gitEmail === undefined) {
    try { gitEmail = execFileSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { gitEmail = ''; }
  }
  add(gitEmail);
  return [...found];
}

// A network shell command that reads the git identity while it runs
// (`curl -d "$(git config user.email)" ...`) sends it without the address ever
// appearing in the call.
const IDENTITY_READ = /\bgit\s+(?:-[Cc]\s+\S+\s+)*config\b[^;&|\n]*\buser\.email\b|\bgit\s+(?:log|show|rev-list)\b[^;&|\n]*%[ac][eE]|\$\{?GIT_(?:AUTHOR|COMMITTER)_EMAIL\b|\bgit\s+var\s+GIT_(?:AUTHOR|COMMITTER)_IDENT\b|\bgh\s+api\s+(?:\/)?user(?:\/emails)?\b|\$\{?OASIS_USER_EMAIL\b/i;
const SHELL_TOOLS = new Set(['run_command', 'run_shell', 'monitor', 'powershell']);

function shellText(args) {
  return [args && args.command, ...(Array.isArray(args && args.args) ? args.args : [])].filter((part) => typeof part === 'string').join(' ');
}

export function outboundEmailHit(name, args, emails = []) {
  if (!emails.length) return null;
  const tool = String(name || '');
  const shell = SHELL_TOOLS.has(tool);
  // MCP tools are named mcp_<server>_<tool> (prompts mcp__<server>__<prompt>).
  const network = tool === 'fetch_url' || tool === 'web_search' || tool === 'browser' || tool.startsWith('mcp_')
    || (shell && NETWORK_SHELL.test(shellText(args)));
  if (!network) return null;
  if (shell && IDENTITY_READ.test(shellText(args))) {
    // `gh api user` on its own only reads; something else must send it on.
    const rest = shellText(args).replace(new RegExp(IDENTITY_READ.source, 'gi'), ' ');
    if (NETWORK_SHELL.test(rest)) return emails[0];
  }
  let text = '';
  try { text = JSON.stringify(args).toLowerCase(); } catch { return null; }
  const decoded = (() => { try { return decodeURIComponent(text); } catch { return text; } })();
  return emails.find((email) => text.includes(email) || decoded.includes(email)) || null;
}
