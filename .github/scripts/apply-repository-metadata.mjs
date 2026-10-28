const ownerRepo = process.env.GITHUB_REPOSITORY;
const token = process.env.OASIS_REPO_ADMIN_TOKEN;
const homepage = process.env.OASIS_PUBLIC_URL;

if (!ownerRepo || ownerRepo.toLowerCase() !== 'fahthiz/oasis') throw new Error('Refusing to edit repository metadata outside FAHTHIZ/oasis.');
if (!token) throw new Error('OASIS_REPO_ADMIN_TOKEN is not set. See docs/PUBLIC_LAUNCH.md.');
if (!homepage || !homepage.startsWith('https://') || !homepage.endsWith('/')) throw new Error('A verified HTTPS GitHub Pages URL was not provided by the deployment step.');

const description = 'Open-source AI coding agent and local-first developer workspace with a CLI, browser UI, multi-provider LLMs, MCP integrations, skills, hooks, memory, and subagents.';
const topics = ['ai-coding-agent','coding-agent','ai-agents','developer-tools','developer-workspace','cli','terminal-agent','llm','mcp','model-context-protocol','agent-skills','agentic-workflows','local-first','open-source','javascript','nodejs','automation','subagents','ollama','multi-provider'];

const response = await fetch('https://api.github.com/repos/FAHTHIZ/oasis', {
  method: 'PATCH',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'OASIS-public-launch-workflow'
  },
  body: JSON.stringify({ description, homepage, topics })
});
const responseText = await response.text();
let result;
try { result = JSON.parse(responseText); }
catch { throw new Error('GitHub returned a non-JSON response (HTTP ' + response.status + ') while updating repository metadata.'); }
if (!response.ok) throw new Error('GitHub rejected the repository metadata update (HTTP ' + response.status + '): ' + (result.message || 'unknown error') + '. Check Administration: write and Pages: write permissions on OASIS_REPO_ADMIN_TOKEN.');
if (result.description !== description || result.homepage !== homepage || topics.some((topic) => !(result.topics || []).includes(topic))) throw new Error('The API response did not match the requested repository metadata.');
console.log('Repository About description updated.');
console.log('Homepage set to the deployed site: ' + result.homepage);
console.log('Verified ' + result.topics.length + ' repository topics.');
