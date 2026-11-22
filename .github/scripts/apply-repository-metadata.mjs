const ownerRepo = process.env.GITHUB_REPOSITORY;
const token = process.env.OASIS_REPO_ADMIN_TOKEN;

if (!ownerRepo || ownerRepo.toLowerCase() !== 'fahthiz/oasis') {
  throw new Error('Refusing to edit repository metadata outside FAHTHIZ/oasis.');
}
if (!token) {
  throw new Error('OASIS_REPO_ADMIN_TOKEN is not set. It must have permission to edit repository metadata.');
}

const description = 'Open-source, model-agnostic agent platform and runtime for software, research, analysis, writing, automation and computer use.';
const topics = ["a2a","agent-platform","agent-runtime","agent-skills","agentic-workflows","ai-agents","automation","browser-automation","cli","computer-use","general-purpose-agent","llm","mcp","model-agnostic","model-context-protocol","multi-agent","ollama","open-source","research-agent","self-hosted"];

const response = await fetch('https://api.github.com/repos/FAHTHIZ/oasis', {
  method: 'PATCH',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'OASIS-repository-metadata-workflow'
  },
  body: JSON.stringify({ description, homepage: '', topics })
});

const responseText = await response.text();
let result;
try {
  result = JSON.parse(responseText);
} catch {
  throw new Error('GitHub returned a non-JSON response (HTTP ' + response.status + ') while updating repository metadata.');
}
if (!response.ok) {
  throw new Error('GitHub rejected the repository metadata update (HTTP ' + response.status + '): ' + (result.message || 'unknown error') + '. Check that OASIS_REPO_ADMIN_TOKEN can edit repository metadata.');
}
if (result.description !== description || (result.homepage && result.homepage !== '') || topics.some((topic) => !(result.topics || []).includes(topic))) {
  throw new Error('The GitHub response did not match the requested repository description, empty homepage and topics.');
}

console.log('Repository description updated.');
console.log('External project homepage cleared; GitHub is the canonical project home.');
console.log('Verified ' + result.topics.length + ' repository topics.');
