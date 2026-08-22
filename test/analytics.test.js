/* Analytics injection is config-driven: verify it stays off by default and
   templates correctly when configured. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withServer(env, fn){
  const dir = mkdtempSync(join(tmpdir(), 'outbid-an-'));
  const port = 4400 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'a.db'), NODE_ENV: 'test', STRIPE_SECRET_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(base + '/api/stats'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
  try { return await fn(base); }
  finally { child.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); }
}

describe('analytics injection', () => {
  test('is absent when unconfigured, and leaves no placeholders behind', async () => {
    await withServer({}, async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.ok(!html.includes('datafa.st'), 'no tracker when unconfigured');
      assert.ok(!html.includes('<!--ANALYTICS-->'), 'placeholder consumed');
      assert.ok(!html.includes('%STATS_HREF%'), 'stats href templated');
      assert.ok(!html.includes('%STATS_TARGET%'), 'stats target templated');
      assert.ok(html.includes('href="#stats"'), 'falls back to the on-page section');
    });
  });

  test('injects the tracker and share links when configured', async () => {
    await withServer({
      DATAFAST_WEBSITE_ID: 'dfid_test123',
      DATAFAST_DOMAIN: 'example.com',
      DATAFAST_SHARE_URL: 'https://datafa.st/share/abc?period=last24h'
    }, async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /script[^>]+src="https:\/\/datafa\.st\/js\/script\.cookieless\.js"/);
      assert.match(html, /data-website-id="dfid_test123"/);
      assert.match(html, /data-domain="example\.com"/);
      assert.ok(html.includes('https://datafa.st/share/abc?period=last24h'), 'share link used');
      assert.ok(html.includes('target="_blank"'), 'share link opens in a new tab');
      assert.ok(!html.includes('%STATS'), 'no placeholders left');
    });
  });

  test('escapes a hostile website id instead of breaking out of the attribute', async () => {
    await withServer({
      DATAFAST_WEBSITE_ID: 'dfid"><script>alert(1)</script>',
      DATAFAST_DOMAIN: 'example.com'
    }, async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.ok(!html.includes('<script>alert(1)</script>'), 'no injected script tag');
      assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), 'value is escaped');
    });
  });

  test('the ETag changes when the analytics config changes', async () => {
    const a = await withServer({}, async (base) =>
      (await fetch(base + '/')).headers.get('etag'));
    const b = await withServer({ DATAFAST_WEBSITE_ID: 'dfid_x', DATAFAST_DOMAIN: 'e.com' }, async (base) =>
      (await fetch(base + '/')).headers.get('etag'));
    assert.notEqual(a, b, 'config change must bust the cached HTML');
  });
});
