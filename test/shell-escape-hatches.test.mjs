import test from 'node:test';
import assert from 'node:assert/strict';
import { shellAnalyzerReady, analyzeShellLine } from '../src/shell-risk.mjs';
import { analyzeCommand } from '../src/permissions.mjs';

// Each of these reached the same damage as an already-guarded command through
// a side door: find instead of rm, a container that mounts the host, or text
// piped into a shell. They ran without asking in bypass mode or under a broad
// allow rule.
test('side doors to workspace-wide or host-wide damage need a person', async () => {
  await shellAnalyzerReady();
  for (const line of [
    'find . -delete', 'find -delete', 'find . -mindepth 1 -delete', 'find . -exec rm -rf {} +', 'find $PWD -delete',
    'docker run -v /:/h alpine rm -rf /h', 'docker run --rm -v ~/:/h alpine sh', 'docker run -v $HOME:/h alpine sh',
    'docker run --mount type=bind,source=/,target=/h alpine', 'docker run -v /var/run/docker.sock:/var/run/docker.sock img',
    'podman run --privileged alpine sh', 'docker container run --pid=host alpine', 'docker run --volume=/etc:/e alpine',
    'echo rm -rf * | sh', 'echo -n rm -rf . | bash', 'printf "rm -rf *\\n" | sh'
  ]) {
    const r = analyzeShellLine(line);
    assert.ok(r.highRisk || r.blocked, line + ' -> ' + JSON.stringify(r));
  }
});

test('targeted finds, project mounts and harmless pipes stay ordinary', async () => {
  await shellAnalyzerReady();
  for (const line of [
    'find . -name "*.log" -delete', 'find . -type d -name node_modules -exec rm -rf {} +', 'find src -delete', 'cd build && find . -delete',
    'find . -mtime +30 -delete', 'docker run -v ./data:/data alpine ls', 'docker run -v "$(pwd)":/app node npm test', 'docker run -v /tmp/x:/x alpine',
    'docker run --network=host img', 'echo hello | sh', 'echo rm -rf dist | sh'
  ]) {
    const r = analyzeShellLine(line);
    assert.ok(!r.highRisk && !r.blocked, line + ' -> ' + JSON.stringify(r));
  }
});

test('run_command applies the same container rule', () => {
  assert.ok(analyzeCommand('docker', ['run', '-v', '/:/h', 'alpine']).highRisk);
  assert.ok(analyzeCommand('podman', ['run', '--privileged', 'alpine']).highRisk);
  assert.equal(analyzeCommand('docker', ['run', '-v', './d:/d', 'alpine']).highRisk, undefined);
});
