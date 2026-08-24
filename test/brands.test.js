/* Each front-end is its own leaderboard over one API. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4344;
const BASE = `http://127.0.0.1:${PORT}`;
const OUTBID = 'https://outbidloll.web.app';
const SOCIAL = 'https://socialriselol.web.app';
const dir = mkdtempSync(join(tmpdir(), 'outbid-brand-'));
let child;

const post = (path, body, origin) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(body)
});
const get = async (path, origin) => (await fetch(BASE + path, { headers: { origin } })).json();

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'b.db'),
           NODE_ENV: 'test', STRIPE_SECRET_KEY: '',
           ALLOWED_ORIGINS: `${OUTBID},${SOCIAL}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/healthz'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
});
after(() => { child?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('separate boards per brand', () => {
  test('a bid on one brand does not appear on the other', async () => {
    await post('/api/bid', { target: 'example.com', amount: 50 }, OUTBID);

    assert.equal((await get('/api/board', OUTBID)).total, 1);
    assert.equal((await get('/api/board', SOCIAL)).total, 0,
      'SocialRise must not inherit Outbid listings');
  });

  test('the same target can be listed on both, independently', async () => {
    await post('/api/bid', { target: 'example.com', amount: 9 }, SOCIAL);

    const outbid = await get('/api/board', OUTBID);
    const social = await get('/api/board', SOCIAL);
    assert.equal(outbid.items[0].price, 50);
    assert.equal(social.items[0].price, 9, 'independent price on each board');
  });

  test('stats, revenue and rank are per brand', async () => {
    const o = await get('/api/stats', OUTBID);
    const s = await get('/api/stats', SOCIAL);
    assert.equal(o.topBid, 50);
    assert.equal(s.topBid, 9);
    assert.equal(o.nextBid, 51);
    assert.equal(s.nextBid, 10);
    assert.equal(o.listings, 1);
    assert.equal(s.listings, 1);
  });

  test('activity and categories do not leak across brands', async () => {
    const oa = await get('/api/activity', OUTBID);
    const sa = await get('/api/activity', SOCIAL);
    assert.equal(oa.items.length, 1);
    assert.equal(sa.items.length, 1);
    assert.notEqual(oa.items[0].price, sa.items[0].price);

    const oc = await get('/api/categories', OUTBID);
    const sc = await get('/api/categories', SOCIAL);
    const total = (c) => c.items.reduce((n, x) => n + x.listings, 0);
    assert.equal(total(oc), 1);
    assert.equal(total(sc), 1);
  });

  test('an unknown host falls back to the default board', async () => {
    const body = await get('/api/board', 'https://something-else.example');
    assert.equal(body.total, 1, 'defaults to outbid');
  });

  test('existing listings were migrated onto the default brand', async () => {
    // The migration assigns every pre-existing row to 'outbid', which is why
    // the Outbid board still has its listing above.
    assert.equal((await get('/api/board', OUTBID)).items[0].target, 'example.com');
  });
});
