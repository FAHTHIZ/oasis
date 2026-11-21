import test from 'node:test';
import assert from 'node:assert/strict';
import { controlHomeAssistant, hassConfig, readHomeAssistant, runHomeAssistantTool, HOME_ASSISTANT_TOOL_NAMES } from '../src/home-assistant.mjs';
import { READ_ONLY_TOOLS } from '../src/agent.mjs';

const config = { url: 'http://ha.local:8123', token: 'tok' };
const STATES = [
  { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
  { entity_id: 'light.porch', state: 'on', attributes: { friendly_name: 'Porch light' } },
  { entity_id: 'sensor.outdoor_temp', state: '18.5', attributes: { friendly_name: 'Outdoor', unit_of_measurement: '°C' } },
  { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } }
];

function fakeHa() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === '/api/states') return Response.json(STATES);
    if (path.startsWith('/api/states/')) { const item = STATES.find((s) => s.entity_id === path.slice(12)); return item ? Response.json(item) : new Response('', { status: 404 }); }
    if (path === '/api/services') return Response.json([{ domain: 'light', services: { turn_on: { description: 'Turn on lights', fields: { brightness_pct: {}, color_name: {} } }, turn_off: { description: 'Turn off' } } }]);
    if (path.startsWith('/api/services/')) return Response.json([{ ...STATES[0], state: 'on' }]);
    return new Response('', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('configuration comes from OASIS_HASS_* or HASS_*', () => {
  assert.equal(hassConfig({}), null);
  assert.equal(hassConfig({ OASIS_HASS_URL: 'http://ha:8123' }), null);
  assert.deepEqual(hassConfig({ HASS_URL: 'http://ha:8123/', HASS_TOKEN: 't' }), { url: 'http://ha:8123', token: 't' });
  assert.equal(hassConfig({ OASIS_HASS_URL: 'ftp://x', OASIS_HASS_TOKEN: 't' }), null);
  assert.ok(READ_ONLY_TOOLS.has('home_assistant'));
  assert.ok(!READ_ONLY_TOOLS.has('home_assistant_control'));
  assert.deepEqual(HOME_ASSISTANT_TOOL_NAMES, ['home_assistant', 'home_assistant_control']);
});

test('reads entities, states and services', async () => {
  const ha = fakeHa();
  const lights = await readHomeAssistant({ action: 'list_entities', domain: 'light' }, { config, fetchImpl: ha.fetchImpl });
  assert.match(lights, /^2 entities:\nlight\.kitchen {2}off {2}"Kitchen"\nlight\.porch/);
  assert.match(await readHomeAssistant({ action: 'list_entities', search: 'outdoor' }, { config, fetchImpl: ha.fetchImpl }), /sensor\.outdoor_temp {2}18\.5 °C/);
  assert.match(await readHomeAssistant({ action: 'list_entities', domain: 'fan' }, { config, fetchImpl: ha.fetchImpl }), /No entities in fan/);
  assert.match(await readHomeAssistant({ action: 'get_state', entity_id: 'lock.front_door' }, { config, fetchImpl: ha.fetchImpl }), /"state": "locked"/);
  assert.match(await readHomeAssistant({ action: 'list_services', domain: 'light' }, { config, fetchImpl: ha.fetchImpl }), /light\.turn_on: Turn on lights\n {4}fields: brightness_pct, color_name/);
  assert.equal(ha.calls[0].auth, 'Bearer tok');
  await assert.rejects(readHomeAssistant({ action: 'get_state', entity_id: '../config' }, { config, fetchImpl: ha.fetchImpl }), /entity_id/);
  await assert.rejects(readHomeAssistant({ action: 'list_entities' }, { config: null }), /not configured/);
});

test('service calls ask first and report the new state', async () => {
  const ha = fakeHa();
  const prompts = [];
  const out = await controlHomeAssistant({ domain: 'light', service: 'turn_on', entity_id: 'light.kitchen', data: { brightness_pct: 40, entity_id: 'light.porch' } }, { config, fetchImpl: ha.fetchImpl, approval: async (message) => { prompts.push(message); return true; } });
  assert.match(prompts[0], /light\.turn_on on light\.kitchen\n {2}data: \{"brightness_pct":40\}/);
  assert.deepEqual(ha.calls[0], { path: '/api/services/light/turn_on', method: 'POST', auth: 'Bearer tok', body: { brightness_pct: 40, entity_id: 'light.kitchen' } });
  assert.match(out, /Now:\nlight\.kitchen {2}on/);
  await assert.rejects(controlHomeAssistant({ domain: 'light', service: 'turn_off', entity_id: 'light.kitchen' }, { config, fetchImpl: ha.fetchImpl, approval: async () => false }), /did not approve/);
  assert.equal(ha.calls.length, 1);
});

test('code-running services are refused and locks always ask', async () => {
  const ha = fakeHa();
  for (const [domain, service] of [['shell_command', 'run'], ['python_script', 'x'], ['hassio', 'host_reboot'], ['homeassistant', 'restart']]) {
    await assert.rejects(controlHomeAssistant({ domain, service }, { config, fetchImpl: ha.fetchImpl, autoApprove: true }), /does not call it/);
  }
  let asked = 0;
  await controlHomeAssistant({ domain: 'light', service: 'toggle', entity_id: 'light.porch' }, { config, fetchImpl: ha.fetchImpl, autoApprove: true, approval: async () => { asked++; return true; } });
  assert.equal(asked, 0, 'auto mode does not ask for a light');
  await assert.rejects(controlHomeAssistant({ domain: 'lock', service: 'unlock', entity_id: 'lock.front_door' }, { config, fetchImpl: ha.fetchImpl, autoApprove: true, ruleAllowed: true }), /did not approve/);
  await controlHomeAssistant({ domain: 'homeassistant', service: 'turn_off', entity_id: 'lock.front_door' }, { config, fetchImpl: ha.fetchImpl, autoApprove: true, approval: async (message) => { asked++; assert.match(message, /lock, alarm/); return true; } });
  assert.equal(asked, 1);
});

test('the tool runner uses the session configuration', async () => {
  const ha = fakeHa();
  const out = await runHomeAssistantTool('home_assistant', { action: 'list_entities', domain: 'lock' }, { session: { homeAssistant: config }, fetchImpl: ha.fetchImpl });
  assert.match(out, /lock\.front_door {2}locked/);
});
