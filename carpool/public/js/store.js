// Loads and saves the shared schedule. Uses the server when it is running;
// falls back to this browser's local storage when the page is opened as a file.

const LOCAL_KEY = 'family-carpool-state';

export function emptyState() {
  return { version: 0, families: [], drivers: [], children: [], teams: [], events: [], tripOverrides: {} };
}

export let mode = 'server';
let chain = Promise.resolve();
let timer = null;
let pending = false;

export function isSaving() {
  return pending;
}

export async function load() {
  try {
    const res = await fetch('api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    mode = 'server';
    return { ...emptyState(), ...(await res.json()) };
  } catch {
    mode = 'local';
    try {
      return { ...emptyState(), ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') };
    } catch {
      return emptyState();
    }
  }
}

/**
 * Debounced save. onConflict(latest) is called when someone else saved first;
 * onError(message) when the save fails outright.
 */
export function save(state, { onConflict, onError, onSaved } = {}) {
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    chain = chain.then(() => write(state, { onConflict, onError, onSaved }));
  }, 300);
}

async function write(state, { onConflict, onError, onSaved }) {
  try {
    if (mode === 'local') {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
      onSaved?.();
      return;
    }
    const res = await fetch('api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (res.status === 409) {
      onConflict?.({ ...emptyState(), ...(await res.json()) });
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    const { version } = await res.json();
    state.version = version;
    onSaved?.();
  } catch (err) {
    onError?.(err.message || 'Could not save changes.');
  } finally {
    pending = timer !== null;
  }
}

/** Fetch a calendar feed's text, through the server when available. */
export async function fetchCalendar(url) {
  const clean = url.trim().replace(/^webcals?:\/\//i, 'https://');
  let res;
  try {
    res = mode === 'server'
      ? await fetch(`api/ics?url=${encodeURIComponent(clean)}`, { cache: 'no-store' })
      : await fetch(clean, { cache: 'no-store' });
  } catch {
    throw new Error(mode === 'server'
      ? 'Could not reach the app server.'
      : 'This calendar cannot be fetched without the app server. Start the server, or download the .ics file and import it.');
  }
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Calendar request failed (${res.status}).`);
  return text;
}
