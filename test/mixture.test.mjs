import test from 'node:test';
import assert from 'node:assert/strict';
import { AGGREGATOR_SYSTEM, MIXTURE_TOOL_DEFINITION, parseMixtureModels, runMixture, usableMixture } from '../src/mixture.mjs';
import { setMixture } from '../src/agent.mjs';

const base = { protocol: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'k', model: 'main-model' };

test('mixture entries reuse the provider:model form and skip providers without a key', () => {
  const chain = parseMixtureModels('gpt-a, openrouter:deepseek/deepseek-r1, groq:kimi, gpt-a');
  assert.deepEqual(chain.map((e) => e.id), ['gpt-a', 'openrouter:deepseek/deepseek-r1', 'groq:kimi']);
  const { usable, skipped } = usableMixture(chain, base, { OPENROUTER_API_KEY: 'or-key' });
  assert.deepEqual(usable.map((u) => u.config.model), ['gpt-a', 'deepseek/deepseek-r1']);
  assert.equal(usable[1].config.apiKey, 'or-key');
  assert.deepEqual(skipped, ['groq:kimi']);
  assert.equal(parseMixtureModels(Array.from({ length: 10 }, (_, i) => 'm' + i)).length, 6);
});

test('proposers answer in parallel, the aggregator merges, failures are reported', async () => {
  const seen = [];
  let inFlight = 0; let peak = 0;
  const request = async (config, messages) => {
    seen.push({ model: config.model, system: messages[0].content, user: messages[1].content });
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    if (config.model === 'broken') throw new Error('503 overloaded');
    if (messages[0].content === AGGREGATOR_SYSTEM) return { content: 'merged answer\nDisagreements: none', usage: { inputTokens: 50, outputTokens: 5 } };
    return { content: 'answer from ' + config.model, usage: { inputTokens: 10, outputTokens: 3 } };
  };
  const charged = [];
  const result = await runMixture({ chain: parseMixtureModels('a,b,broken'), baseConfig: base, aggregatorConfig: { ...base, model: 'judge' } }, { question: 'Is X safe?', show_proposals: true }, { request, charge: (usage, model) => charged.push(model), transcript: () => 'user: fix the race' });
  assert.equal(peak, 3, 'all proposers run at once');
  assert.equal(result.answer, 'merged answer\nDisagreements: none');
  assert.deepEqual(result.models, ['a', 'b']);
  assert.equal(result.aggregator, 'judge');
  assert.match(result.failed[0], /^broken: 503/);
  assert.equal(result.proposals.length, 2);
  const merge = seen.find((s) => s.model === 'judge');
  assert.match(merge.user, /Answer 1 \(a\)[\s\S]*answer from a[\s\S]*Answer 2 \(b\)/);
  assert.match(seen[0].user, /BEGIN TRANSCRIPT[\s\S]*fix the race[\s\S]*Question: Is X safe\?/);
  assert.deepEqual(charged.sort(), ['a', 'b', 'judge']);
});

test('one surviving answer is returned without a merge; none or too few models fail clearly', async () => {
  const request = async (config) => { if (config.model !== 'a') throw new Error('down'); return { content: 'only a' }; };
  const one = await runMixture({ chain: parseMixtureModels('a,b'), baseConfig: base, aggregatorConfig: base }, { question: 'q', include_transcript: false }, { request, transcript: () => { throw new Error('not read'); } });
  assert.equal(one.answer, 'only a');
  assert.equal(one.aggregator, null);
  await assert.rejects(() => runMixture({ chain: parseMixtureModels('x,y'), baseConfig: base, aggregatorConfig: base }, { question: 'q' }, { request }), /Every model in the mixture failed/);
  await assert.rejects(() => runMixture({ chain: parseMixtureModels('a,groq:k'), baseConfig: base, aggregatorConfig: base, env: {} }, { question: 'q' }, { request }), /missing API keys for groq:k/);
  await assert.rejects(() => runMixture({ chain: parseMixtureModels('a,b'), baseConfig: base, aggregatorConfig: base }, {}, { request }), /needs a question/);
});

test('setMixture adds and removes the tool and checks the model policy', () => {
  const session = { config: base, toolDefinitions: [], availableModels: null, modelPolicy: {} };
  assert.deepEqual(setMixture(session, 'a,openrouter:b', 'judge'), ['a', 'openrouter:b']);
  assert.equal(session.mixtureAggregator, 'judge');
  assert.ok(session.toolDefinitions.includes(MIXTURE_TOOL_DEFINITION));
  setMixture(session, 'a,c');
  assert.equal(session.toolDefinitions.filter((t) => t.function.name === 'mixture_of_agents').length, 1);
  assert.throws(() => setMixture(session, 'only-one'), /at least two/);
  assert.equal(setMixture(session, 'off'), null);
  assert.equal(session.toolDefinitions.length, 0);
  const limited = { config: base, toolDefinitions: [], availableModels: ['a', 'b'], modelPolicy: {} };
  assert.throws(() => setMixture(limited, 'a,z'));
});

test('the aggregator sees each proposer\'s stated and calibrated confidence', async () => {
  const { statedConfidence } = await import('../src/mixture.mjs');
  assert.equal(statedConfidence('answer\nConfidence: 85%'), 0.85);
  assert.equal(statedConfidence('answer\n**Confidence:** 0.6'), 0.6);
  assert.equal(statedConfidence('no line here'), null);
  const seen = [];
  const request = async (config, messages) => {
    seen.push({ model: config.model, user: messages[1].content });
    if (messages[0].content === AGGREGATOR_SYSTEM) return { content: 'merged' };
    return { content: 'answer from ' + config.model + '\nConfidence: 95%' };
  };
  // "a" has a record of being overconfident at 0.95; "b" has no record.
  const history = { a: Array.from({ length: 20 }, (_, index) => ({ p: 0.95, o: index < 8 ? 1 : 0 })) };
  const result = await runMixture({ chain: parseMixtureModels('a,b'), baseConfig: base, aggregatorConfig: { ...base, model: 'judge' } }, { question: 'q', include_transcript: false }, { request, calibration: (model) => history[model] || [] });
  const merge = seen.find((item) => item.model === 'judge').user;
  assert.match(merge, /Answer 1 \(a, stated confidence 0\.95, calibrated 0\.\d+ from 20 settled claims\)/);
  assert.match(merge, /Answer 2 \(b, stated confidence 0\.95\)/);
  assert.equal(result.confidence.a.stated, 0.95);
  assert.ok(result.confidence.a.calibrated < 0.6);
  assert.deepEqual(result.confidence.b, { stated: 0.95 });
});
