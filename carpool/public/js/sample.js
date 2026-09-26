// Demonstration data, placed in the current week so every feature is visible:
// a driver conflict (Maria on Tuesday) and carpool matches (soccer teammates,
// and two Saturday events at the same complex).

import { startOfWeek, addDays } from './schedule.js';

export function sampleState() {
  const monday = startOfWeek(new Date());
  const at = (dayOffset, h, m) => {
    const d = addDays(monday, dayOffset);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const ev = (id, teamId, title, kind, day, sh, sm, eh, em, location) => ({
    id, teamId, title, kind, location, allDay: false, external: false,
    start: at(day, sh, sm), end: at(day, eh, em),
  });

  return {
    version: 0,
    families: [
      { id: 'fam-rivera', name: 'Rivera', primaryDriverId: 'drv-maria' },
      { id: 'fam-chen', name: 'Chen', primaryDriverId: 'drv-wei' },
      { id: 'fam-okafor', name: 'Okafor', primaryDriverId: 'drv-ada' },
    ],
    drivers: [
      { id: 'drv-maria', name: 'Maria Rivera', familyId: 'fam-rivera' },
      { id: 'drv-dan', name: 'Dan Rivera', familyId: 'fam-rivera' },
      { id: 'drv-wei', name: 'Wei Chen', familyId: 'fam-chen' },
      { id: 'drv-ada', name: 'Ada Okafor', familyId: 'fam-okafor' },
    ],
    children: [
      { id: 'kid-sofia', name: 'Sofia', familyId: 'fam-rivera' },
      { id: 'kid-mateo', name: 'Mateo', familyId: 'fam-rivera' },
      { id: 'kid-emma', name: 'Emma', familyId: 'fam-chen' },
      { id: 'kid-jonah', name: 'Jonah', familyId: 'fam-okafor' },
    ],
    teams: [
      { id: 'team-lightning', name: 'Lightning U10 Soccer', color: '#2f6fed', childIds: ['kid-sofia', 'kid-emma'], source: { type: 'manual' }, kindOverrides: {} },
      { id: 'team-sharks', name: 'Northland Sharks Swim', color: '#0b7285', childIds: ['kid-mateo'], source: { type: 'manual' }, kindOverrides: {} },
      { id: 'team-hawks', name: 'Riverside Hawks Basketball', color: '#d9480f', childIds: ['kid-jonah'], source: { type: 'manual' }, kindOverrides: {} },
    ],
    events: [
      ev('ev-1', 'team-lightning', 'Practice', 'PRACTICE', 1, 17, 30, 19, 0, 'Lakeside Park, Field 3'),
      ev('ev-2', 'team-sharks', 'Swim practice', 'PRACTICE', 1, 17, 45, 18, 45, 'Northland Aquatic Center'),
      ev('ev-3', 'team-hawks', 'Practice', 'PRACTICE', 2, 18, 0, 19, 30, 'Oak Grove Middle School Gym'),
      ev('ev-4', 'team-lightning', 'Practice', 'PRACTICE', 3, 17, 30, 19, 0, 'Lakeside Park, Field 3'),
      ev('ev-5', 'team-sharks', 'Swim practice', 'PRACTICE', 3, 16, 0, 17, 0, 'Northland Aquatic Center'),
      ev('ev-6', 'team-lightning', 'vs. Blue Comets', 'GAME', 5, 9, 0, 10, 15, 'Riverside Sports Complex'),
      ev('ev-7', 'team-hawks', 'vs. Parkville Pistons', 'GAME', 5, 9, 15, 10, 30, 'Riverside Sports Complex'),
      ev('ev-8', 'team-sharks', 'Fall Invitational Meet', 'GAME', 6, 13, 0, 16, 0, 'Northland Aquatic Center'),
    ],
    tripOverrides: {},
  };
}
