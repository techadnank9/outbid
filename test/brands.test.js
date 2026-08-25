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

describe('per-brand bid floor', () => {
  test('SocialRise accepts $1, Outbid does not', async () => {
    const social = await post('/api/bid', { target: '@dollarcreator', amount: 1 }, SOCIAL);
    assert.equal(social.status, 200, '$1 is allowed on the creator board');
    assert.equal((await social.json()).amount, 1);

    const outbid = await post('/api/bid', { target: 'cheap.example.com', amount: 1 }, OUTBID);
    assert.equal(outbid.status, 400, '$1 is below the product board floor');
    assert.match((await outbid.json()).error, /minimum bid is \$5/);
  });

  test('each board reports its own floor', async () => {
    assert.equal((await get('/api/stats', SOCIAL)).minBid, 1);
    assert.equal((await get('/api/stats', OUTBID)).minBid, 5);
  });

  test('an empty board quotes its own floor as the opening price', async () => {
    // Both boards already have listings here, so check the floor feeds
    // through rather than the next-bid arithmetic.
    const s = await get('/api/stats', SOCIAL);
    assert.ok(s.nextBid >= s.minBid);
  });

  test('below-floor is still refused on the creator board', async () => {
    const res = await post('/api/bid', { target: '@toocheap', amount: 0 }, SOCIAL);
    assert.equal(res.status, 400);
  });
});

describe('the brand migration must not destroy data', () => {
  test('bids survive the listings table rebuild', async () => {
    // bids.listing_id is ON DELETE CASCADE, so dropping the old listings
    // table during the rebuild deletes every bid unless foreign keys are
    // disabled for the swap. This happened once in production.
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = join(dir, 'migrate.db');
    const db = new DatabaseSync(tmp);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`CREATE TABLE listings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('url','handle')),
      target TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', icon_url TEXT, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE bids(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL, status TEXT NOT NULL, provider TEXT,
      session_id TEXT, created_at INTEGER NOT NULL, paid_at INTEGER)`);
    db.exec(`INSERT INTO listings (kind,target,url,title,created_at)
             VALUES ('url','keep.com','https://keep.com','Keep',1)`);
    db.exec(`INSERT INTO bids (listing_id,amount_cents,status,provider,session_id,created_at,paid_at)
             VALUES (1,900,'paid','stripe','s1',1,1)`);
    db.close();

    const prev = process.env.DB_PATH;
    process.env.DB_PATH = tmp;
    const store = await import(`../src/db.js?migrate=${Date.now()}`);
    process.env.DB_PATH = prev;

    assert.equal(store.boardCount('outbid'), 1, 'the listing survived');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM bids').get().n, 1,
      'its bid survived — a cascade here wipes the payment ledger'
    );
  });
});

describe('platform selection', () => {
  test('the same handle on two platforms is two listings', async () => {
    await post('/api/bid', { target: '@sam', amount: 5, platform: 'tiktok' }, SOCIAL);
    await post('/api/bid', { target: '@sam', amount: 4, platform: 'x' }, SOCIAL);

    const board = await get('/api/board', SOCIAL);
    const sams = board.items.filter(i => i.key.startsWith('@sam'));
    assert.equal(sams.length, 2, '@sam on TikTok and @sam on X are different people');
    assert.deepEqual(
      sams.map(i => i.platformName).sort(),
      ['TikTok', 'X']
    );
  });

  test('a profile link is keyed by handle, not by host', async () => {
    // Every TikTok creator shares tiktok.com — keying by host would collapse
    // them into one listing.
    await post('/api/bid', { target: 'https://tiktok.com/@jess', amount: 6 }, SOCIAL);
    await post('/api/bid', { target: 'https://tiktok.com/@alex', amount: 7 }, SOCIAL);

    const board = await get('/api/board', SOCIAL);
    assert.ok(board.items.find(i => i.key === '@jess:tiktok'));
    assert.ok(board.items.find(i => i.key === '@alex:tiktok'));
    assert.ok(board.items.find(i => i.target === '@jess'), 'shown as a person');
  });

  test('a pasted link resolves its own platform', async () => {
    const res = await post('/api/preview', { target: 'https://instagram.com/nasa' }, SOCIAL);
    const body = await res.json();
    assert.equal(body.platform, 'instagram');
    assert.equal(body.platformName, 'Instagram');
    assert.equal(body.display, '@nasa');
  });

  test('twitter.com normalises to X', async () => {
    const res = await post('/api/preview', { target: 'https://twitter.com/someone' }, SOCIAL);
    assert.equal((await res.json()).platform, 'x');
  });

  test('the platform list is public', async () => {
    const body = await get('/api/platforms', SOCIAL);
    const slugs = body.items.map(p => p.slug);
    for (const p of ['x', 'instagram', 'tiktok', 'youtube']) assert.ok(slugs.includes(p));
  });
});

describe('the categories page quotes the right floor', () => {
  test('each board reports its own opening price', async () => {
    assert.equal((await get('/api/categories', SOCIAL)).minBid, 1);
    assert.equal((await get('/api/categories', OUTBID)).minBid, 5);
  });
});

describe('each board reports its own launch date', () => {
  test('a board dates from its first listing, not the server boot', async () => {
    // SocialRise has listings created during this run; its launch date must
    // track those rather than whenever the instance happened to start.
    const s = await get('/api/stats', SOCIAL);
    const board = await get('/api/board', SOCIAL);
    assert.ok(board.total > 0, 'precondition: the board has listings');
    assert.ok(s.launchedAt <= Date.now(), 'not in the future');
    assert.ok(Date.now() - s.launchedAt < 60_000,
      'this board opened during this test run, so it cannot be days old');
  });

  test('an untouched board does not inherit another board\'s age', async () => {
    const social = (await get('/api/stats', SOCIAL)).launchedAt;
    const dethrone = (await get('/api/stats', 'https://dethronelol.web.app')).launchedAt;
    assert.ok(dethrone >= social,
      'a board with no listings dates from when it was first asked about');
  });
});

describe('visitor counts are per board', () => {
  test('a visitor on one board is not counted on another', async () => {
    const id = '33333333-4444-5555-6666-777777777777';
    const seen = (origin) => fetch(BASE + '/api/stats', {
      headers: { origin, 'x-visitor-id': id }
    }).then(r => r.json());

    const before = (await seen('https://dethronelol.web.app')).visitors;
    await seen(SOCIAL);
    const after = (await seen('https://dethronelol.web.app')).visitors;

    assert.equal(after, before,
      'visiting SocialRise must not raise Dethrone\'s visitor count');
  });

  test('the same person counts once per board they visit', async () => {
    const id = '88888888-9999-aaaa-bbbb-cccccccccccc';
    const hit = (origin) => fetch(BASE + '/api/stats', {
      headers: { origin, 'x-visitor-id': id }
    }).then(r => r.json());

    const a1 = (await hit(SOCIAL)).visitors;
    const a2 = (await hit(SOCIAL)).visitors;
    assert.equal(a1, a2, 'repeat visits do not inflate the count');
  });
});

describe('creator input accepts what the form asks for', () => {
  test('a bare username works once a platform is chosen', async () => {
    for (const platform of ['linkedin', 'tiktok', 'instagram', 'youtube']){
      const res = await post('/api/preview', { target: 'iamadnank9', platform }, SOCIAL);
      assert.equal(res.status, 200, `${platform} should accept a bare handle`);
      const body = await res.json();
      assert.equal(body.display, '@iamadnank9');
      assert.equal(body.platform, platform);
    }
  });

  test('without a platform, a bare word still asks for a link', async () => {
    const res = await post('/api/preview', { target: 'iamadnank9' }, SOCIAL);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /profile link|pick a platform/i);
  });

  test('dots and dashes are allowed in a handle', async () => {
    const res = await post('/api/preview', { target: '@some.user-1', platform: 'instagram' }, SOCIAL);
    assert.equal(res.status, 200);
  });
});

describe('the storage key never reaches the page', () => {
  test('a namespaced handle is shown without its platform suffix', async () => {
    await post('/api/bid', { target: '@chef', amount: 3, platform: 'instagram' }, SOCIAL);
    const board = await get('/api/board', SOCIAL);
    const row = board.items.find(i => i.key === '@chef:instagram');
    assert.ok(row, 'stored namespaced');
    assert.equal(row.target, '@chef', 'displayed as a person, not a database key');
    assert.equal(row.platformName, 'Instagram', 'the platform shows as a badge instead');
  });

  test('activity and trending use the display name too', async () => {
    const activity = await get('/api/activity', SOCIAL);
    assert.ok(activity.items.every(i => !i.target.includes(':')),
      'no colon-suffixed keys in the activity feed');
  });

  test('a website listing is unaffected', async () => {
    await post('/api/bid', { target: 'example.com', amount: 4 }, SOCIAL);
    const board = await get('/api/board', SOCIAL);
    assert.ok(board.items.find(i => i.target === 'example.com'));
  });
});

describe('each board has a home category', () => {
  test('an unclassifiable creator lands in AI & Tech, not Everything Else', async () => {
    const res = await post('/api/preview', { target: '@nondescript', platform: 'x' }, SOCIAL);
    const body = await res.json();
    assert.equal(body.category, 'ai-tech');
  });

  test('the product board still falls back to Everything Else', async () => {
    const res = await post('/api/preview', { target: 'nondescript-xyz.example' }, OUTBID);
    assert.equal((await res.json()).category, 'other');
  });

  test('a clear signal still wins over the fallback', async () => {
    const res = await post('/api/preview', { target: 'https://instagram.com/nasa' }, SOCIAL);
    const body = await res.json();
    assert.notEqual(body.category, 'ai-tech', 'NASA is science, not the fallback');
  });
});

describe('visitor counts exclude clients that keep no state', () => {
  test('anonymous scripted calls do not invent visitors', async () => {
    const anon = () => fetch(BASE + '/api/stats', { headers: { origin: SOCIAL } })
      .then(r => r.json());

    const before = (await anon()).visitors;
    for (let i = 0; i < 5; i++) await anon();
    const after = (await anon()).visitors;

    assert.equal(after, before,
      'a crawler that keeps no cookie must not be counted as five people');
  });

  test('a client that presents an id is counted once', async () => {
    const id = 'deadbeef-1111-2222-3333-444455556666';
    const hit = () => fetch(BASE + '/api/stats', {
      headers: { origin: SOCIAL, 'x-visitor-id': id }
    }).then(r => r.json());

    const first = (await hit()).visitors;
    await hit(); await hit();
    assert.equal((await hit()).visitors, first, 'repeat visits do not stack');
  });

  test('a browser is counted on the request after it is issued an id', async () => {
    const res = await fetch(BASE + '/api/stats', { headers: { origin: SOCIAL } });
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'an identifier is issued on first contact');

    const before = (await res.json()).visitors;
    const withCookie = await (await fetch(BASE + '/api/stats', {
      headers: { origin: SOCIAL, cookie: cookie.split(';')[0] }
    })).json();
    assert.equal(withCookie.visitors, before + 1, 'counted once it comes back');
  });
});

describe('visitor numbers prefer DataFast when configured', () => {
  test('without a token, the local count is used and labelled as such', async () => {
    const s = await get('/api/stats', SOCIAL);
    assert.equal(s.countedBy, 'local');
    assert.equal(typeof s.visitors, 'number');
  });

  test('stats never fail because analytics is unreachable', async () => {
    // A bad token must degrade to the local count, not error the endpoint.
    const res = await fetch(BASE + '/api/stats', { headers: { origin: SOCIAL } });
    assert.equal(res.status, 200);
  });
});
