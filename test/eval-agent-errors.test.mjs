import test from 'node:test';
import assert from 'node:assert/strict';
import { agentErrorSummary } from '../src/eval.mjs';

// Seen live: the benchmark printed the raw tail of OpenCode's JSON events and
// "did not return a valid JSON result" for Gemini CLI, hiding a 400 and a
// used-up daily quota.
test('agent failures are summarized from their JSON error events', () => {
  const opencode = '{"type":"step_start","part":{}}\n{"type":"error","error":{"name":"APIError","data":{"message":"Bad Request: [{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Requests ending with a model turn are not supported.\\"\\n  }\\n}\\n]","statusCode":400}}}\n{"type":"step_finish","part":{"id":"prt_x"}}\n';
  assert.equal(agentErrorSummary(opencode), 'HTTP 400: Requests ending with a model turn are not supported.');
  const gemini = 'Error when talking to Gemini API\n    at async main (file:///x.js:1:1) {\n  status: 429\n}\n{\n  "session_id": "abc",\n  "error": {\n    "type": "Error",\n    "message": "You have exhausted your daily quota on this model.",\n    "code": 429\n  }\n}\n';
  assert.equal(agentErrorSummary(gemini), 'HTTP 429: You have exhausted your daily quota on this model.');
  assert.equal(agentErrorSummary('working...\nError: connect ECONNREFUSED 127.0.0.1:1\n'), 'Error: connect ECONNREFUSED 127.0.0.1:1');
  assert.equal(agentErrorSummary('all good\n'), '');
});
