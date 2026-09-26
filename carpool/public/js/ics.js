// Minimal iCalendar (.ics) reader for team calendar feeds.
// Handles line folding, UTC / TZID / floating times, all-day events,
// RRULE (DAILY, WEEKLY with BYDAY, MONTHLY, YEARLY), EXDATE,
// RECURRENCE-ID overrides and cancelled events.

const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
};

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86400000;
const MAX_ITERATIONS = 5000;

const GAME_PATTERN =
  /\b(game|games|vs\.?|versus|match|tournament|tourney|scrimmage|meet|championship|playoffs?|jamboree|invitational)\b|(^|\s)@\s/i;

/** Best guess at whether a calendar entry is a game or a practice. */
export function guessKind(title = '') {
  return GAME_PATTERN.test(title) ? 'GAME' : 'PRACTICE';
}

/**
 * Parse iCalendar text into concrete event occurrences.
 * @returns {{uid:string,title:string,location:string,start:string,end:string,allDay:boolean}[]}
 */
export function parseICS(text, opts = {}) {
  const now = Date.now();
  const from = opts.from ? +opts.from : now - 60 * DAY_MS;
  const until = opts.until ? +opts.until : now + 365 * DAY_MS;

  const raw = collectEvents(text);
  const overrides = new Map(); // uid -> Set of recurrence-id instants
  for (const ev of raw) {
    if (ev.recurrenceId) {
      const set = overrides.get(ev.uid) || new Set();
      set.add(toInstant(ev.recurrenceId));
      overrides.set(ev.uid, set);
    }
  }

  const out = [];
  for (const ev of raw) {
    if (!ev.start) continue;
    const skip = ev.recurrenceId ? new Set() : overrides.get(ev.uid) || new Set();
    const cancelled = ev.status === 'CANCELLED';
    for (const occ of expand(ev, skip, from, until)) {
      if (cancelled) continue;
      const recurring = Boolean(ev.rrule) || Boolean(ev.recurrenceId);
      out.push({
        uid: recurring ? `${ev.uid}@${new Date(occ.start).toISOString()}` : ev.uid,
        title: ev.title || 'Untitled event',
        location: ev.location || '',
        start: new Date(occ.start).toISOString(),
        end: new Date(occ.end).toISOString(),
        allDay: ev.start.dateOnly,
      });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

function collectEvents(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  let nested = 0; // depth inside VALARM etc. within a VEVENT
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      cur = { exdates: [], uid: `event-${++n}` };
      nested = 0;
      continue;
    }
    if (!cur) continue;
    if (upper === 'END:VEVENT') {
      events.push(cur);
      cur = null;
      continue;
    }
    if (upper.startsWith('BEGIN:')) { nested++; continue; }
    if (upper.startsWith('END:')) { nested = Math.max(0, nested - 1); continue; }
    if (nested) continue;

    const prop = parseLine(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    switch (name) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.title = unescapeText(value).trim(); break;
      case 'LOCATION': cur.location = unescapeText(value).trim(); break;
      case 'STATUS': cur.status = value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(value, params); break;
      case 'DTEND': cur.end = parseDateValue(value, params); break;
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'RRULE': cur.rrule = parseRRule(value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(value, params); break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const d = parseDateValue(v, params);
          if (d) cur.exdates.push(toInstant(d));
        }
        break;
    }
  }
  return events;
}

function parseLine(line) {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(v) {
  return v.replace(/\\([\\,;nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Returns civil date/time parts plus the zone they are expressed in. */
function parseDateValue(value, params = {}) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0, dateOnly: true, zone: 'floating' };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const parts = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), dateOnly: false };
  if (m[7]) parts.zone = 'utc';
  else parts.zone = resolveTz(params.TZID) || 'floating';
  return parts;
}

function resolveTz(tzid) {
  if (!tzid) return null;
  let tz = WINDOWS_TZ[tzid] || tzid;
  // Some producers prefix a path, e.g. "/mozilla.org/20050126_1/America/Chicago".
  const m = /([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(tz);
  if (m) tz = m[1];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const fmtCache = new Map();
function tzOffsetMs(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ts))) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function toInstant(p) {
  if (p.zone === 'utc') return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  if (p.zone === 'floating') return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s).getTime();
  const guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const off = tzOffsetMs(guess, p.zone);
  let ts = guess - off;
  const off2 = tzOffsetMs(ts, p.zone);
  if (off2 !== off) ts = guess - off2;
  return ts;
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRRule(v) {
  const rule = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    if (k && val) rule[k.toUpperCase()] = val.toUpperCase();
  }
  return rule;
}

function addDays(p, n) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * DAY_MS);
  return { ...p, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday(p) {
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function* candidates(start, rule) {
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10));
  switch (rule.FREQ) {
    case 'DAILY':
      for (let k = 0; ; k++) yield addDays(start, k * interval);
    case 'WEEKLY': {
      const days = (rule.BYDAY ? rule.BYDAY.split(',') : [DAY_CODES[weekday(start)]])
        .map((c) => DAY_CODES.indexOf(c.replace(/^[+-]?\d+/, '')))
        .filter((i) => i >= 0)
        .map((i) => (i + 6) % 7) // Monday-first offsets
        .sort((a, b) => a - b);
      const monday = addDays(start, -((weekday(start) + 6) % 7));
      const startKey = Date.UTC(start.y, start.mo - 1, start.d);
      for (let w = 0; ; w++) {
        for (const off of days) {
          const c = addDays(monday, w * 7 * interval + off);
          if (Date.UTC(c.y, c.mo - 1, c.d) >= startKey) yield c;
        }
      }
    }
    case 'MONTHLY':
      for (let k = 0; ; k++) {
        const total = start.mo - 1 + k * interval;
        const y = start.y + Math.floor(total / 12);
        const mo = (total % 12) + 1;
        if (start.d <= daysInMonth(y, mo)) yield { ...start, y, mo };
      }
    case 'YEARLY':
      for (let k = 0; ; k++) {
        const y = start.y + k * interval;
        if (start.d <= daysInMonth(y, start.mo)) yield { ...start, y };
      }
    default:
      yield start;
  }
}

function* expand(ev, skip, from, until) {
  const startMs = toInstant(ev.start);
  let durationMs;
  if (ev.end) durationMs = toInstant(ev.end) - startMs;
  else if (ev.duration != null) durationMs = ev.duration;
  else durationMs = ev.start.dateOnly ? DAY_MS : 3600000;
  if (!(durationMs >= 0)) durationMs = 3600000;

  if (!ev.rrule || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(ev.rrule.FREQ)) {
    if (startMs + durationMs >= from && startMs <= until) yield { start: startMs, end: startMs + durationMs };
    return;
  }

  const maxCount = ev.rrule.COUNT ? parseInt(ev.rrule.COUNT, 10) : Infinity;
  let untilMs = Infinity;
  if (ev.rrule.UNTIL) {
    const u = parseDateValue(ev.rrule.UNTIL);
    if (u) untilMs = u.dateOnly ? toInstant(u) + DAY_MS - 1 : toInstant(u);
  }
  const exdates = new Set(ev.exdates);
  let count = 0;
  let iterations = 0;
  for (const c of candidates(ev.start, ev.rrule)) {
    if (++iterations > MAX_ITERATIONS) break;
    const s = toInstant(c);
    if (s > untilMs || s > until) break;
    if (++count > maxCount) break;
    if (exdates.has(s) || skip.has(s)) continue;
    if (s + durationMs < from) continue;
    yield { start: s, end: s + durationMs };
  }
}
