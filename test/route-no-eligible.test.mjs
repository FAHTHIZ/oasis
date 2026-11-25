import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnconfiguredRouteError } from '../src/provider-retry.mjs';
import { apiErrorAdvice } from '../src/api-error.mjs';

const ROUTE_503 = JSON.stringify({ error: { message: 'no authorized, eligible, healthy candidate satisfies this request; custom/openai-fast was set aside because it is not known to support tools', type: 'no_route_error', code: 'no_eligible_route' } });

test('an OASIS Route no_eligible_route 503 is not retried and says where to fix it', () => {
  assert.equal(isUnconfiguredRouteError(503, ROUTE_503), true, 'retrying cannot help until Route changes');
  const advice = apiErrorAdvice(503, ROUTE_503);
  assert.match(advice, /OASIS Route has no model it may use/);
  assert.doesNotMatch(advice, /server-side problem/);
  // A plain overload 503 is still retried and worded as before.
  assert.equal(isUnconfiguredRouteError(503, 'The model is overloaded. Please try again later.'), false);
  assert.match(apiErrorAdvice(503, 'overloaded'), /server-side problem/);
});
