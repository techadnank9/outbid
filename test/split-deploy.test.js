/* The split deploy (static frontend on Firebase, API on Render) is a
   cross-origin setup. These tests cover what that breaks if unhandled. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4377;
const BASE = `http://127.0.0.1:${PORT}`;
const FRONTEND = 'https://outbidloll.web.app';
const dir = mkdtempSync(join(tmpdir(), 'outbid-split-'));
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: join(dir, 's.db'),
      NODE_ENV: 'test', STRIPE_SECRET_KEY: '',
      ALLOWED_ORIGINS: `${FRONTEND},https://outbidloll.firebaseapp.com`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/healthz'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
});
after(() => { child?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('CORS', () => {
  test('allows the configured frontend origin', async () => {
    const res = await fetch(BASE + '/api/board', { headers: { origin: FRONTEND } });
    assert.equal(res.headers.get('access-control-allow-origin'), FRONTEND);
    assert.equal(res.headers.get('vary'), 'Origin');
  });

  test('answers preflight with the headers the client needs', async () => {
    const res = await fetch(BASE + '/api/bid', {
      method: 'OPTIONS',
      headers: { origin: FRONTEND, 'access-control-request-method': 'POST' }
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers'), /x-visitor-id/);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  test('refuses an origin that is not on the list', async () => {
    const res = await fetch(BASE + '/api/board', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      'an unlisted origin must not receive an allow header');
  });

  test('refuses preflight from an unlisted origin', async () => {
    const res = await fetch(BASE + '/api/bid', {
      method: 'OPTIONS', headers: { origin: 'https://evil.example' }
    });
    assert.equal(res.status, 403);
  });

  test('error responses still carry CORS, or the client sees an opaque failure', async () => {
    const res = await fetch(BASE + '/api/bid', {
      method: 'POST',
      headers: { origin: FRONTEND, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'example.com', amount: 1 })
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), FRONTEND);
  });
});

describe('visitor identity without cookies', () => {
  test('honours a client-supplied visitor id', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    for (let i = 0; i < 3; i++){
      await fetch(BASE + '/api/stats', { headers: { origin: FRONTEND, 'x-visitor-id': id } });
    }
    const res = await fetch(BASE + '/api/stats', { headers: { origin: FRONTEND, 'x-visitor-id': id } });
    const body = await res.json();
    assert.equal(body.visitors, 1, 'the same id must count as one visitor, not four');
  });

  test('counts a second id separately', async () => {
    const res = await fetch(BASE + '/api/stats', {
      headers: { origin: FRONTEND, 'x-visitor-id': '99999999-8888-7777-6666-555555555555' }
    });
    assert.equal((await res.json()).visitors, 2);
  });

  test('ignores a malformed id rather than trusting it as a key', async () => {
    const res = await fetch(BASE + '/api/stats', {
      headers: { origin: FRONTEND, 'x-visitor-id': 'not-a-uuid; DROP TABLE visitors' }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.visitors >= 2, 'falls back to a generated id, table intact');
  });
});
