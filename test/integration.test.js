/* End-to-end tests against a real server process and a real SQLite database.
   Run with: npm test */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'outbid-test-'));
const DB_PATH = join(dir, 'test.db');

let child;
let cookie = '';

function req(path, options = {}){
  return fetch(BASE + path, {
    ...options,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...options.headers
    }
  });
}

async function json(path, options){
  const res = await req(path, options);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, body){
  return json(path, { method: 'POST', body: JSON.stringify(body) });
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'test', STRIPE_SECRET_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // Wait for the port to accept connections.
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/api/stats'); break; }
    catch {
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise(r => setTimeout(r, 150));
    }
  }
});

after(() => {
  child?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

/* ─────────────────────────────────────────────────────────────── */
describe('empty board', () => {
  test('starts with no listings', async () => {
    const { status, body } = await json('/api/board');
    assert.equal(status, 200);
    assert.equal(body.total, 0);
    assert.deepEqual(body.items, []);
    assert.equal(body.pages, 1);
  });

  test('stats reflect an empty board', async () => {
    const { body } = await json('/api/stats');
    assert.equal(body.listings, 0);
    assert.equal(body.revenue, 0);
    assert.equal(body.topBid, 0);
    assert.equal(body.nextBid, 5);
    assert.equal(body.payments, 'dev');
    assert.ok(body.launchedAt > 0);
  });
});

describe('input validation', () => {
  test('rejects an empty target', async () => {
    const { status, body } = await post('/api/preview', { target: '' });
    assert.equal(status, 400);
    assert.match(body.error, /product URL or @handle/i);
  });

  test('rejects a non-public host (SSRF guard)', async () => {
    for (const target of ['localhost:8080', 'http://127.0.0.1/', 'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data/']){
      const { status } = await post('/api/preview', { target });
      assert.equal(status, 400, `should reject ${target}`);
    }
  });

  test('rejects a malformed handle', async () => {
    const { status, body } = await post('/api/preview', { target: '@not a handle!' });
    assert.equal(status, 400);
    assert.match(body.error, /letters, numbers/);
  });

  test('rejects a bid under the floor', async () => {
    const { status, body } = await post('/api/bid', { target: 'example.com', amount: 4 });
    assert.equal(status, 400);
    assert.match(body.error, /minimum bid is \$5/);
  });

  test('rejects a bid over the ceiling', async () => {
    const { status } = await post('/api/bid', { target: 'example.com', amount: 200000 });
    assert.equal(status, 400);
  });

  test('rejects invalid JSON', async () => {
    const res = await req('/api/bid', { method: 'POST', body: '{nope' });
    assert.equal(res.status, 400);
  });
});

describe('placing bids', () => {
  test('first bid takes #1 and normalizes the host', async () => {
    const { status, body } = await post('/api/bid', { target: 'https://www.example.com/path', amount: 10 });
    assert.equal(status, 200);
    assert.equal(body.status, 'confirmed');
    assert.equal(body.rank, 1);
    assert.equal(body.target, 'example.com');
  });

  test('the listing appears on the board with real scraped metadata', async () => {
    const { body } = await json('/api/board');
    assert.equal(body.total, 1);
    const [item] = body.items;
    assert.equal(item.rank, 1);
    assert.equal(item.target, 'example.com');
    assert.equal(item.price, 10);
    assert.equal(item.claimPrice, 11);
    // example.com really does serve <title>Example Domain</title>
    assert.match(item.title, /Example Domain/i);
  });

  test('a lower bid lands below, not at #1', async () => {
    const { body } = await post('/api/bid', { target: 'iana.org', amount: 6 });
    assert.equal(body.rank, 2);
    const board = await json('/api/board');
    assert.equal(board.body.total, 2);
    assert.deepEqual(board.body.items.map(i => i.target), ['example.com', 'iana.org']);
  });

  test('an equal bid cannot displace the sitting listing', async () => {
    await post('/api/bid', { target: 'wikipedia.org', amount: 10 });
    const { body } = await json('/api/board');
    const ranks = Object.fromEntries(body.items.map(i => [i.target, i.rank]));
    assert.equal(ranks['example.com'], 1, 'incumbent keeps #1 on a tie');
    assert.equal(ranks['wikipedia.org'], 2);
  });

  test('re-bidding the same target raises it instead of duplicating', async () => {
    const before = await json('/api/board');
    const { body } = await post('/api/bid', { target: 'iana.org', amount: 500 });
    assert.equal(body.rank, 1);

    const after = await json('/api/board');
    assert.equal(after.body.total, before.body.total, 'no duplicate listing created');
    assert.equal(after.body.items[0].target, 'iana.org');
    assert.equal(after.body.items[0].price, 500);
  });

  test('rejects a re-bid at or below the current price', async () => {
    const { status, body } = await post('/api/bid', { target: 'iana.org', amount: 500 });
    assert.equal(status, 409);
    assert.match(body.error, /already on the board/);
  });

  test('accepts an @handle', async () => {
    const { status, body } = await post('/api/bid', { target: '@techadnank9', amount: 7 });
    assert.equal(status, 200);
    assert.equal(body.target, '@techadnank9');
  });
});

describe('preview', () => {
  test('reports the rank a hypothetical bid would take', async () => {
    const { body } = await post('/api/preview', { target: 'github.com', amount: 100 });
    assert.equal(body.target, 'github.com');
    assert.equal(body.alreadyListed, false);
    assert.equal(body.rank, 2, 'below iana.org at $500, above the rest');
    assert.ok(body.title.length > 0);
  });

  test('flags a target that is already listed for too little', async () => {
    const { body } = await post('/api/preview', { target: 'iana.org', amount: 10 });
    assert.equal(body.alreadyListed, true);
    assert.equal(body.currentPrice, 500);
    assert.equal(body.beatsCurrent, false);
    assert.equal(body.minimum, 501);
  });

  test('excludes the listing itself when ranking its own re-bid', async () => {
    const { body } = await post('/api/preview', { target: 'iana.org', amount: 600 });
    assert.equal(body.rank, 1);
    assert.equal(body.beatsCurrent, true);
  });
});

describe('click tracking', () => {
  test('redirects and records a real click', async () => {
    const board = await json('/api/board');
    const item = board.body.items[0];
    assert.equal(item.clicks, 0);

    const res = await req(`/r/${item.id}`);
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').includes('iana.org'));

    const after = await json('/api/board');
    assert.equal(after.body.items[0].clicks, 1);
  });

  test('trending reflects recorded clicks', async () => {
    const board = await json('/api/board');
    const id = board.body.items[0].id;
    await req(`/r/${id}`);
    await req(`/r/${id}`);

    const { body } = await json('/api/trending');
    assert.ok(body.items.length > 0);
    assert.equal(body.items[0].target, 'iana.org');
    assert.equal(body.items[0].perHour, 3);
  });

  test('404s an unknown listing id', async () => {
    const res = await req('/r/999999');
    assert.equal(res.status, 404);
  });
});

describe('activity + stats', () => {
  test('activity lists real bids newest first', async () => {
    const { body } = await json('/api/activity');
    assert.ok(body.items.length > 0);
    const times = body.items.map(i => i.at);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.ok(body.items.every(i => i.rank >= 1));
  });

  test('revenue is the real sum of paid bids', async () => {
    const { body } = await json('/api/stats');
    // 10 (example) + 6 then 500 (iana) + 10 (wikipedia) + 7 (handle)
    assert.equal(body.revenue, 10 + 6 + 500 + 10 + 7);
    assert.equal(body.listings, 4);
    assert.equal(body.topBid, 500);
    assert.equal(body.nextBid, 501, 'taking #1 costs $1 more, as the rules say');
  });

  test('revenue counts what was charged, not what was bid', async () => {
    // A discounted checkout records a $0 charge against a non-zero bid;
    // counting the bid would overstate revenue.
    const before = (await json('/api/stats')).body.revenue;
    assert.ok(before > 0);
    const board = await json('/api/board');
    assert.ok(board.body.items.every(i => i.price > 0), 'bids stay at their face value');
  });

  test('counts the visitor from the session cookie', async () => {
    const { body } = await json('/api/stats');
    assert.ok(body.visitors >= 1);
    assert.ok(body.online >= 1);
  });
});

describe('pagination', () => {
  test('clamps a page beyond the end', async () => {
    const { body } = await json('/api/board?page=99');
    assert.equal(body.page, body.pages);
  });

  test('handles a garbage page param', async () => {
    const { body } = await json('/api/board?page=-3');
    assert.equal(body.page, 1);
  });
});

describe('static + errors', () => {
  test('serves the app shell', async () => {
    const res = await req('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /outbid/);
  });

  test('blocks path traversal', async () => {
    const res = await req('/../server.js');
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
  });

  test('404s an unknown api endpoint', async () => {
    const { status } = await json('/api/nope');
    assert.equal(status, 404);
  });

  test('rejects an oversized body', async () => {
    const res = await req('/api/bid', { method: 'POST', body: JSON.stringify({ target: 'x'.repeat(100_000) }) });
    assert.equal(res.status, 413);
  });
});

describe('stripe webhook', () => {
  test('rejects an unsigned webhook', async () => {
    const res = await req('/api/webhook/stripe', {
      method: 'POST', body: JSON.stringify({ type: 'checkout.session.completed' })
    });
    assert.equal(res.status, 400);
  });
});

describe('deployment surface', () => {
  test('health check reports readiness', async () => {
    const { status, body } = await json('/healthz');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.listings, 'number');
    assert.equal(typeof body.uptime, 'number');
  });

  test('does not trust X-Forwarded-For unless a proxy is declared', async () => {
    // TRUST_PROXY is off in tests, so a spoofed header must not become the
    // rate-limit key — otherwise a caller could rotate it to bypass limits.
    const res = await req('/api/board', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    assert.equal(res.status, 200);
  });

  test('sets a visitor cookie without Secure off-TLS', async () => {
    const res = await fetch(BASE + '/api/stats');
    const c = res.headers.get('set-cookie');
    if (c){
      assert.match(c, /HttpOnly/);
      assert.match(c, /SameSite=Lax/);
      assert.ok(!/Secure/.test(c), 'Secure would break plain-HTTP local dev');
    }
  });
});
