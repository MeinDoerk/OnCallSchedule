// Family Carpool server: serves the app, stores the shared schedule in a
// JSON file, and fetches subscribed team calendars on the browser's behalf
// (most calendar providers do not allow browsers to fetch feeds directly).

import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'state.json');
const PORT = Number(process.env.PORT) || 3000;
const ALLOW_PRIVATE_FEEDS = process.env.ALLOW_PRIVATE_FEEDS === '1';
const MAX_BODY = 5 * 1024 * 1024;
const MAX_FEED = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ics': 'text/calendar; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function emptyState() {
  return { version: 0, families: [], drivers: [], children: [], teams: [], events: [], tripOverrides: {} };
}

async function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(await readFile(DATA_FILE, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, DATA_FILE);
}

// Writes are serialized so two saves can never interleave.
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Schedule is too large to save.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isValidState(s) {
  return s && typeof s === 'object' &&
    ['families', 'drivers', 'children', 'teams', 'events'].every((k) => Array.isArray(s[k])) &&
    typeof (s.tripOverrides ?? {}) === 'object';
}

// ---- Calendar feed proxy with protection against reaching internal hosts ----

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Calendar address must start with https://, http:// or webcal://'), { status: 400 });
  if (ALLOW_PRIVATE_FEEDS) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error('That calendar address points to a private network.'), { status: 400 });
  }
}

async function fetchFeed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw Object.assign(new Error('That does not look like a web address.'), { status: 400 });
  }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(u);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/calendar, */*' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = new URL(res.headers.get('location'), u);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`The calendar service answered ${res.status}.`), { status: 502 });
    const text = await res.text();
    if (text.length > MAX_FEED) throw Object.assign(new Error('That calendar is too large.'), { status: 502 });
    if (!/BEGIN:VCALENDAR/i.test(text)) throw Object.assign(new Error('That address did not return a calendar (.ics) feed.'), { status: 502 });
    return text;
  }
  throw Object.assign(new Error('The calendar address redirected too many times.'), { status: 502 });
}

// ---- Static files ----

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, await readState());
      }
      if (pathname === '/api/state' && req.method === 'PUT') {
        let incoming;
        try { incoming = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return send(res, 400, { error: 'Invalid JSON' }); }
        if (!isValidState(incoming)) return send(res, 400, { error: 'Invalid schedule data' });
        return await withLock(async () => {
          const current = await readState();
          if (incoming.version !== current.version) return send(res, 409, current);
          const next = { ...incoming, version: current.version + 1 };
          await writeState(next);
          return send(res, 200, { version: next.version });
        });
      }
      if (pathname === '/api/ics' && req.method === 'GET') {
        const url = searchParams.get('url');
        if (!url) return send(res, 400, 'Missing url', 'text/plain; charset=utf-8');
        let text;
        try {
          text = await fetchFeed(url);
        } catch (err) {
          if (err.status || err.name === 'TimeoutError') throw err;
          throw Object.assign(new Error('Could not reach that calendar address. Check it and try again.'), { status: 502 });
        }
        return send(res, 200, text, 'text/calendar; charset=utf-8');
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      send(res, 405, 'Method not allowed', 'text/plain');
    } catch (err) {
      const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
      const message = err.status ? err.message : status === 504 ? 'The calendar service took too long to answer.' : 'Something went wrong on the server.';
      if (!err.status) console.error(err);
      send(res, status, message, 'text/plain; charset=utf-8');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`Family Carpool running at http://localhost:${PORT}`);
  });
}
