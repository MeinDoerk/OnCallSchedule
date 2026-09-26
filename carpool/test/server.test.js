import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(await mkdtemp(path.join(os.tmpdir(), 'carpool-')), 'state.json');
const { createServer, isPrivateAddress, emptyState } = await import('../server.js');

test('blocks private and loopback addresses for calendar fetches', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('saves state with version checks and serves the app', async () => {
  const server = createServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await (await fetch(`${base}/api/state`)).json();
    assert.equal(initial.version, 0);
    const put = (body) => fetch(`${base}/api/state`, { method: 'PUT', body: JSON.stringify(body) });
    const ok = await put({ ...emptyState(), families: [{ id: 'f', name: 'Rivera' }] });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).version, 1);
    const stale = await put({ ...emptyState(), version: 0 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).families[0].name, 'Rivera');
    assert.equal((await put({ nonsense: true })).status, 400);
    assert.equal((await fetch(`${base}/api/ics?url=http://127.0.0.1/x.ics`)).status, 400);
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Family Carpool/);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 403);
  } finally {
    server.close();
  }
});
