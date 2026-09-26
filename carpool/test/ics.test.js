import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, guessKind } from '../public/js/ics.js';

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const window = { from: new Date('2026-01-01T00:00:00Z'), until: new Date('2027-01-01T00:00:00Z') };

test('reads a single UTC event with folded, escaped text', () => {
  const events = parseICS(wrap([
    'BEGIN:VEVENT', 'UID:abc', 'DTSTART:20260929T223000Z', 'DTEND:20260930T000000Z',
    'SUMMARY:Lightning vs. Comets', 'LOCATION:Lakeside Park\\, Field', ' 3',
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
  ].join('\r\n')), window);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Lightning vs. Comets');
  assert.equal(events[0].location, 'Lakeside Park, Field3');
  assert.equal(events[0].start, '2026-09-29T22:30:00.000Z');
  assert.equal(events[0].end, '2026-09-30T00:00:00.000Z');
});

test('converts TZID times, including across daylight saving', () => {
  const events = parseICS(wrap([
    'BEGIN:VEVENT', 'UID:tz', 'DTSTART;TZID=America/Chicago:20261027T173000',
    'DTEND;TZID=America/Chicago:20261027T190000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Practice', 'END:VEVENT',
  ].join('\r\n')), window);
  assert.equal(events.length, 2);
  assert.equal(events[0].start, '2026-10-27T22:30:00.000Z'); // CDT, UTC-5
  assert.equal(events[1].start, '2026-11-03T23:30:00.000Z'); // CST, UTC-6
});

test('expands weekly BYDAY rules, honouring EXDATE, UNTIL and moved instances', () => {
  const events = parseICS(wrap([
    'BEGIN:VEVENT', 'UID:p', 'DTSTART:20260901T220000Z', 'DTEND:20260901T233000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20260917T235959Z', 'EXDATE:20260908T220000Z', 'SUMMARY:Practice', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:p', 'RECURRENCE-ID:20260910T220000Z', 'DTSTART:20260910T230000Z', 'DTEND:20260911T003000Z', 'SUMMARY:Practice (late)', 'END:VEVENT',
  ].join('\r\n')), window);
  assert.deepEqual(events.map((e) => e.start), [
    '2026-09-01T22:00:00.000Z', '2026-09-03T22:00:00.000Z',
    '2026-09-10T23:00:00.000Z', '2026-09-15T22:00:00.000Z', '2026-09-17T22:00:00.000Z',
  ]);
  assert.equal(events[2].title, 'Practice (late)');
  assert.equal(new Set(events.map((e) => e.uid)).size, events.length);
});

test('skips cancelled events and marks all-day events', () => {
  const events = parseICS(wrap([
    'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261001T220000Z', 'STATUS:CANCELLED', 'SUMMARY:Rained out', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:y', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'SUMMARY:Tournament', 'END:VEVENT',
  ].join('\r\n')), window);
  assert.equal(events.length, 1);
  assert.equal(events[0].allDay, true);
});

test('guesses games versus practices from the title', () => {
  for (const t of ['Game vs Comets', 'Lightning @ Comets', 'Fall Tournament', 'Swim Meet', 'Match day']) assert.equal(guessKind(t), 'GAME', t);
  for (const t of ['Practice', 'Team training', 'Skills clinic', 'Gamers night practice']) assert.equal(guessKind(t), 'PRACTICE', t);
});
