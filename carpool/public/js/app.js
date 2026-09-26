import { parseICS, guessKind } from './ics.js';
import {
  buildWeek, startOfWeek, addDays, defaultDriverId, TRIP_MINUTES, SHARE_WINDOW_MINUTES,
} from './schedule.js';
import * as store from './store.js';
import { sampleState } from './sample.js';

const TEAM_COLORS = ['#2f6fed', '#d9480f', '#2b8a3e', '#7048e8', '#c2255c', '#0b7285', '#e8590c', '#5c940d'];
const HOUR = 3600000;

let state = store.emptyState();
const ui = {
  tab: 'week',
  weekStart: startOfWeek(new Date()),
  family: '',
  notice: null,
  busy: new Set(),
  expanded: new Set(),
};
const app = document.getElementById('app');
const dialog = document.getElementById('dialog');

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// ---------- tiny DOM helper ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') late[k] = v;
    else if (k === 'disabled' || k === 'required' || k === 'hidden') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  Object.assign(el, late);
  return el;
}

// In-page confirmation (browser confirm() pop-ups are blocked in some viewers).
function askConfirm(message, action = 'Delete') {
  const box = document.getElementById('confirm');
  return new Promise((resolve) => {
    const done = (answer) => { box.close(); resolve(answer); };
    box.replaceChildren(h('div', { class: 'dialog-form' },
      h('p', { class: 'confirm-text' }, message),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn danger', onclick: () => done(true) }, action))));
    box.onclose = () => resolve(false);
    box.showModal();
  });
}

// ---------- formatting ----------

const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShortDate = (d) => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function fmtRange(start) {
  const end = addDays(start, 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], { ...opts, year: 'numeric' })}`;
}

function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return fmtShortDate(iso);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kindLabel = (k) => (k === 'GAME' ? 'Game' : 'Practice');

// ---------- state helpers ----------

const find = (list, id) => list.find((x) => x.id === id);
const familyName = (id) => find(state.families, id)?.name;
const driverName = (id) => find(state.drivers, id)?.name;

function persist() {
  store.save(state, {
    onConflict(latest) {
      state = latest;
      notify('Someone else updated the schedule at the same moment, so the latest version has been loaded. Please make your last change again.', 'warn');
      render();
    },
    onError(message) {
      notify(`Your change could not be saved: ${message}`, 'error');
    },
  });
}

function commit(mutate) {
  mutate(state);
  persist();
  render();
}

let noticeTimer;
function notify(text, type = 'info') {
  ui.notice = { text, type };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { ui.notice = null; render(); }, type === 'info' ? 5000 : 10000);
  render();
}

function setKind(event, kind) {
  event.kind = kind;
  if (event.external) {
    const team = find(state.teams, event.teamId);
    if (team) (team.kindOverrides ||= {})[event.id] = kind;
  }
}

function applyCalendar(s, teamId, text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That file is not a calendar (.ics) file.');
  const team = find(s.teams, teamId);
  const overrides = team.kindOverrides || {};
  const parsed = parseICS(text);
  s.events = s.events.filter((e) => e.teamId !== teamId || !e.external);
  for (const p of parsed) {
    const id = `${teamId}:${p.uid}`;
    s.events.push({
      id, teamId, title: p.title, location: p.location, start: p.start, end: p.end,
      allDay: p.allDay, kind: overrides[id] || guessKind(p.title), external: true,
    });
  }
  team.source.lastFetched = new Date().toISOString();
  team.source.error = null;
  return parsed.length;
}

async function refreshTeam(teamId, { quiet = false } = {}) {
  const team = find(state.teams, teamId);
  if (!team?.source?.url) return;
  ui.busy.add(teamId);
  render();
  try {
    const text = await store.fetchCalendar(team.source.url);
    if (!find(state.teams, teamId)) return;
    const count = applyCalendar(state, teamId, text);
    persist();
    if (!quiet) notify(`${team.name}: ${plural(count, 'event')} loaded from the calendar.`);
  } catch (err) {
    const t = find(state.teams, teamId);
    if (t) { t.source.error = err.message; persist(); }
    if (!quiet) notify(`${team.name}: ${err.message}`, 'error');
  } finally {
    ui.busy.delete(teamId);
    render();
  }
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

function removeDriver(s, driverId) {
  s.drivers = s.drivers.filter((d) => d.id !== driverId);
  for (const f of s.families) if (f.primaryDriverId === driverId) f.primaryDriverId = null;
  for (const [k, v] of Object.entries(s.tripOverrides)) if (v === driverId) delete s.tripOverrides[k];
}

function removeChild(s, childId) {
  s.children = s.children.filter((c) => c.id !== childId);
  for (const t of s.teams) t.childIds = t.childIds.filter((id) => id !== childId);
  for (const k of Object.keys(s.tripOverrides)) if (k.split('|')[1] === childId) delete s.tripOverrides[k];
}

function removeTeam(s, teamId) {
  const ids = new Set(s.events.filter((e) => e.teamId === teamId).map((e) => e.id));
  s.teams = s.teams.filter((t) => t.id !== teamId);
  s.events = s.events.filter((e) => e.teamId !== teamId);
  for (const k of Object.keys(s.tripOverrides)) if (ids.has(k.split('|')[0])) delete s.tripOverrides[k];
}

function removeEvent(s, eventId) {
  s.events = s.events.filter((e) => e.id !== eventId);
  for (const k of Object.keys(s.tripOverrides)) if (k.split('|')[0] === eventId) delete s.tripOverrides[k];
}

// ---------- rendering ----------

function render() {
  const y = window.scrollY;
  app.replaceChildren(...[header(), ui.notice ? noticeBar() : null, h('main', { class: 'wrap' }, currentView())].filter(Boolean));
  window.scrollTo(0, y);
}

function currentView() {
  if (ui.tab === 'teams') return teamsView();
  if (ui.tab === 'families') return familiesView();
  return weekView();
}

function header() {
  const tab = (id, label) => h('button', {
    class: `tab${ui.tab === id ? ' active' : ''}`, 'aria-current': ui.tab === id ? 'page' : null,
    onclick: () => { ui.tab = id; render(); window.scrollTo(0, 0); },
  }, label);
  return h('header', { class: 'topbar' },
    h('div', { class: 'wrap topbar-inner' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '⟲'), 'Family Carpool'),
      h('nav', { class: 'tabs', 'aria-label': 'Sections' }, tab('week', 'Week'), tab('teams', 'Teams'), tab('families', 'Families & drivers'))));
}

function noticeBar() {
  return h('div', { class: `notice ${ui.notice.type}`, role: 'status' },
    h('div', { class: 'wrap notice-inner' },
      h('span', null, ui.notice.text),
      h('button', { class: 'link', onclick: () => { ui.notice = null; render(); } }, 'Dismiss')));
}

// ----- Week -----

function weekView() {
  if (!state.teams.length && !state.families.length) return welcome();

  const week = buildWeek(state, ui.weekStart, { familyId: ui.family });
  const visibleTrips = new Set(week.entries.flatMap((e) => e.trips));
  const conflicts = week.conflicts.filter((c) => c.trips.some((t) => visibleTrips.has(t)));
  const shares = week.shares.filter((c) => c.trips.some((t) => visibleTrips.has(t)));
  const noDriver = week.unassigned.filter((t) => visibleTrips.has(t));
  const thisWeek = +startOfWeek(new Date()) === +week.weekStart;

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'week-nav' },
      h('button', { class: 'btn icon', 'aria-label': 'Previous week', onclick: () => { ui.weekStart = addDays(ui.weekStart, -7); render(); } }, '‹'),
      h('h1', { class: 'week-label' }, fmtRange(week.weekStart)),
      h('button', { class: 'btn icon', 'aria-label': 'Next week', onclick: () => { ui.weekStart = addDays(ui.weekStart, 7); render(); } }, '›'),
      !thisWeek && h('button', { class: 'btn ghost', onclick: () => { ui.weekStart = startOfWeek(new Date()); render(); } }, 'This week')),
    h('div', { class: 'toolbar-right' },
      h('label', { class: 'inline-field' }, 'Show',
        h('select', { value: ui.family, onchange: (e) => { ui.family = e.target.value; render(); } },
          h('option', { value: '' }, 'All families'),
          state.families.map((f) => h('option', { value: f.id }, `${f.name} family`)))),
      state.teams.length ? h('button', { class: 'btn primary', onclick: () => openEventDialog(null) }, '+ Add event') : null));

  const summary = h('div', { class: 'summary' },
    h('span', { class: `chip ${conflicts.length ? 'conflict' : 'ok'}` }, conflicts.length ? `⚠ ${plural(conflicts.length, 'driver conflict')}` : '✓ No driver conflicts'),
    h('span', { class: `chip ${shares.length ? 'share' : 'muted'}` }, `⇄ ${shares.length} carpool ${shares.length === 1 ? 'opportunity' : 'opportunities'}`),
    noDriver.length ? h('span', { class: 'chip warn' }, `! ${plural(noDriver.length, 'trip')} without a driver`) : null,
    h('span', { class: 'chip muted' }, `Each trip is planned as ${TRIP_MINUTES} minutes`));

  const flags = (conflicts.length || shares.length)
    ? h('section', { class: 'flags', 'aria-label': 'Flags this week' },
      conflicts.map(conflictFlag), shares.map(shareFlag))
    : null;

  const grid = h('div', { class: 'week-grid' },
    week.days.map((day) => h('section', { class: `day${sameDay(day.date, new Date()) ? ' today' : ''}${day.entries.length ? '' : ' empty'}` },
      h('h2', { class: 'day-head' },
        h('span', { class: 'dow' }, day.date.toLocaleDateString([], { weekday: 'short' })),
        h('span', { class: 'dom' }, day.date.toLocaleDateString([], { month: 'short', day: 'numeric' }))),
      day.entries.length ? day.entries.map(entryCard) : h('p', { class: 'day-empty' }, 'No activities'))));

  const noEvents = !week.entries.length
    ? h('p', { class: 'hint' }, state.events.length
      ? 'Nothing is scheduled this week. Use the arrows to look at another week.'
      : 'No events yet. Add a team on the Teams tab, then subscribe to its calendar or enter its practices and games.')
    : null;

  return [toolbar, summary, flags, noEvents, grid];
}

function tripPhrase(t) {
  const child = t.entry.child?.name || 'Someone';
  const dir = t.leg === 'to' ? 'to' : 'home from';
  return `${child} ${dir} ${t.entry.team.name} ${kindLabel(t.entry.kind).toLowerCase()}`;
}

function conflictFlag(c) {
  const [a, b] = c.trips;
  return h('div', { class: 'flag conflict' },
    h('strong', null, `⚠ ${c.driver.name} can’t be in two places at once. `),
    `${fmtDay(a.start)}: driving ${tripPhrase(a)} (${fmtTime(a.start)}–${fmtTime(a.end)}) overlaps with ${tripPhrase(b)} (${fmtTime(b.start)}–${fmtTime(b.end)}). Pick another driver for one of these trips below.`);
}

function listNames(names) {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function shareFlag(share) {
  const group = share.trips;
  const first = group[0];
  const last = group[group.length - 1];
  const kids = listNames([...new Set(group.map((t) => t.entry.child?.name))]);
  const drivers = [...new Set(group.map((t) => (t.driver ? t.driver.name : 'no driver yet')))];
  const when = +first.anchor === +last.anchor
    ? `at ${fmtTime(first.anchor)}`
    : `between ${fmtTime(first.anchor)} and ${fmtTime(last.anchor)}`;
  const verb = first.leg === 'to' ? 'need to be at' : 'need a ride home from';
  return h('div', { class: 'flag share' },
    h('strong', null, '⇄ Carpool opportunity. '),
    `${fmtDay(first.anchor)}: ${kids} ${verb} ${first.location} ${when}. Right now that is ${drivers.length} separate drives (${listNames(drivers)}). `,
    share.candidates.slice(0, 2).map((d) => h('button', {
      class: 'link',
      onclick: () => commit((st) => {
        for (const t of group) if (t.driverId !== d.id) st.tripOverrides[t.key] = d.id;
      }),
    }, `Have ${d.name} drive everyone`)));
}

function kindBadge(event) {
  const next = event.kind === 'GAME' ? 'PRACTICE' : 'GAME';
  return h('button', {
    class: `badge ${event.kind === 'GAME' ? 'game' : 'practice'}`,
    title: `Marked as ${kindLabel(event.kind).toLowerCase()}. Click to change to ${kindLabel(next).toLowerCase()}.`,
    onclick: () => commit(() => setKind(event, next)),
  }, event.kind === 'GAME' ? 'GAME' : 'PRACTICE');
}

function entryCard(e) {
  const conflict = e.trips.some((t) => t.conflicts.length);
  const share = e.trips.some((t) => t.shares.length);
  return h('article', {
    class: `entry${conflict ? ' has-conflict' : ''}${share && !conflict ? ' has-share' : ''}`,
    style: `--team:${e.team.color}`,
  },
  h('div', { class: 'entry-top' },
    h('span', { class: 'child' }, e.child ? e.child.name : 'No child assigned'),
    kindBadge(e.event)),
  h('div', { class: 'when' }, e.event.allDay ? 'All day' : `${fmtTime(e.start)} – ${fmtTime(e.end)}`),
  e.event.location ? h('div', { class: 'where' }, e.event.location) : h('div', { class: 'where muted' }, 'No location given'),
  h('button', { class: 'team-line', onclick: () => openEventDialog(e.event), title: 'View or edit this event' },
    h('span', { class: 'dot', 'aria-hidden': 'true' }), e.team.name,
    e.event.title && !/^(practice|game)$/i.test(e.event.title) ? h('span', { class: 'muted' }, ` · ${e.event.title}`) : null),
  e.child && e.event.allDay ? h('p', { class: 'note' }, 'All-day event: arrange rides directly.') : null,
  !e.child ? h('p', { class: 'note' }, 'Assign a child to this team on the Teams tab.') : null,
  e.trips.map(tripRow));
}

function tripRow(t) {
  const lines = [];
  for (const o of t.conflicts) {
    lines.push(h('div', { class: 'trip-flag conflict' }, `⚠ ${t.driver.name} is also driving ${tripPhrase(o)}, ${fmtTime(o.start)}–${fmtTime(o.end)}`));
  }
  if (t.shares.length) {
    const others = listNames([...new Set(t.shares.map((o) => o.entry.child?.name))]);
    lines.push(h('div', { class: 'trip-flag share' }, `⇄ Could ride with ${others}`));
  }
  if (!t.driverId) {
    lines.push(h('div', { class: 'trip-flag warn' }, t.entry.family
      ? `! The ${t.entry.family.name} family has no driver yet.`
      : `! ${t.entry.child.name} is not in a family yet.`));
  }
  return h('div', { class: `trip${t.conflicts.length ? ' conflict' : ''}${t.shares.length ? ' share' : ''}${t.driverId ? '' : ' warn'}` },
    h('div', { class: 'trip-main' },
      h('span', { class: 'leg' }, t.leg === 'to' ? 'To' : 'From'),
      h('span', { class: 'trip-time' }, `${fmtTime(t.start)}–${fmtTime(t.end)}`),
      driverSelect(t)),
    lines);
}

function driverOptions(selectedId) {
  const groups = state.families
    .map((f) => ({ f, drivers: state.drivers.filter((d) => d.familyId === f.id) }))
    .filter((g) => g.drivers.length)
    .map((g) => h('optgroup', { label: `${g.f.name} family` },
      g.drivers.map((d) => h('option', { value: d.id, selected: d.id === selectedId }, d.name))));
  const loose = state.drivers.filter((d) => !d.familyId);
  if (loose.length) {
    groups.push(h('optgroup', { label: 'Not in a family' },
      loose.map((d) => h('option', { value: d.id, selected: d.id === selectedId }, d.name))));
  }
  return groups;
}

function driverSelect(t) {
  const def = defaultDriverId(state, t.entry.child.familyId);
  return h('select', {
    class: 'driver-select',
    'aria-label': `Driver ${t.leg === 'to' ? 'to' : 'from'} ${t.entry.team.name} for ${t.entry.child.name}`,
    value: t.overridden ? t.driverId : '',
    onchange: (ev) => commit((s) => {
      if (ev.target.value) s.tripOverrides[t.key] = ev.target.value;
      else delete s.tripOverrides[t.key];
    }),
  },
  h('option', { value: '' }, def ? driverName(def) : 'No driver'),
  driverOptions(t.overridden ? t.driverId : null));
}

function welcome() {
  return h('section', { class: 'welcome card' },
    h('h1', null, 'Plan every ride to practice and back'),
    h('p', null, 'Family Carpool lays out each week of practices and games, shows who is driving each child there and home again, and warns you when a driver is booked twice or when two families could share the drive.'),
    h('ol', { class: 'steps' },
      h('li', null, h('strong', null, 'Add your families. '), 'Enter each family, the adults who drive, and the children.'),
      h('li', null, h('strong', null, 'Add your teams. '), 'Subscribe to a team’s calendar link, import its .ics file, or type in practices and games yourself.'),
      h('li', null, h('strong', null, 'Put children on teams. '), 'The week view then fills itself in, using each child’s family driver.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { ui.tab = 'families'; render(); } }, 'Start with families'),
      h('button', { class: 'btn', onclick: () => commit((s) => Object.assign(s, { ...sampleState(), version: s.version })) }, 'Explore with sample data')));
}

// ----- Teams -----

function teamsView() {
  const addForm = h('form', {
    class: 'card add-team',
    onsubmit: async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const name = f.teamName.value.trim();
      const type = f.source.value;
      if (!name) return;
      const team = {
        id: newId(), name, color: TEAM_COLORS[state.teams.length % TEAM_COLORS.length],
        childIds: [], source: { type }, kindOverrides: {},
      };
      try {
        f.querySelector('button[type=submit]').disabled = true;
        let text = null;
        if (type === 'ics') {
          const url = f.url.value.trim();
          if (!url) throw new Error('Paste the team’s calendar link first.');
          team.source.url = url;
          text = await store.fetchCalendar(url);
        } else if (type === 'file') {
          const file = f.file.files[0];
          if (!file) throw new Error('Choose the .ics file to import.');
          team.source.fileName = file.name;
          text = await readFileText(file);
        }
        state.teams.push(team);
        let count = 0;
        try {
          if (text != null) count = applyCalendar(state, team.id, text);
        } catch (err) {
          state.teams.pop();
          throw err;
        }
        persist();
        notify(text != null ? `${name} added with ${plural(count, 'event')}.` : `${name} added. Now enter its practices and games.`);
      } catch (err) {
        notify(err.message, 'error');
        f.querySelector('button[type=submit]').disabled = false;
      }
    },
  },
  h('h2', null, 'Add a team'),
  h('div', { class: 'grid-2' },
    h('label', { class: 'field' }, 'Team name', h('input', { name: 'teamName', required: true, placeholder: 'e.g. Lightning U10 Soccer', autocomplete: 'off' })),
    h('fieldset', { class: 'field' },
      h('legend', null, 'Where do its events come from?'),
      h('div', { class: 'segmented' },
        [['manual', 'I’ll enter them'], ['ics', 'Calendar link'], ['file', '.ics file']].map(([v, label], i) => h('label', null,
          h('input', {
            type: 'radio', name: 'source', value: v, checked: i === 0,
            onchange: (e) => {
              const form = e.target.form;
              form.querySelector('.src-ics').hidden = v !== 'ics';
              form.querySelector('.src-file').hidden = v !== 'file';
            },
          }), h('span', null, label)))))),
  h('label', { class: 'field src-ics', hidden: true }, 'Calendar link (webcal:// or https:// ending in .ics)',
    h('input', { name: 'url', type: 'url', inputmode: 'url', placeholder: 'webcal://…/team-calendar.ics', autocomplete: 'off' }),
    h('span', { class: 'help' }, 'In TeamSnap, GameChanger, SportsEngine and most league sites, look for “Subscribe”, “Sync” or “Export calendar” and copy the link.')),
  h('label', { class: 'field src-file', hidden: true }, 'Calendar file', h('input', { name: 'file', type: 'file', accept: '.ics,text/calendar' })),
  h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add team')));

  return [
    h('div', { class: 'page-head' }, h('h1', null, 'Teams'), h('p', { class: 'lede' }, 'Each team has its own calendar. Put children on a team and its practices and games appear on their week.')),
    addForm,
    state.teams.length ? state.teams.map(teamCard) : h('p', { class: 'hint' }, 'No teams yet.'),
  ];
}

function teamCard(team) {
  const events = state.events.filter((e) => e.teamId === team.id).sort((a, b) => a.start.localeCompare(b.start));
  const cutoff = +startOfWeek(new Date());
  const upcoming = events.filter((e) => +new Date(e.end) >= cutoff);
  const showAll = ui.expanded.has(team.id);
  const shown = showAll ? upcoming : upcoming.slice(0, 6);
  const busy = ui.busy.has(team.id);

  let sourceLine;
  if (team.source.type === 'ics') {
    sourceLine = h('span', null, 'Subscribed to a calendar · updated ', ago(team.source.lastFetched),
      team.source.error ? h('span', { class: 'error-text' }, ` · Last refresh failed: ${team.source.error}`) : null);
  } else if (team.source.type === 'file') {
    sourceLine = `Imported from ${team.source.fileName || 'a file'} · ${ago(team.source.lastFetched)}`;
  } else {
    sourceLine = 'Events entered by hand';
  }

  const fileInput = h('input', {
    type: 'file', accept: '.ics,text/calendar', hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = applyCalendar(state, team.id, await readFileText(file));
        team.source.fileName = file.name;
        persist();
        notify(`${team.name}: ${plural(count, 'event')} imported.`);
      } catch (err) { notify(err.message, 'error'); }
    },
  });

  return h('section', { class: 'card team-card', style: `--team:${team.color}` },
    h('div', { class: 'card-head' },
      h('input', {
        type: 'color', class: 'swatch', value: team.color, 'aria-label': `Colour for ${team.name}`,
        onchange: (e) => commit(() => { team.color = e.target.value; }),
      }),
      h('div', { class: 'grow' },
        h('input', {
          class: 'title-input', value: team.name, 'aria-label': 'Team name',
          onchange: (e) => { const v = e.target.value.trim(); if (v) commit(() => { team.name = v; }); },
        }),
        h('div', { class: 'sub' }, sourceLine)),
      h('div', { class: 'row tight' },
        team.source.type === 'ics' ? h('button', { class: 'btn', disabled: busy, onclick: () => refreshTeam(team.id) }, busy ? 'Refreshing…' : 'Refresh') : null,
        team.source.type === 'file' ? [fileInput, h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Re-import')] : null,
        h('button', { class: 'btn', onclick: () => openEventDialog(null, team.id) }, '+ Event'),
        h('button', {
          class: 'btn danger-ghost',
          onclick: async () => { if (await askConfirm(`Delete ${team.name} and all of its events?`)) commit((s) => removeTeam(s, team.id)); },
        }, 'Delete'))),

    h('div', { class: 'team-body' },
      h('div', null,
        h('h3', null, 'Children on this team'),
        state.children.length
          ? h('div', { class: 'checks' }, state.children.map((c) => h('label', { class: 'check' },
            h('input', {
              type: 'checkbox', checked: team.childIds.includes(c.id),
              onchange: (e) => commit(() => {
                team.childIds = e.target.checked ? [...new Set([...team.childIds, c.id])] : team.childIds.filter((id) => id !== c.id);
              }),
            }),
            h('span', null, c.name, c.familyId ? h('span', { class: 'muted' }, ` · ${familyName(c.familyId)}`) : null))))
          : h('p', { class: 'hint' }, 'Add children on the Families & drivers tab first.')),
      h('div', null,
        h('h3', null, `Upcoming events (${upcoming.length})`),
        shown.length
          ? h('ul', { class: 'event-list' }, shown.map((ev) => h('li', null,
            h('button', { class: 'event-row', onclick: () => openEventDialog(ev) },
              h('span', { class: 'ev-date' }, fmtDay(ev.start)),
              h('span', { class: 'ev-time' }, ev.allDay ? 'All day' : `${fmtTime(ev.start)}–${fmtTime(ev.end)}`),
              h('span', { class: 'ev-title' }, ev.title, ev.location ? h('span', { class: 'muted' }, ` · ${ev.location}`) : null)),
            kindBadge(ev))))
          : h('p', { class: 'hint' }, team.source.type === 'manual' ? 'No upcoming events. Use “+ Event” to add practices and games.' : 'No upcoming events in this calendar.'),
        upcoming.length > 6
          ? h('button', { class: 'link', onclick: () => { showAll ? ui.expanded.delete(team.id) : ui.expanded.add(team.id); render(); } }, showAll ? 'Show fewer' : `Show all ${upcoming.length}`)
          : null)));
}

// ----- Event dialog -----

function openEventDialog(event, teamId) {
  const isNew = !event;
  const locked = Boolean(event?.external);
  const start = event ? new Date(event.start) : (() => { const d = new Date(Math.max(Date.now(), +ui.weekStart)); d.setHours(17, 30, 0, 0); return d; })();
  const end = event ? new Date(event.end) : new Date(+start + 1.5 * HOUR);
  const team = event ? find(state.teams, event.teamId) : null;

  const form = h('form', {
    method: 'dialog', class: 'dialog-form',
    onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      if (locked) {
        commit(() => setKind(event, f.kind.value));
        return dialog.close();
      }
      const s = new Date(`${f.startDate.value}T${f.startTime.value}`);
      const en = new Date(`${f.endDate.value}T${f.endTime.value}`);
      if (Number.isNaN(+s) || Number.isNaN(+en)) return notify('Please enter a start and end date and time.', 'error');
      if (en <= s) return notify('The event has to end after it starts.', 'error');
      commit((st) => {
        const target = isNew ? { id: newId(), external: false, allDay: false } : event;
        Object.assign(target, {
          teamId: f.team.value, title: f.evTitle.value.trim() || kindLabel(f.kind.value), kind: f.kind.value,
          location: f.evLocation.value.trim(), start: s.toISOString(), end: en.toISOString(), allDay: false,
        });
        if (isNew) st.events.push(target);
      });
      dialog.close();
    },
  },
  h('h2', null, isNew ? 'Add an event' : locked ? 'Event from team calendar' : 'Edit event'),
  locked ? h('p', { class: 'help' }, `This event comes from ${team?.name}’s calendar, so its time and place update automatically. You can still mark it as a practice or a game.`) : null,
  h('label', { class: 'field' }, 'Team',
    h('select', { name: 'team', value: event?.teamId || teamId || state.teams[0]?.id, disabled: locked },
      state.teams.map((t) => h('option', { value: t.id }, t.name)))),
  h('div', { class: 'grid-2' },
    h('label', { class: 'field' }, 'Title', h('input', { name: 'evTitle', value: event?.title || '', placeholder: 'Practice, vs. Comets…', disabled: locked })),
    h('fieldset', { class: 'field' }, h('legend', null, 'Type'),
      h('div', { class: 'segmented' },
        ['PRACTICE', 'GAME'].map((k) => h('label', null,
          h('input', { type: 'radio', name: 'kind', value: k, checked: (event?.kind || 'PRACTICE') === k }),
          h('span', null, kindLabel(k))))))),
  h('div', { class: 'grid-2' },
    h('label', { class: 'field' }, 'Starts',
      h('span', { class: 'pair' },
        h('input', {
          type: 'date', name: 'startDate', required: true, value: toDateInput(start), disabled: locked,
          onchange: (e) => { const f = e.target.form; if (f.endDate.value < e.target.value) f.endDate.value = e.target.value; },
        }),
        h('input', { type: 'time', name: 'startTime', required: true, value: toTimeInput(start), disabled: locked }))),
    h('label', { class: 'field' }, 'Ends',
      h('span', { class: 'pair' },
        h('input', { type: 'date', name: 'endDate', required: true, value: toDateInput(end), disabled: locked }),
        h('input', { type: 'time', name: 'endTime', required: true, value: toTimeInput(end), disabled: locked })))),
  h('label', { class: 'field' }, 'Location', h('input', { name: 'evLocation', value: event?.location || '', placeholder: 'Lakeside Park, Field 3', disabled: locked })),
  h('p', { class: 'help' }, `Drivers are booked ${TRIP_MINUTES} minutes before the start and ${TRIP_MINUTES} minutes after the end. Rides to the same place within ${SHARE_WINDOW_MINUTES} minutes are flagged as carpool opportunities.`),
  h('div', { class: 'row end' },
    !isNew && !locked ? h('button', {
      type: 'button', class: 'btn danger-ghost',
      onclick: async () => { dialog.close(); if (await askConfirm('Delete this event?')) commit((s) => removeEvent(s, event.id)); },
    }, 'Delete') : null,
    h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
    h('button', { type: 'submit', class: 'btn primary' }, isNew ? 'Add event' : 'Save')));

  dialog.replaceChildren(form);
  dialog.showModal();
}

// ----- Families -----

function familiesView() {
  const loneKids = state.children.filter((c) => !c.familyId);
  const loneDrivers = state.drivers.filter((d) => !d.familyId);

  return [
    h('div', { class: 'page-head' },
      h('h1', null, 'Families & drivers'),
      h('p', { class: 'lede' }, 'A child rides with their family’s driver unless you choose someone else for a trip on the Week tab. The starred driver is the family’s usual driver.')),
    h('form', {
      class: 'card inline-add',
      onsubmit: (e) => {
        e.preventDefault();
        const name = e.currentTarget.familyName.value.trim();
        if (name) commit((s) => s.families.push({ id: newId(), name, primaryDriverId: null }));
      },
    },
    h('label', { class: 'field grow' }, 'Add a family', h('input', { name: 'familyName', placeholder: 'Family name, e.g. Rivera', required: true, autocomplete: 'off' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add family')),
    h('div', { class: 'family-grid' }, state.families.map(familyCard)),
    (loneKids.length || loneDrivers.length) ? h('section', { class: 'card' },
      h('h2', null, 'Not in a family'),
      h('p', { class: 'help' }, 'These people were removed from a family. Put them in another family, or delete them for good.'),
      loneKids.length ? [h('h3', null, 'Children'), loneKids.map((c) => looseRow(c, 'child'))] : null,
      loneDrivers.length ? [h('h3', null, 'Drivers'), loneDrivers.map((d) => looseRow(d, 'driver'))] : null) : null,
  ];
}

function looseRow(person, type) {
  return h('div', { class: 'person-row' },
    h('span', { class: 'grow' }, person.name),
    state.families.length ? h('select', {
      'aria-label': `Add ${person.name} to a family`,
      onchange: (e) => e.target.value && commit(() => { person.familyId = e.target.value; }),
    }, h('option', { value: '' }, 'Add to family…'), state.families.map((f) => h('option', { value: f.id }, f.name))) : null,
    h('button', {
      class: 'btn small danger-ghost',
      onclick: async () => { if (await askConfirm(`Delete ${person.name} permanently?`)) commit((s) => (type === 'child' ? removeChild(s, person.id) : removeDriver(s, person.id))); },
    }, 'Delete'));
}

function familyCard(family) {
  const drivers = state.drivers.filter((d) => d.familyId === family.id);
  const kids = state.children.filter((c) => c.familyId === family.id);
  const primary = defaultDriverId(state, family.id);

  const addPerson = (type) => h('form', {
    class: 'mini-add',
    onsubmit: (e) => {
      e.preventDefault();
      const name = e.currentTarget.personName.value.trim();
      if (!name) return;
      commit((s) => {
        if (type === 'driver') {
          const d = { id: newId(), name, familyId: family.id };
          s.drivers.push(d);
          if (!primary) family.primaryDriverId = d.id;
        } else {
          s.children.push({ id: newId(), name, familyId: family.id });
        }
      });
    },
  },
  h('input', { name: 'personName', placeholder: type === 'driver' ? 'Driver’s name' : 'Child’s name', 'aria-label': `New ${type} for the ${family.name} family`, autocomplete: 'off', required: true }),
  h('button', { class: 'btn small', type: 'submit' }, 'Add'));

  return h('section', { class: 'card family-card' },
    h('div', { class: 'card-head' },
      h('input', {
        class: 'title-input', value: family.name, 'aria-label': 'Family name',
        onchange: (e) => { const v = e.target.value.trim(); if (v) commit(() => { family.name = v; }); },
      }),
      h('button', {
        class: 'btn small danger-ghost',
        onclick: async () => {
          if (!(await askConfirm(`Delete the ${family.name} family? Its children and drivers will be kept under “Not in a family”.`))) return;
          commit((s) => {
            s.families = s.families.filter((f) => f.id !== family.id);
            for (const p of [...s.children, ...s.drivers]) if (p.familyId === family.id) p.familyId = null;
          });
        },
      }, 'Delete family')),

    h('h3', null, 'Drivers'),
    drivers.length ? drivers.map((d) => h('div', { class: 'person-row' },
      h('button', {
        class: `star${d.id === primary ? ' on' : ''}`,
        title: d.id === primary ? 'Usual driver for this family' : 'Make this the usual driver',
        'aria-label': d.id === primary ? `${d.name} is the usual driver` : `Make ${d.name} the usual driver`,
        onclick: () => commit(() => { family.primaryDriverId = d.id; }),
      }, d.id === primary ? '★' : '☆'),
      h('span', { class: 'grow' }, d.name),
      h('button', { class: 'btn small ghost', onclick: () => commit(() => { d.familyId = null; if (family.primaryDriverId === d.id) family.primaryDriverId = null; }) }, 'Remove'))) : h('p', { class: 'hint warn-text' }, 'No drivers yet. This family’s children will show “no driver”.'),
    addPerson('driver'),

    h('h3', null, 'Children'),
    kids.length ? kids.map((c) => {
      const teams = state.teams.filter((t) => t.childIds.includes(c.id));
      return h('div', { class: 'person-row' },
        h('span', { class: 'grow' }, c.name,
          teams.length ? h('span', { class: 'team-tags' }, teams.map((t) => h('span', { class: 'tag', style: `--team:${t.color}` }, t.name))) : h('span', { class: 'muted' }, ' · no teams yet')),
        h('button', { class: 'btn small ghost', onclick: () => commit(() => { c.familyId = null; }) }, 'Remove'));
    }) : h('p', { class: 'hint' }, 'No children yet.'),
    addPerson('child'));
}

// ---------- start ----------

async function start() {
  state = await store.load();
  if (window.CARPOOL_PREVIEW && !state.teams.length && !state.families.length) {
    state = { ...sampleState(), version: 0 };
  }
  render();
  if (window.CARPOOL_PREVIEW) {
    ui.notice = { text: 'Preview with sample families. Your changes stay in this browser only. Calendar links need the full app, but you can import a downloaded .ics file.', type: 'info' };
    render();
  } else if (store.mode === 'local') {
    notify('Running without the app server: changes are saved in this browser only, and calendar links may not load.', 'warn');
  }
  for (const t of state.teams) {
    if (t.source?.type === 'ics' && (!t.source.lastFetched || Date.now() - new Date(t.source.lastFetched) > HOUR)) {
      refreshTeam(t.id, { quiet: true });
    }
  }
  const pull = async () => {
    if (store.mode !== 'server' || store.isSaving() || document.visibilityState !== 'visible' || dialog.open) return;
    const latest = await store.load();
    if (latest.version > state.version) { state = latest; render(); }
  };
  window.addEventListener('focus', pull);
  document.addEventListener('visibilitychange', pull);
}

start();
