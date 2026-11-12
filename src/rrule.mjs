// RFC 5545 recurrence rules for routines: one DTSTART line and one RRULE line,
// evaluated in the DTSTART time zone (TZID), in UTC (a trailing Z), or in the
// routine's own zone (floating time).
//
// Calendar expansion is done by rrule-temporal (MIT,
// https://github.com/ggaabe/rrule-temporal), a Temporal-based RFC 5545 engine.
// This module keeps the routine profile around it: readable errors, a
// normalized rule text, no sub-daily frequencies (FREQ=HOURLY and finer, and
// BYSECOND, are refused with a hint) and a one-minute floor.
//
// Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY
// (with +n/-n ordinals for MONTHLY and YEARLY), BYMONTHDAY (negative counts
// from the month end), BYMONTH, BYYEARDAY, BYWEEKNO, BYSETPOS, BYHOUR,
// BYMINUTE and WKST.
//
// Daylight saving: the rule is expanded on wall-clock times and each one is
// then placed in the zone, so a local time that falls in a daylight-saving
// gap moves forward by the gap and a time that occurs twice takes the first,
// the same as croner does for cron routines.
import { createRequire } from 'node:module';

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const DAY_MS = 86_400_000;
const MAX_COUNT = 10_000;

function fail(message) { throw new Error('RRULE: ' + message); }

function checkZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { fail('unknown time zone ' + tz + '.'); }
  return tz;
}

function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

const formatters = new Map();
function localFields(ms, tz) {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, format);
  }
  const parts = {};
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour === 24 ? 0 : parts.hour, mi: parts.minute, s: parts.second };
}

function offsetAt(ms, tz) {
  const f = localFields(ms, tz);
  return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - Math.floor(ms / 1000) * 1000;
}

// The instant for a wall-clock time in `tz`.
export function zonedInstant(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (tz === 'UTC') return wall;
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  const matches = [...new Set([wall - before, wall - after])].filter((ms) => {
    const f = localFields(ms, tz);
    return f.y === y && f.mo === mo && f.d === d && f.h === h && f.mi === mi;
  }).sort((a, b) => a - b);
  if (matches.length) return matches[0];
  return wall - before; // in a spring-forward gap: the offset in force before it
}

function parseStamp(value, label) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value);
  if (!m) fail(label + ' must look like 20261201T090000, 20261201T030000Z or 20261201.');
  const [y, mo, d, h = 0, mi = 0] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0].map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) fail(label + ' ' + value + ' is not a real date and time.');
  return { y, mo, d, h, mi, utc: Boolean(m[7]), dateOnly: !m[4] };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (f) => pad(f.y, 4) + pad(f.mo) + pad(f.d) + 'T' + pad(f.h) + pad(f.mi) + '00';

function intList(value, key, min, max, { nonZero = false } = {}) {
  const items = String(value).split(',').map((part) => part.trim());
  return items.map((item) => {
    if (!/^[+-]?\d{1,4}$/.test(item)) fail(key + ' must be a comma-separated list of numbers.');
    const n = Number(item);
    if (n < min || n > max || (nonZero && n === 0)) fail(key + ' value ' + item + ' is out of range (' + min + ' to ' + max + (nonZero ? ', not 0' : '') + ').');
    return n;
  });
}

// Parse and normalize. Returns { text, freq, interval, count, until, byday,
// bymonthday, bymonth, byhour, byminute, wkst, start: {y,mo,d,h,mi}, tz, floating }.
export function parseRRule(input, { timezone, now = new Date() } = {}) {
  const source = String(input || '').trim();
  if (!source) fail('empty rule.');
  const lines = source.split(/\s*[\r\n]+\s*|\s+(?=RRULE:)/i).map((line) => line.trim()).filter(Boolean);
  let dtstart = null;
  let rrule = null;
  for (const line of lines) {
    if (/^DTSTART[;:]/i.test(line)) { if (dtstart) fail('only one DTSTART line is allowed.'); dtstart = line; }
    else if (/^RRULE:/i.test(line)) { if (rrule) fail('only one RRULE line is allowed (RDATE, EXRULE and EXDATE are not supported).'); rrule = line; }
    else fail('unexpected line "' + line.slice(0, 60) + '"; use one DTSTART line and one RRULE line.');
  }
  if (!rrule) fail('missing the RRULE: line, for example RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR.');
  let tz = timezone ? checkZone(timezone) : null;
  let floating = false;
  let start;
  if (dtstart) {
    const m = /^DTSTART(?:;TZID=([^:;]+))?(?:;VALUE=DATE(?:-TIME)?)?:(.+)$/i.exec(dtstart);
    if (!m) fail('DTSTART must look like DTSTART;TZID=Asia/Dhaka:20261201T090000 or DTSTART:20261201T030000Z.');
    const parsed = parseStamp(m[2].trim(), 'DTSTART');
    if (m[1] && parsed.utc) fail('DTSTART cannot have both TZID and a trailing Z.');
    if (m[1]) tz = checkZone(m[1].trim());
    else if (parsed.utc) tz = 'UTC';
    else floating = true;
    start = { y: parsed.y, mo: parsed.mo, d: parsed.d, h: parsed.h, mi: parsed.mi };
  } else {
    if (!tz) tz = systemZone();
    const f = localFields(now.getTime(), tz);
    start = { y: f.y, mo: f.mo, d: f.d, h: f.h, mi: f.mi };
  }
  if (!tz) tz = systemZone();
  const rule = { interval: 1, count: null, until: null, byday: null, bymonthday: null, bymonth: null, byyearday: null, byweekno: null, bysetpos: null, byhour: null, byminute: null, wkst: 0 };
  const seen = new Set();
  for (const part of rrule.slice(6).split(';').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 1) fail('could not read "' + part + '"; use KEY=VALUE pairs separated by ";".');
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).trim().toUpperCase();
    if (seen.has(key)) fail(key + ' appears twice.');
    seen.add(key);
    if (key === 'FREQ') {
      if (['HOURLY', 'MINUTELY', 'SECONDLY'].includes(value)) fail('FREQ=' + value + ' is not supported; use FREQ=DAILY with BYHOUR, or a plain interval such as "every 2h".');
      if (!FREQS.has(value)) fail('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY.');
      rule.freq = value;
    } else if (key === 'INTERVAL') rule.interval = intList(value, key, 1, 1000)[0];
    else if (key === 'COUNT') rule.count = intList(value, key, 1, MAX_COUNT)[0];
    else if (key === 'UNTIL') rule.untilRaw = parseStamp(value, 'UNTIL');
    else if (key === 'BYDAY') {
      rule.byday = value.split(',').map((item) => {
        const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item.trim());
        if (!m) fail('BYDAY must list days such as MO,WE,FR or 1MO, -1FR.');
        const n = m[1] ? Number(m[1]) : 0;
        if (m[1] && (n === 0 || Math.abs(n) > 53)) fail('BYDAY ordinal ' + m[1] + ' is out of range.');
        return { n, day: DAYS.indexOf(m[2]) };
      });
    } else if (key === 'BYMONTHDAY') rule.bymonthday = intList(value, key, -31, 31, { nonZero: true });
    else if (key === 'BYMONTH') rule.bymonth = intList(value, key, 1, 12);
    else if (key === 'BYHOUR') rule.byhour = intList(value, key, 0, 23);
    else if (key === 'BYMINUTE') rule.byminute = intList(value, key, 0, 59);
    else if (key === 'WKST') { const i = DAYS.indexOf(value); if (i < 0) fail('WKST must be a day such as MO.'); rule.wkst = i; }
    else if (key === 'BYSETPOS') rule.bysetpos = intList(value, key, -366, 366, { nonZero: true });
    else if (key === 'BYYEARDAY') rule.byyearday = intList(value, key, -366, 366, { nonZero: true });
    else if (key === 'BYWEEKNO') rule.byweekno = intList(value, key, -53, 53, { nonZero: true });
    else if (key === 'BYSECOND') fail('BYSECOND is not supported; routine schedules have a one-minute floor.');
    else fail('unknown part ' + key + '.');
  }
  if (!rule.freq) fail('FREQ is required.');
  if (rule.count && rule.untilRaw) fail('use COUNT or UNTIL, not both.');
  if (rule.byday && rule.byday.some((d) => d.n) && !['MONTHLY', 'YEARLY'].includes(rule.freq)) fail('BYDAY ordinals such as 1MO only work with FREQ=MONTHLY or FREQ=YEARLY.');
  if (rule.bymonthday && rule.freq === 'WEEKLY') fail('BYMONTHDAY cannot be used with FREQ=WEEKLY.');
  if (rule.byweekno && rule.freq !== 'YEARLY') fail('BYWEEKNO only works with FREQ=YEARLY.');
  if (rule.byyearday && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.freq)) fail('BYYEARDAY only works with FREQ=YEARLY.');
  if (rule.bysetpos && !(rule.byday || rule.bymonthday || rule.bymonth || rule.byyearday || rule.byweekno || rule.byhour || rule.byminute)) fail('BYSETPOS needs another BY* part to pick from, for example BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1.');
  if (rule.byday && rule.byday.some((d) => d.n && Math.abs(d.n) > 5) && (rule.freq === 'MONTHLY' || rule.bymonth)) fail('a monthly BYDAY ordinal must be between -5 and 5.');
  const zone = tz;
  if (rule.untilRaw) {
    const u = rule.untilRaw;
    rule.until = u.utc ? Date.UTC(u.y, u.mo - 1, u.d, u.h, u.mi) : u.dateOnly ? zonedInstant(u.y, u.mo, u.d, 23, 59, zone) : zonedInstant(u.y, u.mo, u.d, u.h, u.mi, zone);
  }
  const parts = ['FREQ=' + rule.freq];
  if (rule.interval !== 1) parts.push('INTERVAL=' + rule.interval);
  if (rule.count) parts.push('COUNT=' + rule.count);
  if (rule.untilRaw) parts.push('UNTIL=' + new Date(rule.until).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
  if (rule.bymonth) parts.push('BYMONTH=' + rule.bymonth.join(','));
  if (rule.byweekno) parts.push('BYWEEKNO=' + rule.byweekno.join(','));
  if (rule.byyearday) parts.push('BYYEARDAY=' + rule.byyearday.join(','));
  if (rule.bymonthday) parts.push('BYMONTHDAY=' + rule.bymonthday.join(','));
  if (rule.byday) parts.push('BYDAY=' + rule.byday.map((d) => (d.n ? String(d.n) : '') + DAYS[d.day]).join(','));
  if (rule.byhour) parts.push('BYHOUR=' + rule.byhour.join(','));
  if (rule.byminute) parts.push('BYMINUTE=' + rule.byminute.join(','));
  if (rule.bysetpos) parts.push('BYSETPOS=' + rule.bysetpos.join(','));
  if (rule.wkst) parts.push('WKST=' + DAYS[rule.wkst]);
  const head = floating ? 'DTSTART:' + stamp(start) : zone === 'UTC' ? 'DTSTART:' + stamp(start) + 'Z' : 'DTSTART;TZID=' + zone + ':' + stamp(start);
  delete rule.untilRaw;
  return { ...rule, start, tz: zone, floating, text: head + '\nRRULE:' + parts.join(';') };
}

// rrule-temporal (and its bundled Temporal polyfill) loads with the first
// RRULE routine, not with every OASIS start.
const require = createRequire(import.meta.url);
let RRuleTemporal = null;
const MAX_ITERATIONS = 20_000;
const compiled = new Map();

// The same rule on wall-clock time: DTSTART as a UTC stamp and no UNTIL (UNTIL
// is an instant, checked after each wall time is placed in the zone).
function wallRule(rule) {
  const key = rule.text;
  let engine = compiled.get(key);
  if (!engine) {
    RRuleTemporal ||= require('rrule-temporal').RRuleTemporal;
    const parts = rule.text.slice(rule.text.indexOf('RRULE:') + 6).split(';').filter((part) => !part.startsWith('UNTIL='));
    engine = new RRuleTemporal({ rruleString: 'DTSTART:' + stamp(rule.start) + 'Z\nRRULE:' + parts.join(';'), maxIterations: MAX_ITERATIONS });
    if (compiled.size >= 64) compiled.delete(compiled.keys().next().value);
    compiled.set(key, engine);
  }
  return engine;
}

const HOUR_MS = 3_600_000;

// Occurrences strictly after `after`, at most `limit` of them.
export function rruleOccurrences(ruleOrText, after = new Date(), { limit = 1, timezone } = {}) {
  const rule = typeof ruleOrText === 'string' ? parseRRule(ruleOrText, { timezone }) : ruleOrText;
  const tz = rule.floating && timezone ? checkZone(timezone) : rule.tz;
  const afterMs = after.getTime();
  const engine = wallRule(rule);
  // Start a little before `after` on the wall clock: around a daylight-saving
  // change the wall clock and the instant can be up to a few hours apart.
  let cursor = new Date(afterMs + offsetAt(afterMs, tz) - 3 * HOUR_MS);
  const found = [];
  let last = -Infinity;
  while (found.length < limit) {
    let next;
    try { next = engine.next(cursor, false); } catch { break; } // no occurrence within the iteration bound
    if (!next) break;
    const wall = new Date(next.epochMilliseconds);
    const ms = zonedInstant(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), tz);
    if (rule.until != null && ms > rule.until) break;
    if (ms > afterMs && ms > last) { found.push(new Date(ms)); last = ms; }
    cursor = wall;
  }
  return found;
}

export function rruleNext(ruleOrText, after = new Date(), options = {}) {
  return rruleOccurrences(ruleOrText, after, { ...options, limit: 1 })[0] || null;
}
