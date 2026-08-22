/* Promo codes: a capped number of free listings. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4355;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'promo-admin-token';
const dir = mkdtempSync(join(tmpdir(), 'outbid-promo-'));
let child;

const post = (path, body, headers = {}) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'p.db'),
           NODE_ENV: 'test', STRIPE_SECRET_KEY: '', ADMIN_TOKEN: ADMIN,
           // The race test intentionally fires many bids from one address.
           BID_RATE_LIMIT: '200', PREVIEW_RATE_LIMIT: '200' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/healthz'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
});
after(() => { child?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('promo codes', () => {
  test('HACKATHON is seeded with 100 free listings', async () => {
    const s = await (await fetch(BASE + '/api/promo?code=HACKATHON')).json();
    assert.equal(s.valid, true);
    assert.equal(s.total, 100);
    assert.equal(s.remaining, 100);
    assert.equal(s.amount, 5);
  });

  test('the code is case-insensitive', async () => {
    const s = await (await fetch(BASE + '/api/promo?code=hackathon')).json();
    assert.equal(s.valid, true);
  });

  test('an unknown code is reported invalid, not accepted', async () => {
    const s = await (await fetch(BASE + '/api/promo?code=NOPE')).json();
    assert.equal(s.valid, false);
    assert.equal(s.reason, 'unknown');
  });

  test('redeeming lists for free and decrements the counter', async () => {
    const res = await post('/api/bid', { target: 'example.com', amount: 5, promo: 'HACKATHON' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'confirmed');
    assert.equal(body.amount, 5);
    assert.equal(body.remaining, 99);

    const board = await (await fetch(BASE + '/api/board')).json();
    assert.equal(board.items.find(i => i.target === 'example.com').price, 5);

    const s = await (await fetch(BASE + '/api/promo?code=HACKATHON')).json();
    assert.equal(s.remaining, 99);
  });

  test('a promo cannot be reused for the same listing', async () => {
    const res = await post('/api/bid', { target: 'example.com', amount: 5, promo: 'HACKATHON' });
    assert.equal(res.status, 409);
  });

  test('a promo cannot take a rank someone paid for', async () => {
    await post('/api/bid', { target: 'iana.org', amount: 50 });          // paid
    const res = await post('/api/bid', { target: 'iana.org', amount: 5, promo: 'HACKATHON' });
    assert.equal(res.status, 409, 'free listings must not displace paid ones');
  });

  test('a bogus code is refused rather than silently charging', async () => {
    const res = await post('/api/bid', { target: 'wikipedia.org', amount: 5, promo: 'FAKECODE' });
    assert.equal(res.status, 400);
    const board = await (await fetch(BASE + '/api/board')).json();
    assert.ok(!board.items.find(i => i.target === 'wikipedia.org'), 'nothing was listed');
  });

  test('the cap holds under concurrent redemption', async () => {
    // A tiny code, redeemed by more listings at once than it has slots.
    await post('/api/admin/promos', { code: 'RACE', amount: 5, max: 3 },
      { authorization: `Bearer ${ADMIN}` });

    const targets = Array.from({ length: 10 }, (_, i) => `race-${i}.example.com`);
    const results = await Promise.all(targets.map(t =>
      post('/api/bid', { target: t, amount: 5, promo: 'RACE' }).then(r => r.status)));

    const granted = results.filter(s => s === 200).length;
    assert.equal(granted, 3, `exactly 3 should succeed, got ${granted}`);

    const s = await (await fetch(BASE + '/api/promo?code=RACE')).json();
    assert.equal(s.valid, false);
    assert.equal(s.reason, 'exhausted');
  });

  test('an exhausted code is refused', async () => {
    const res = await post('/api/bid', { target: 'late.example.com', amount: 5, promo: 'RACE' });
    assert.equal(res.status, 400);
  });

  test('admin can create and list codes; others cannot', async () => {
    const unauth = await post('/api/admin/promos', { code: 'SNEAK', amount: 5, max: 10 });
    assert.equal(unauth.status, 401);

    const bad = await post('/api/admin/promos', { code: 'x', amount: 5, max: 10 },
      { authorization: `Bearer ${ADMIN}` });
    assert.equal(bad.status, 400, 'too short');

    const list = await (await fetch(BASE + '/api/admin/promos', {
      headers: { authorization: `Bearer ${ADMIN}` } })).json();
    assert.ok(list.items.find(p => p.code === 'HACKATHON'));
  });
});
