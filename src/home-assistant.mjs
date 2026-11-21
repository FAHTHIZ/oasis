// Home Assistant tools: read entity states and call services on a Home
// Assistant instance through its REST API (https://developers.home-assistant.io/docs/api/rest/).
//
//   home_assistant          read-only: list entities, read one state, list services
//   home_assistant_control  calls a service (turn on a light, run a script);
//                           asks for approval every time, and locks, alarms,
//                           garage doors and similar always ask, even in auto mode
//
// Configure with OASIS_HASS_URL (or HASS_URL) and a long-lived access token in
// OASIS_HASS_TOKEN (or HASS_TOKEN): Home Assistant profile → Security →
// Long-lived access tokens. Without both, the tools are not offered.

const TIMEOUT_MS = 20_000;
const MAX_LIST = 300;
const MAX_OUTPUT = 24 * 1024;

// Services that run arbitrary code or manage the host: never callable.
export const BLOCKED_DOMAINS = new Set(['shell_command', 'command_line', 'python_script', 'pyscript', 'hassio', 'rest_command', 'recorder', 'system_log', 'logger']);
const BLOCKED_SERVICES = new Set(['homeassistant.stop', 'homeassistant.restart', 'homeassistant.reload_all']);
// Physical security: approval is required even when commands are auto-approved.
export const SENSITIVE_DOMAINS = new Set(['lock', 'alarm_control_panel', 'cover', 'valve', 'siren', 'camera', 'climate', 'water_heater']);

export function hassConfig(env = process.env) {
  const url = String(env.OASIS_HASS_URL || env.HASS_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.OASIS_HASS_TOKEN || env.HASS_TOKEN || '').trim();
  if (!url || !token) return null;
  if (!/^https?:\/\/[^\s/]+/.test(url)) return null;
  return { url, token };
}

export const HOME_ASSISTANT_TOOL_DEFINITIONS = [
  { type: 'function', function: {
    name: 'home_assistant',
    description: 'Read the user\'s Home Assistant smart home (read-only). action=list_entities lists entity IDs with their state and name (filter by domain such as light, switch, sensor, climate, or by a search word); action=get_state returns one entity\'s full state and attributes; action=list_services lists the services of a domain and their fields. Look entities up before controlling them; never guess entity IDs.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list_entities', 'get_state', 'list_services'] },
      domain: { type: 'string', description: 'Entity or service domain, e.g. light, switch, climate, media_player, script' },
      search: { type: 'string', description: 'list_entities: only entities whose ID or name contains this' },
      entity_id: { type: 'string', description: 'get_state: e.g. light.kitchen' }
    }, required: ['action'], additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'home_assistant_control',
    description: 'Call a Home Assistant service, e.g. domain=light service=turn_on entity_id=light.kitchen data={"brightness_pct":40}. Needs the user\'s approval. Check the entity with home_assistant first. Code-running and host-management services are refused.',
    parameters: { type: 'object', properties: {
      domain: { type: 'string', description: 'Service domain, e.g. light, switch, climate, media_player, script, scene' },
      service: { type: 'string', description: 'Service name, e.g. turn_on, turn_off, toggle, set_temperature' },
      entity_id: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 50 }], description: 'Target entity ID or IDs' },
      data: { type: 'object', description: 'Extra service data, e.g. {"temperature": 21}' }
    }, required: ['domain', 'service'], additionalProperties: false }
  } }
];

export const HOME_ASSISTANT_TOOL_NAMES = HOME_ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.function.name);

const NAME = /^[a-z0-9_]{1,64}$/;
const ENTITY = /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,128}$/;

async function request(config, method, pathname, body, { fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(config.url + pathname, {
      method,
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch (error) {
    throw new Error('Could not reach Home Assistant at ' + config.url + ': ' + (error && error.message || error));
  }
  if (response.status === 401) throw new Error('Home Assistant rejected the token (HTTP 401). Create a new long-lived access token and set OASIS_HASS_TOKEN.');
  if (response.status === 404) throw new Error('Home Assistant has no ' + pathname.replace(/^\/api\//, '') + ' (HTTP 404).');
  if (!response.ok) throw new Error('Home Assistant answered HTTP ' + response.status + ': ' + String(await response.text().catch(() => '')).slice(0, 300));
  return response.json();
}

const clip = (text) => text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n… (truncated; narrow it with domain or search)' : text;

function entityLine(item) {
  const name = item.attributes && item.attributes.friendly_name;
  const unit = item.attributes && item.attributes.unit_of_measurement;
  return item.entity_id + '  ' + item.state + (unit ? ' ' + unit : '') + (name ? '  "' + name + '"' : '');
}

export async function readHomeAssistant(args = {}, { config, fetchImpl, signal } = {}) {
  if (!config) throw new Error('Home Assistant is not configured. Set OASIS_HASS_URL and OASIS_HASS_TOKEN.');
  const action = String(args.action || '');
  const domain = args.domain ? String(args.domain).trim().toLowerCase() : '';
  if (domain && !NAME.test(domain)) throw new Error('Invalid domain ' + domain + '.');
  if (action === 'get_state') {
    const id = String(args.entity_id || '').trim().toLowerCase();
    if (!ENTITY.test(id)) throw new Error('get_state needs an entity_id such as light.kitchen.');
    const item = await request(config, 'GET', '/api/states/' + id, undefined, { fetchImpl, signal });
    return clip(JSON.stringify({ entity_id: item.entity_id, state: item.state, attributes: item.attributes, last_changed: item.last_changed }, null, 2));
  }
  if (action === 'list_entities') {
    const search = String(args.search || '').trim().toLowerCase();
    const states = await request(config, 'GET', '/api/states', undefined, { fetchImpl, signal });
    const hits = (Array.isArray(states) ? states : [])
      .filter((item) => item && typeof item.entity_id === 'string')
      .filter((item) => !domain || item.entity_id.startsWith(domain + '.'))
      .filter((item) => !search || item.entity_id.includes(search) || String(item.attributes && item.attributes.friendly_name || '').toLowerCase().includes(search))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    if (!hits.length) return 'No entities' + (domain ? ' in ' + domain : '') + (search ? ' matching "' + search + '"' : '') + '.';
    const shown = hits.slice(0, MAX_LIST).map(entityLine);
    return clip(hits.length + ' entit' + (hits.length === 1 ? 'y' : 'ies') + ':\n' + shown.join('\n') + (hits.length > MAX_LIST ? '\n… ' + (hits.length - MAX_LIST) + ' more; narrow it with domain or search' : ''));
  }
  if (action === 'list_services') {
    if (!domain) throw new Error('list_services needs a domain, e.g. light.');
    const all = await request(config, 'GET', '/api/services', undefined, { fetchImpl, signal });
    const entry = (Array.isArray(all) ? all : []).find((item) => item && item.domain === domain);
    if (!entry) return 'Home Assistant has no services in ' + domain + '.';
    const rows = Object.entries(entry.services || {}).map(([name, info]) => {
      const fields = Object.keys(info && info.fields || {});
      return domain + '.' + name + (info && info.description ? ': ' + String(info.description).slice(0, 160) : '') + (fields.length ? '\n    fields: ' + fields.join(', ') : '');
    });
    return clip(rows.join('\n') + (BLOCKED_DOMAINS.has(domain) ? '\n(OASIS refuses to call services in ' + domain + '.)' : ''));
  }
  throw new Error('Unknown action ' + action + '. Use list_entities, get_state or list_services.');
}

export async function controlHomeAssistant(args = {}, { config, approval, autoApprove = false, ruleAllowed = false, fetchImpl, signal } = {}) {
  if (!config) throw new Error('Home Assistant is not configured. Set OASIS_HASS_URL and OASIS_HASS_TOKEN.');
  const domain = String(args.domain || '').trim().toLowerCase();
  const service = String(args.service || '').trim().toLowerCase();
  if (!NAME.test(domain) || !NAME.test(service)) throw new Error('home_assistant_control needs a domain and a service, e.g. light and turn_on.');
  if (BLOCKED_DOMAINS.has(domain) || BLOCKED_SERVICES.has(domain + '.' + service)) throw new Error(domain + '.' + service + ' can run code or manage the Home Assistant host, so OASIS does not call it. Do it in Home Assistant itself.');
  const ids = (Array.isArray(args.entity_id) ? args.entity_id : args.entity_id ? [args.entity_id] : []).map((id) => String(id).trim().toLowerCase());
  for (const id of ids) if (!ENTITY.test(id)) throw new Error('Invalid entity_id ' + id + '.');
  const data = args.data && typeof args.data === 'object' && !Array.isArray(args.data) ? { ...args.data } : {};
  delete data.entity_id;
  const body = { ...data, ...(ids.length ? { entity_id: ids.length === 1 ? ids[0] : ids } : {}) };
  const sensitive = SENSITIVE_DOMAINS.has(domain) || ids.some((id) => SENSITIVE_DOMAINS.has(id.split('.')[0]));
  if (!(ruleAllowed && !sensitive) && !(autoApprove && !sensitive)) {
    const message = 'Home Assistant: ' + domain + '.' + service + (ids.length ? ' on ' + ids.join(', ') : '') + (Object.keys(data).length ? '\n  data: ' + JSON.stringify(data).slice(0, 400) : '') + '\n  at ' + config.url + (sensitive ? '\n  This changes a lock, alarm, door, camera or climate device.' : '');
    if (!approval || !(await approval(message))) throw new Error('The user did not approve ' + domain + '.' + service + '.');
  }
  const changed = await request(config, 'POST', '/api/services/' + domain + '/' + service, body, { fetchImpl, signal });
  const rows = (Array.isArray(changed) ? changed : []).filter((item) => item && item.entity_id).map(entityLine);
  return 'Called ' + domain + '.' + service + (ids.length ? ' on ' + ids.join(', ') : '') + '.' + (rows.length ? '\nNow:\n' + rows.join('\n') : '\nNo entity reported a state change (some services act without changing state).');
}

export async function runHomeAssistantTool(name, args, context = {}) {
  const config = (context.session && context.session.homeAssistant) || hassConfig(context.env || process.env);
  if (name === 'home_assistant') return readHomeAssistant(args, { config, fetchImpl: context.fetchImpl, signal: context.signal });
  return controlHomeAssistant(args, { config, approval: context.approval, autoApprove: Boolean(context.autoApprove), ruleAllowed: Boolean(context.ruleAllowed), fetchImpl: context.fetchImpl, signal: context.signal });
}
