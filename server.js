import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as store from './src/db.js';
import { routes, handleWebhook, subscribe, invalidate, HttpError } from './src/api.js';
import { assertPaymentsConfigured, stripeEnabled } from './src/payments.js';
import { renderHtml, analyticsFingerprint, analyticsEnabled } from './src/analytics.js';

assertPaymentsConfigured();

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req){
  // Trust content-length when present so an oversized upload is refused before
  // a single byte is buffered.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES){
    return Promise.reject(new HttpError(413, 'Request body too large.'));
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES){
        // Keep draining rather than destroying the socket — the client has to
        // finish sending before it will read our 413.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflowed) reject(new HttpError(413, 'Request body too large.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, headers = {}){
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

/* A visitor id in a cookie is what makes the online/visitor counts real. */
function visitorFrom(req, res){
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map(c => c.trim().split('='))
      .filter(p => p[0])
  );
  let id = cookies.vid;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)){
    id = randomUUID();
    res.setHeader('set-cookie',
      `vid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  }
  return id;
}

async function serveStatic(req, res, pathname){
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);

  if (!file.startsWith(PUBLIC_DIR)){
    return send(res, 403, { error: 'Forbidden' });
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');

    /* Revalidate rather than cache blindly: a deploy changes mtime/size, so
       the ETag changes and clients pick up new CSS/JS immediately, while
       unchanged assets still cost only a 304. */
    const isHtml = extname(file) === '.html';
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(36)}`
               + `${isHtml ? '-' + analyticsFingerprint : ''}"`;
    if (req.headers['if-none-match'] === etag){
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      return res.end();
    }

    // HTML gets the analytics config templated in; other assets stream as-is.
    const body = isHtml
      ? Buffer.from(renderHtml(await readFile(file, 'utf8')), 'utf8')
      : await readFile(file);

    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      etag
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const key = `${req.method} ${pathname}`;

  try {
    /* ── Click-through tracking ── */
    if (req.method === 'GET' && pathname.startsWith('/r/')){
      const id = Number(pathname.slice(3));
      const listing = Number.isInteger(id) ? store.getListing(id) : null;
      if (!listing){
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Unknown listing');
      }
      store.recordClick(listing.id);
      invalidate();
      res.writeHead(302, { location: listing.url, 'cache-control': 'no-store' });
      return res.end();
    }

    /* ── Server-sent events ── */
    if (key === 'GET /api/events'){
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('retry: 3000\n\n');
      const unsubscribe = subscribe(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); unsubscribe(); });
      return;
    }

    /* ── Stripe webhook (raw body required for signature check) ── */
    if (key === 'POST /api/webhook/stripe'){
      const raw = await readBody(req);
      try {
        return send(res, 200, handleWebhook(raw, req.headers['stripe-signature']));
      } catch (err){
        return send(res, 400, { error: err.message });
      }
    }

    /* ── JSON API ── */
    const handler = routes[key];
    if (handler){
      const ctx = {
        query: url.searchParams,
        origin: process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`,
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
        visitorId: visitorFrom(req, res),
        body: {}
      };

      if (req.method === 'POST'){
        const raw = await readBody(req);
        if (raw){
          try { ctx.body = JSON.parse(raw); }
          catch { return send(res, 400, { error: 'Invalid JSON body.' }); }
        }
      }

      return send(res, 200, await handler(ctx));
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });

    /* ── Static files ── */
    if (req.method === 'GET' || req.method === 'HEAD'){
      return await serveStatic(req, res, pathname);
    }
    return send(res, 405, { error: 'Method not allowed' });

  } catch (err){
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(`[error] ${key}:`, err);
    return send(res, 500, { error: 'Something went wrong on our end.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`outbid listening on http://${HOST}:${PORT}`);
  console.log(`payments: ${stripeEnabled ? 'stripe (live checkout)' : 'DEV MODE — bids confirm without payment'}`);
  console.log(`analytics: ${analyticsEnabled ? 'datafast enabled' : 'disabled (set DATAFAST_WEBSITE_ID + DATAFAST_DOMAIN)'}`);
  console.log(`listings on board: ${store.boardCount()}`);
});

for (const sig of ['SIGINT', 'SIGTERM']){
  process.on(sig, () => { server.close(() => process.exit(0)); });
}

export { server };
