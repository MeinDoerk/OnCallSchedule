import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeek, startOfWeek } from '../public/js/schedule.js';
import { sampleState } from '../public/js/sample.js';

const monday = startOfWeek(new Date());
const at = (day, hh, mm) => { const d = new Date(monday); d.setDate(d.getDate() + day); d.setHours(hh, mm, 0, 0); return d.toISOString(); };

function base() {
  return {
    families: [{ id: 'f1', name: 'Rivera', primaryDriverId: 'd1' }, { id: 'f2', name: 'Chen', primaryDriverId: null }],
    drivers: [{ id: 'd1', name: 'Maria', familyId: 'f1' }, { id: 'd2', name: 'Wei', familyId: 'f2' }],
    children: [{ id: 'c1', name: 'Sofia', familyId: 'f1' }, { id: 'c2', name: 'Mateo', familyId: 'f1' }, { id: 'c3', name: 'Emma', familyId: 'f2' }],
    teams: [
      { id: 't1', name: 'Soccer', childIds: ['c1', 'c3'] },
      { id: 't2', name: 'Swim', childIds: ['c2'] },
    ],
    events: [],
    tripOverrides: {},
  };
}
const ev = (id, teamId, day, sh, sm, eh, em, location) => ({ id, teamId, kind: 'PRACTICE', title: 'Practice', location, start: at(day, sh, sm), end: at(day, eh, em) });

test('each child gets a 20 minute trip there and back with the family driver', () => {
  const s = base();
  s.events.push(ev('e1', 't2', 1, 17, 0, 18, 0, 'Pool'));
  const week = buildWeek(s, monday);
  const [entry] = week.entries;
  assert.equal(entry.child.name, 'Mateo');
  const [to, from] = entry.trips;
  assert.equal(to.driver.name, 'Maria');
  assert.equal(new Date(to.start).toISOString(), at(1, 16, 40));
  assert.equal(new Date(from.end).toISOString(), at(1, 18, 20));
});

test('flags a driver booked for overlapping trips to different places', () => {
  const s = base();
  s.events.push(ev('e1', 't1', 1, 17, 30, 19, 0, 'Lakeside Park'), ev('e2', 't2', 1, 17, 45, 18, 45, 'Pool'));
  const week = buildWeek(s, monday);
  assert.ok(week.conflicts.length >= 1);
  assert.ok(week.conflicts.every((c) => c.driver.name === 'Maria'));
});

test('siblings or nearby events at the same place are one car, not a conflict', () => {
  const s = base();
  s.teams[1].childIds.push('c1');
  s.events.push(ev('e1', 't1', 1, 17, 30, 19, 0, 'Riverside Complex'), ev('e2', 't2', 1, 17, 45, 19, 15, 'Riverside complex.'));
  const week = buildWeek(s, monday);
  assert.equal(week.conflicts.length, 0);
});

test('suggests carpools between different drivers headed to the same place', () => {
  const s = base();
  s.events.push(ev('e1', 't1', 2, 17, 30, 19, 0, 'Lakeside Park'));
  const week = buildWeek(s, monday);
  assert.equal(week.shares.length, 2); // one group there, one back
  s.tripOverrides['e1|c3|to'] = 'd1';
  s.tripOverrides['e1|c3|from'] = 'd1';
  const after = buildWeek(s, monday);
  assert.equal(after.shares.length, 0);
  assert.equal(after.conflicts.length, 0);
});

test('reports trips with no driver', () => {
  const s = base();
  s.drivers = s.drivers.filter((d) => d.id !== 'd2');
  s.events.push(ev('e1', 't1', 3, 17, 0, 18, 0, 'Field'));
  assert.equal(buildWeek(s, monday).unassigned.length, 2);
});

test('sample data demonstrates both conflicts and carpool opportunities', () => {
  const week = buildWeek(sampleState(), monday);
  assert.ok(week.conflicts.length > 0);
  assert.ok(week.shares.length > 0);
});

test('groups several families at one place into one opportunity, offering only free drivers', () => {
  const s = base();
  s.families.push({ id: 'f3', name: 'Okafor', primaryDriverId: 'd3' });
  s.drivers.push({ id: 'd3', name: 'Ada', familyId: 'f3' });
  s.children.push({ id: 'c4', name: 'Jonah', familyId: 'f3' });
  s.teams.push({ id: 't3', name: 'Hoops', childIds: ['c4'] });
  s.events.push(
    ev('e1', 't1', 5, 9, 0, 10, 15, 'Riverside Complex'),   // Sofia (Maria) + Emma (Wei)
    ev('e2', 't3', 5, 9, 15, 10, 30, 'Riverside Complex'),  // Jonah (Ada)
    ev('e3', 't2', 5, 8, 50, 9, 30, 'Pool'),                // Mateo (Maria) -> Maria is double-booked
  );
  const week = buildWeek(s, monday);
  const toRiverside = week.shares.find((g) => g.trips[0].leg === 'to');
  assert.equal(toRiverside.trips.length, 3);
  const names = toRiverside.candidates.map((d) => d.name).sort();
  assert.deepEqual(names, ['Ada', 'Wei']);
  // Maria's clash with Mateo's swim trip counts once even with two kids in her car.
  s.tripOverrides['e1|c3|to'] = 'd1';
  assert.equal(buildWeek(s, monday).conflicts.filter((c) => c.trips.some((t) => t.leg === 'to')).length, 1);
});
