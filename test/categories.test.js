/* Category assignment and the category pages. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, CATEGORIES, CATEGORY_BY_SLUG } from '../src/categories.js';

const c = (target, title, description, kind = 'url') =>
  classify({ target, kind, title, description });

describe('classifier', () => {
  test('files well-known products correctly', () => {
    assert.equal(c('stripe.com', 'Stripe', 'Accept payments and build billing models.'), 'finance');
    assert.equal(c('github.com', 'GitHub', 'The developer platform to build software.'), 'dev-tools');
    assert.equal(c('ahrefs.com', 'Ahrefs', 'All-in-one SEO toolset with backlink research.'), 'seo');
    assert.equal(c('shopify.com', 'Shopify', 'Grow your ecommerce store with checkout.'), 'ecommerce');
    assert.equal(c('coinbase.com', 'Coinbase', 'Buy crypto. Wallet for bitcoin.'), 'crypto');
  });

  test('does not match a keyword inside a longer word', () => {
    // "stripe" contains "trip"; "important" contains "map"; "leads" contains "lead"
    // but "pleaded" should not.
    assert.notEqual(c('stripe.com', 'Stripe', 'Financial services platform.'), 'travel');
    assert.notEqual(c('example.com', 'Example', 'This is important to us.'), 'travel');
    assert.notEqual(c('example.com', 'Example', 'He pleaded his case.'), 'sales');
  });

  test('tolerates plurals', () => {
    assert.equal(c('x.com', 'Pay', 'We handle payments and invoices.'), 'finance');
    assert.equal(c('y.com', 'Dev', 'Built for developers with APIs and SDKs.'), 'dev-tools');
  });

  test('weights the domain over the description', () => {
    assert.equal(c('seo.com', 'Untitled', 'A website about things.'), 'seo');
  });

  test('an @handle is always a profile, whatever the bio says', () => {
    assert.equal(c('@someone', '@someone', 'I build SEO tools for crypto', 'handle'), 'profiles');
  });

  test('falls back to other rather than guessing on weak evidence', () => {
    assert.equal(c('random.xyz', 'Random', 'Just a thing.'), 'other');
    assert.equal(c('nothing.com', '', ''), 'other');
  });

  test('every category slug is unique and resolvable', () => {
    const slugs = CATEGORIES.map(x => x.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
    for (const s of slugs) assert.ok(CATEGORY_BY_SLUG.get(s).name);
  });
});

/* ── Pages + filtering ───────────────────────────────── */
const PORT = 4366;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'cat-admin-token';
const dir = mkdtempSync(join(tmpdir(), 'outbid-cat-'));
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'c.db'),
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

describe('category pages', () => {
  test('serves rules, about and categories on clean URLs', async () => {
    for (const [path, expected] of [['/rules', 'Rules'], ['/about', 'About'], ['/categories', 'Categories']]){
      const res = await fetch(BASE + path);
      assert.equal(res.status, 200, `${path} should serve`);
      const html = await res.text();
      assert.match(html, new RegExp(`<title>${expected}`));
      assert.match(html, /site-header/, 'shared header was templated in');
      assert.ok(!html.includes('<!--HEADER-->'), 'no unreplaced placeholder');
      assert.ok(!html.includes('<!--HEAD-->'), 'no unreplaced placeholder');
      assert.ok(!html.includes('%STATS_HREF%'), 'no unreplaced placeholder');
    }
  });

  test('never serves the build partials', async () => {
    for (const p of ['/_header.html', '/_head.html', '/_footer.html']){
      assert.equal((await fetch(BASE + p)).status, 404, `${p} must not be public`);
    }
  });

  test('lists every category, including empty ones', async () => {
    const body = await (await fetch(BASE + '/api/categories')).json();
    assert.equal(body.items.length, CATEGORIES.length);
    assert.ok(body.items.every(i => i.listings === 0));
  });

  test('a bid lands in a category and shows up in the counts', async () => {
    await fetch(BASE + '/api/bid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'github.com', amount: 30 })
    });

    const board = await (await fetch(BASE + '/api/board')).json();
    assert.equal(board.items[0].category, 'dev-tools');
    assert.equal(board.items[0].categoryName, 'Developer Tools');

    const cats = await (await fetch(BASE + '/api/categories')).json();
    assert.equal(cats.items.find(i => i.slug === 'dev-tools').listings, 1);
    assert.equal(cats.items.find(i => i.slug === 'dev-tools').topBid, 30);
  });

  test('filters the board by category', async () => {
    const hit = await (await fetch(BASE + '/api/board?category=dev-tools')).json();
    assert.equal(hit.total, 1);
    assert.equal(hit.categoryName, 'Developer Tools');

    const miss = await (await fetch(BASE + '/api/board?category=crypto')).json();
    assert.equal(miss.total, 0);
  });

  test('an unknown category returns nothing, not everything', async () => {
    const res = await (await fetch(BASE + '/api/board?category=made-up')).json();
    assert.equal(res.total, 0, 'a bad slug must not fall back to the full board');
  });

  test('admin can move a listing, and it does not change rank or bid', async () => {
    const before = await (await fetch(BASE + '/api/board')).json();

    const res = await fetch(BASE + '/api/admin/category', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ target: 'github.com', category: 'infrastructure' })
    });
    assert.equal(res.status, 200);

    const after = await (await fetch(BASE + '/api/board')).json();
    assert.equal(after.items[0].category, 'infrastructure');
    assert.equal(after.items[0].rank, before.items[0].rank);
    assert.equal(after.items[0].price, before.items[0].price);
  });

  test('rejects an unknown category and an unauthorized caller', async () => {
    const bad = await fetch(BASE + '/api/admin/category', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ target: 'github.com', category: 'not-real' })
    });
    assert.equal(bad.status, 400);

    const unauth = await fetch(BASE + '/api/admin/category', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'github.com', category: 'crypto' })
    });
    assert.equal(unauth.status, 401);
  });
});
