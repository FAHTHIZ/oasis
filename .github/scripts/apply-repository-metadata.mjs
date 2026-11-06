const ownerRepo = process.env.GITHUB_REPOSITORY;
const token = process.env.OASIS_REPO_ADMIN_TOKEN;
const deploymentUrl = process.env.OASIS_PUBLIC_URL;
const homepage = deploymentUrl ? new URL('app/', deploymentUrl).toString() : '';

if (!ownerRepo || ownerRepo.toLowerCase() !== 'fahthiz/oasis') throw new Error('Refusing to edit repository metadata outside FAHTHIZ/oasis.');
if (!token) throw new Error('OASIS_REPO_ADMIN_TOKEN is not set. See CONTRIBUTING.md and the repository workflow settings.');
if (!deploymentUrl || !deploymentUrl.startsWith('https://') || !deploymentUrl.endsWith('/') || !homepage.endsWith('/app/')) throw new Error('A verified HTTPS GitHub Pages app URL was not provided by the deployment step.');

const description = 'An open-source, model-agnostic coding-agent runtime with CLI, browser, desktop and VS Code interfaces.';
const topics = ["agent-runtime","agent-skills","agentic-workflows","ai-agents","ai-coding-agent","automation","cli","coding-agent","developer-tools","electron","llm","local-first","mcp","multi-agent","multi-provider","nodejs","ollama","open-source","terminal-agent","vscode"];

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
console.log('Homepage set to the installable browser app: ' + result.homepage);
console.log('Verified ' + result.topics.length + ' repository topics.');
