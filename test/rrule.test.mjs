import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRRule, rruleOccurrences, rruleNext, zonedInstant } from '../src/rrule.mjs';

const iso = (dates) => dates.map((d) => d.toISOString());

test('weekly BYDAY in a TZID zone, normalized text', () => {
  const rule = parseRRule('DTSTART;TZID=Asia/Dhaka:20261102T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
  assert.equal(rule.text, 'DTSTART;TZID=Asia/Dhaka:20261102T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
  // 09:00 in Dhaka is 03:00Z. 2026-11-11 is a Wednesday.
  assert.deepEqual(iso(rruleOccurrences(rule, new Date('2026-11-11T03:00:00Z'), { limit: 3 })), ['2026-11-13T03:00:00.000Z', '2026-11-16T03:00:00.000Z', '2026-11-18T03:00:00.000Z']);
  // One-line form (space instead of newline) reads the same.
  assert.equal(parseRRule('DTSTART;TZID=Asia/Dhaka:20261102T090000 RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR').text, rule.text);
});

test('INTERVAL counts from DTSTART: every other week, every 3 days', () => {
  const biweekly = parseRRule('DTSTART:20261102T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
  assert.deepEqual(iso(rruleOccurrences(biweekly, new Date('2026-11-02T10:00:00Z'), { limit: 2 })), ['2026-11-16T10:00:00.000Z', '2026-11-30T10:00:00.000Z']);
  const threeDays = parseRRule('DTSTART:20261101T000000Z\nRRULE:FREQ=DAILY;INTERVAL=3');
  assert.deepEqual(iso(rruleOccurrences(threeDays, new Date('2026-11-05T00:00:00Z'), { limit: 2 })), ['2026-11-07T00:00:00.000Z', '2026-11-10T00:00:00.000Z']);
});

test('monthly ordinals and month-end days', () => {
  const lastFriday = parseRRule('DTSTART:20260101T170000Z\nRRULE:FREQ=MONTHLY;BYDAY=-1FR');
  assert.deepEqual(iso(rruleOccurrences(lastFriday, new Date('2026-11-01T00:00:00Z'), { limit: 2 })), ['2026-11-27T17:00:00.000Z', '2026-12-25T17:00:00.000Z']);
  const firstMonday = parseRRule('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO');
  assert.deepEqual(iso(rruleOccurrences(firstMonday, new Date('2026-11-11T00:00:00Z'), { limit: 2 })), ['2026-12-07T09:00:00.000Z', '2027-01-04T09:00:00.000Z']);
  const lastDay = parseRRule('DTSTART:20260131T120000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.deepEqual(iso(rruleOccurrences(lastDay, new Date('2027-01-31T12:00:00Z'), { limit: 2 })), ['2027-02-28T12:00:00.000Z', '2027-03-31T12:00:00.000Z']);
  // FREQ=MONTHLY on the 31st skips months without one (RFC 5545).
  const the31st = parseRRule('DTSTART:20260131T120000Z\nRRULE:FREQ=MONTHLY');
  assert.deepEqual(iso(rruleOccurrences(the31st, new Date('2026-01-31T12:00:00Z'), { limit: 2 })), ['2026-03-31T12:00:00.000Z', '2026-05-31T12:00:00.000Z']);
});

test('yearly rules, including Feb 29 and Thanksgiving', () => {
  const leap = parseRRule('DTSTART:20240229T080000Z\nRRULE:FREQ=YEARLY');
  assert.deepEqual(iso(rruleOccurrences(leap, new Date('2026-11-11T00:00:00Z'), { limit: 1 })), ['2028-02-29T08:00:00.000Z']);
  const thanksgiving = parseRRule('DTSTART;TZID=America/New_York:20251127T120000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH');
  assert.deepEqual(iso(rruleOccurrences(thanksgiving, new Date('2026-01-01T00:00:00Z'), { limit: 2 })), ['2026-11-26T17:00:00.000Z', '2027-11-25T17:00:00.000Z']);
});

test('BYHOUR and BYMINUTE give several times a day', () => {
  const rule = parseRRule('DTSTART:20261111T000000Z\nRRULE:FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30');
  assert.deepEqual(iso(rruleOccurrences(rule, new Date('2026-11-11T10:00:00Z'), { limit: 4 })), ['2026-11-11T17:00:00.000Z', '2026-11-11T17:30:00.000Z', '2026-11-12T09:00:00.000Z', '2026-11-12T09:30:00.000Z']);
});

test('COUNT and UNTIL end the series', () => {
  const counted = parseRRule('DTSTART:20261101T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
  assert.deepEqual(iso(rruleOccurrences(counted, new Date('2026-10-01T00:00:00Z'), { limit: 10 })), ['2026-11-01T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  assert.equal(rruleNext(counted, new Date('2026-11-03T09:00:00Z')), null);
  const until = parseRRule('DTSTART:20261101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20261102T090000Z');
  assert.deepEqual(iso(rruleOccurrences(until, new Date('2026-10-01T00:00:00Z'), { limit: 10 })), ['2026-11-01T09:00:00.000Z', '2026-11-02T09:00:00.000Z']);
  // A date-only UNTIL in local time includes that whole day.
  const dateOnly = parseRRule('DTSTART;TZID=Asia/Dhaka:20261101T230000\nRRULE:FREQ=DAILY;UNTIL=20261102');
  assert.equal(rruleOccurrences(dateOnly, new Date('2026-10-01T00:00:00Z'), { limit: 10 }).length, 2);
});

test('daylight saving: wall-clock time is kept, gaps move forward, repeats take the first', () => {
  const daily = parseRRule('DTSTART;TZID=America/New_York:20270312T090000\nRRULE:FREQ=DAILY');
  // 2027-03-14 is the spring-forward day: 09:00 EST is 14:00Z, 09:00 EDT is 13:00Z.
  assert.deepEqual(iso(rruleOccurrences(daily, new Date('2027-03-13T00:00:00Z'), { limit: 2 })), ['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z']);
  // 02:30 does not exist on 2027-03-14 in New York: it runs at 03:30 EDT (07:30Z).
  assert.equal(new Date(zonedInstant(2027, 3, 14, 2, 30, 'America/New_York')).toISOString(), '2027-03-14T07:30:00.000Z');
  // 01:30 happens twice on 2027-11-07: the first (EDT, 05:30Z) is used.
  assert.equal(new Date(zonedInstant(2027, 11, 7, 1, 30, 'America/New_York')).toISOString(), '2027-11-07T05:30:00.000Z');
});

test('floating DTSTART uses the routine time zone; a missing DTSTART starts now', () => {
  const floating = parseRRule('DTSTART:20261101T090000\nRRULE:FREQ=DAILY');
  assert.equal(floating.floating, true);
  assert.equal(rruleNext(floating, new Date('2026-11-11T00:00:00Z'), { timezone: 'Asia/Dhaka' }).toISOString(), '2026-11-11T03:00:00.000Z');
  const now = new Date('2026-11-11T05:07:30Z');
  const noStart = parseRRule('RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0', { timezone: 'Asia/Dhaka', now });
  assert.match(noStart.text, /^DTSTART;TZID=Asia\/Dhaka:20261111T110700\n/);
  assert.equal(rruleNext(noStart, now).toISOString(), '2026-11-12T02:00:00.000Z');
});

test('unsupported or malformed rules are refused with a reason', () => {
  for (const [rule, reason] of [
    ['RRULE:FREQ=HOURLY', /not supported.*every 2h/],
    ['RRULE:FREQ=DAILY;BYSECOND=30', /BYSECOND is not supported.*one-minute floor/],
    ['RRULE:FREQ=MONTHLY;BYSETPOS=-1', /BYSETPOS needs another BY\* part/],
    ['RRULE:FREQ=MONTHLY;BYWEEKNO=20', /BYWEEKNO only works with FREQ=YEARLY/],
    ['RRULE:FREQ=MONTHLY;BYYEARDAY=100', /BYYEARDAY only works with FREQ=YEARLY/],
    ['RRULE:FREQ=YEARLY;BYSETPOS=0;BYDAY=MO', /BYSETPOS value 0 is out of range/],
    ['RRULE:FREQ=WEEKLY;BYDAY=1MO', /ordinals.*MONTHLY or FREQ=YEARLY/],
    ['RRULE:FREQ=DAILY;COUNT=2;UNTIL=20270101', /COUNT or UNTIL, not both/],
    ['DTSTART;TZID=Mars/Olympus:20261101T090000\nRRULE:FREQ=DAILY', /unknown time zone/],
    ['DTSTART:20260231T090000Z\nRRULE:FREQ=DAILY', /not a real date/],
    ['DTSTART:20261101T090000Z', /missing the RRULE/],
    ['RRULE:BYDAY=MO', /FREQ is required/],
    ['RRULE:FREQ=WEEKLY;BYMONTHDAY=1', /cannot be used with FREQ=WEEKLY/]
  ]) assert.throws(() => parseRRule(rule, { timezone: 'UTC' }), reason, rule);
});

test('BYSETPOS, BYWEEKNO and BYYEARDAY (expanded by rrule-temporal)', () => {
  const lastWeekday = parseRRule('DTSTART:20261101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
  assert.equal(lastWeekday.text, 'DTSTART:20261101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
  assert.deepEqual(iso(rruleOccurrences(lastWeekday, new Date('2026-11-01T00:00:00Z'), { limit: 3 })), ['2026-11-30T09:00:00.000Z', '2026-12-31T09:00:00.000Z', '2027-01-29T09:00:00.000Z']);
  const week20 = parseRRule('DTSTART:20260101T080000Z\nRRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO');
  assert.equal(rruleNext(week20, new Date('2026-11-12T00:00:00Z')).toISOString(), '2027-05-17T08:00:00.000Z');
  const day100 = parseRRule('DTSTART:20260101T080000Z\nRRULE:FREQ=YEARLY;BYYEARDAY=100');
  assert.equal(rruleNext(day100, new Date('2026-11-12T00:00:00Z')).toISOString(), '2027-04-10T08:00:00.000Z');
});

test('occurrences across daylight saving keep the wall clock; a skipped time moves forward', () => {
  const gap = parseRRule('DTSTART;TZID=America/New_York:20270312T023000\nRRULE:FREQ=DAILY');
  // 02:30 does not exist on 2027-03-14: that run is at 03:30 EDT, not dropped.
  assert.deepEqual(iso(rruleOccurrences(gap, new Date('2027-03-13T00:00:00Z'), { limit: 3 })), ['2027-03-13T07:30:00.000Z', '2027-03-14T07:30:00.000Z', '2027-03-15T06:30:00.000Z']);
  const repeat = parseRRule('DTSTART;TZID=America/New_York:20271106T013000\nRRULE:FREQ=DAILY');
  // 01:30 happens twice on 2027-11-07; it runs once, at the first (EDT).
  assert.deepEqual(iso(rruleOccurrences(repeat, new Date('2027-11-06T00:00:00Z'), { limit: 3 })), ['2027-11-06T05:30:00.000Z', '2027-11-07T05:30:00.000Z', '2027-11-08T06:30:00.000Z']);
});

test('a rule that can never match ends quietly instead of looping', () => {
  const started = Date.now();
  assert.equal(rruleNext('DTSTART:20260101T090000Z\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', new Date('2026-11-12T00:00:00Z')), null);
  assert.ok(Date.now() - started < 5000);
});
