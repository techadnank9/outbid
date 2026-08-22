/* Promotion codes are enforced by Stripe and entered in Checkout, so what
   we test here is that nothing on our side can grant a discount. */

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
           NODE_ENV: 'test', STRIPE_SECRET_KEY: '', ADMIN_TOKEN: ADMIN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/healthz'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
});
after(() => { child?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('promotion codes are Stripe-side only', () => {
  test('a promo field in a bid request grants nothing', async () => {
    const res = await post('/api/bid', {
      target: 'example.com', amount: 5, promo: 'HACKATHON'
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.amount, 5, 'the bid is the bid; no discount is applied here');
    assert.equal(body.promo, undefined, 'the server never reports a discount of its own');
  });

  test('a discount cannot be forced through the amount field', async () => {
    const res = await post('/api/bid', { target: 'iana.org', amount: 0 });
    assert.equal(res.status, 400, 'below the floor is still refused');
  });

  test('the public promo endpoint reports availability, never a discount', async () => {
    const res = await fetch(BASE + '/api/promo');
    assert.equal(res.status, 200);
    const body = await res.json();
    // No Stripe key in tests, so it must say so rather than claiming a code.
    assert.equal(body.available, false);
    assert.ok(!('secret' in body) && !('coupon' in body));
  });

  test('the promo endpoint takes no user input to probe with', async () => {
    // The code name comes from server config, not the query string, so it
    // cannot be used to enumerate codes.
    const a = await (await fetch(BASE + '/api/promo?code=SOMETHINGELSE')).json();
    assert.equal(a.code, 'HACKATHON');
  });

  test('the admin promo endpoints require a token', async () => {
    assert.equal((await fetch(BASE + '/api/admin/promos')).status, 401);
    assert.equal((await post('/api/admin/promos', { code: 'FREEBIE' })).status, 401);
  });

  test('promo administration needs Stripe configured', async () => {
    const res = await fetch(BASE + '/api/admin/promos', {
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    assert.equal(res.status, 400, 'no Stripe key in this test server');
  });

  test('rejects a malformed code before calling Stripe', async () => {
    const res = await post('/api/admin/promos', { code: 'a' },
      { authorization: `Bearer ${ADMIN}` });
    assert.equal(res.status, 400);
  });
});
