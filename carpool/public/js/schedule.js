// Turns teams, children, families and drivers into a week of trips,
// then flags driver conflicts and carpool (shared driver) opportunities.

export const TRIP_MINUTES = 20;
export const SHARE_WINDOW_MINUTES = 30;
const MIN = 60000;

export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function tripKey(eventId, childId, leg) {
  return `${eventId}|${childId}|${leg}`;
}

/** The family's primary driver, or its first driver if none is marked primary. */
export function defaultDriverId(state, familyId) {
  if (!familyId) return null;
  const family = state.families.find((f) => f.id === familyId);
  const drivers = state.drivers.filter((d) => d.familyId === familyId);
  if (family?.primaryDriverId && drivers.some((d) => d.id === family.primaryDriverId)) {
    return family.primaryDriverId;
  }
  return drivers[0]?.id ?? null;
}

export function normalizeLocation(loc = '') {
  return loc.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Build the schedule for the 7 days starting at weekStart.
 * Returns { days: [{date, entries}], entries, trips, conflicts, shares }.
 */
export function buildWeek(state, weekStart, { familyId = '' } = {}) {
  const start = startOfWeek(weekStart);
  const end = addDays(start, 7);
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const teams = byId(state.teams);
  const children = byId(state.children);
  const families = byId(state.families);
  const drivers = byId(state.drivers);
  const overrides = state.tripOverrides || {};

  const entries = [];
  const trips = [];
  for (const ev of state.events) {
    const team = teams.get(ev.teamId);
    if (!team) continue;
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    if (evStart < start || evStart >= end) continue;

    const kids = team.childIds.map((id) => children.get(id)).filter(Boolean);
    if (!kids.length) {
      entries.push({ id: `${ev.id}|none`, event: ev, team, child: null, family: null, kind: ev.kind, start: evStart, end: evEnd, trips: [] });
      continue;
    }
    for (const child of kids) {
      const family = child.familyId ? families.get(child.familyId) : null;
      const entry = { id: `${ev.id}|${child.id}`, event: ev, team, child, family, kind: ev.kind, start: evStart, end: evEnd, trips: [] };
      if (!ev.allDay) {
        const fallback = defaultDriverId(state, child.familyId);
        for (const leg of ['to', 'from']) {
          const key = tripKey(ev.id, child.id, leg);
          const overridden = overrides[key] && drivers.has(overrides[key]);
          const driverId = overridden ? overrides[key] : fallback;
          const anchor = leg === 'to' ? evStart : evEnd; // arrive-by / pick-up time
          const trip = {
            key, leg, entry, anchor,
            driverId,
            driver: driverId ? drivers.get(driverId) : null,
            overridden: Boolean(overridden),
            start: leg === 'to' ? new Date(+evStart - TRIP_MINUTES * MIN) : evEnd,
            end: leg === 'to' ? evStart : new Date(+evEnd + TRIP_MINUTES * MIN),
            location: ev.location || '',
            conflicts: [],
            shares: [],
          };
          entry.trips.push(trip);
          trips.push(trip);
        }
      }
      entries.push(entry);
    }
  }

  const conflicts = findConflicts(trips);
  const shares = findShares(trips);

  const visible = familyId
    ? entries.filter((e) => e.family?.id === familyId || e.trips.some((t) => t.driver?.familyId === familyId))
    : entries;
  visible.sort((a, b) => a.start - b.start || (a.child?.name || '').localeCompare(b.child?.name || ''));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const next = addDays(start, i + 1);
    days.push({ date, entries: visible.filter((e) => e.start >= date && e.start < next) });
  }
  const unassigned = trips.filter((t) => !t.driverId);
  return { weekStart: start, days, entries: visible, trips, conflicts, shares, unassigned };
}

/**
 * Two trips can ride in one car when they head the same way, to the same place,
 * within the share window (one child simply arrives a little early or waits).
 */
export function canShareCar(a, b) {
  const loc = normalizeLocation(a.location);
  return a.leg === b.leg && Boolean(loc) && loc === normalizeLocation(b.location) &&
    Math.abs(a.anchor - b.anchor) <= SHARE_WINDOW_MINUTES * MIN;
}

/** Trips that would ride in the same car share this key. */
const carKey = (t) => `${t.leg}|${normalizeLocation(t.location)}|${+t.anchor}`;

function findConflicts(trips) {
  const conflicts = [];
  const seen = new Set();
  const byDriver = new Map();
  for (const t of trips) {
    if (!t.driverId) continue;
    if (!byDriver.has(t.driverId)) byDriver.set(t.driverId, []);
    byDriver.get(t.driverId).push(t);
  }
  for (const [driverId, list] of byDriver) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
        const a = list[i];
        const b = list[j];
        if (canShareCar(a, b)) continue;
        a.conflicts.push(b);
        b.conflicts.push(a);
        // Two children in one car clashing with a third trip is still one clash.
        const key = `${driverId}|${[carKey(a), carKey(b)].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ driver: a.driver, trips: [a, b] });
      }
    }
  }
  return conflicts;
}

/**
 * Groups trips headed the same way to the same place at about the same time.
 * A group is a carpool opportunity when more than one driver (or nobody yet)
 * is currently planned to make that drive.
 */
function findShares(trips) {
  const parent = trips.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < trips.length; i++) {
    for (let j = i + 1; j < trips.length; j++) {
      if (canShareCar(trips[i], trips[j])) parent[root(j)] = root(i);
    }
  }
  const groups = new Map();
  trips.forEach((t, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });

  const shares = [];
  for (const group of groups.values()) {
    const drivers = new Set(group.map((t) => t.driverId || null));
    if (group.length < 2 || (drivers.size === 1 && !drivers.has(null))) continue;
    for (const t of group) {
      t.shares = group.filter((o) => o !== t && (!t.driverId || o.driverId !== t.driverId));
    }
    group.sort((a, b) => a.anchor - b.anchor);
    const oneCar = group.every((a) => group.every((b) => canShareCar(a, b)));
    // Drivers who could take everyone without clashing with their other trips.
    const candidates = oneCar
      ? [...new Map(group.filter((t) => t.driver && !t.conflicts.length).map((t) => [t.driverId, t.driver])).values()]
      : [];
    shares.push({ trips: group, candidates });
  }
  shares.sort((a, b) => a.trips[0].anchor - b.trips[0].anchor);
  return shares;
}
