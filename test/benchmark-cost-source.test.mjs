import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkCostSource } from '../src/eval.mjs';

test('a :free cloud model behind the benchmark gateway is not labelled as a local model', () => {
  const label = benchmarkCostSource({ localModel: true, costUSD: 0, model: 'nvidia/nemotron-3-ultra-550b-a55b:free' });
  assert.match(label, /free-tier cloud model/);
  assert.doesNotMatch(label, /local model/);
});

test('other cost labels are unchanged', () => {
  assert.match(benchmarkCostSource({ localModel: true, costUSD: 0, model: 'qwen2.5-coder:7b' }), /^local model/);
  assert.match(benchmarkCostSource({ gatewayCloud: true, costUSD: 1 }), /list-price estimate/);
  assert.match(benchmarkCostSource({ costUSD: null }), /^unknown/);
  assert.equal(benchmarkCostSource({ costUSD: 0.5 }), 'uniform benchmark token-rate estimate');
  assert.equal(benchmarkCostSource({ routed: true, routedCostKnown: true }), 'per-model pricing estimate');
});
