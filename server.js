import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as store from './src/db.js';
import { routes, handleWebhook, subscribe, invalidate, HttpError } from './src/api.js';
import { assertPaymentsConfigured, stripeEnabled, ensureWebhookEndpoint, ensurePromotionCode } from './src/payments.js';
import { renderHtml, analyticsFingerprint, analyticsEnabled } from './src/analytics.js';

assertPaymentsConfigured();

const PORT = Number(process.env.PORT) || 4321;
/* Platforms like Render route to the container's external interface, so a
   loopback bind fails their health check. Default to loopback only locally. */
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

/* Two front-ends share this API, so a fixed PUBLIC_ORIGIN would send a
   customer back to the wrong site after paying. Use the origin the request
   actually came from — but only if it is on the allow-list, so the redirect
   target can never be attacker-controlled. */
function checkoutOrigin(req){
  const candidate = (req.headers.origin
    || (req.headers.referer ? new URL(req.headers.referer).origin : '') || '')
    .replace(/\/$/, '');
  if (candidate && ALLOWED_ORIGINS.includes(candidate)) return candidate;
  return process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
}

/* Only believe X-Forwarded-For when we know a proxy set it — otherwise a
   client could spoof its IP and walk straight past the rate limiter. */
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production';
const SECURE_COOKIES = process.env.NODE_ENV === 'production';

/* When the frontend is hosted on a different origin (e.g. Firebase Hosting)
   the API must opt that origin in explicitly. Empty = same-origin only. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);

function corsHeaders(req){
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-visitor-id',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Identifies a visitor for the online/visitor counts.
   A cross-origin frontend cannot rely on a cookie — browsers block
   third-party cookies outright — so the client sends its own id in a
   header, and the cookie is only a same-origin convenience. */
function visitorFrom(req, res){
  const fromHeader = String(req.headers['x-visitor-id'] || '');
  if (UUID_RE.test(fromHeader)) return fromHeader.toLowerCase();

  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map(c => c.trim().split('='))
      .filter(p => p[0])
  );
  let id = cookies.vid;
  if (!id || !UUID_RE.test(id)){
    id = randomUUID();
    res.setHeader('set-cookie',
      `vid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`
      + (SECURE_COOKIES ? '; Secure' : ''));
  }
  return id;
}

/* Mirrors build.js so the Node server and the static build produce the
   same markup — one source of truth for the header and footer. */
async function assemblePage(file){
  const [html, head, header, footer] = await Promise.all([
    readFile(file, 'utf8'),
    readFile(join(PUBLIC_DIR, '_head.html'), 'utf8').catch(() => ''),
    readFile(join(PUBLIC_DIR, '_header.html'), 'utf8').catch(() => ''),
    readFile(join(PUBLIC_DIR, '_footer.html'), 'utf8').catch(() => '')
  ]);
  return html
    .replace('<!--HEAD-->', head)
    .replace('<!--HEADER-->', header)
    .replace('<!--FOOTER-->', footer);
}

async function serveStatic(req, res, pathname){
  let rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');

  // Partials are build inputs, not pages.
  if (/(^|\/)_/.test(rel)) return send(res, 404, { error: 'Not found' });

  // Clean URLs: /rules serves rules.html.
  if (!extname(rel)) rel += '.html';

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

    // HTML gets the shared chrome and analytics config templated in;
    // other assets stream as-is.
    const body = isHtml
      ? Buffer.from(renderHtml(await assemblePage(file)), 'utf8')
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

  const cors = corsHeaders(req);

  try {
    /* ── CORS preflight ── */
    if (req.method === 'OPTIONS'){
      res.writeHead(cors ? 204 : 403, cors || {});
      return res.end();
    }

    /* ── Health check (platform probes hit this) ── */
    if (key === 'GET /healthz'){
      return send(res, 200, { ok: true, listings: store.boardCount(), uptime: Math.round(process.uptime()) });
    }

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
        connection: 'keep-alive',
        ...(cors || {})
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
        origin: checkoutOrigin(req),
        ip: (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim())
            || req.socket.remoteAddress,
        visitorId: visitorFrom(req, res),
        authorization: req.headers.authorization || '',
        body: {}
      };

      if (req.method === 'POST'){
        const raw = await readBody(req);
        if (raw){
          try { ctx.body = JSON.parse(raw); }
          catch { return send(res, 400, { error: 'Invalid JSON body.' }); }
        }
      }

      return send(res, 200, await handler(ctx), cors || {});
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' }, cors || {});

    /* ── Static files ── */
    if (req.method === 'GET' || req.method === 'HEAD'){
      return await serveStatic(req, res, pathname);
    }
    return send(res, 405, { error: 'Method not allowed' });

  } catch (err){
    if (err instanceof HttpError) return send(res, err.status, { error: err.message }, cors || {});
    console.error(`[error] ${key}:`, err);
    return send(res, 500, { error: 'Something went wrong on our end.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`outbid listening on http://${HOST}:${PORT}`);
  console.log(`payments: ${stripeEnabled ? 'stripe (live checkout)' : 'DEV MODE — bids confirm without payment'}`);
  console.log(`env: ${process.env.NODE_ENV || 'development'} | trust proxy: ${TRUST_PROXY}`);
  console.log(`cors: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'same-origin only'}`);
  console.log(`analytics: ${analyticsEnabled ? 'datafast enabled' : 'disabled (set DATAFAST_WEBSITE_ID + DATAFAST_DOMAIN)'}`);
  console.log(`listings on board: ${store.boardCount()}`);
  registerWebhook();
  registerLaunchPromo();
});

/* Register the Stripe webhook on boot, so a deploy is self-sufficient and
   nobody has to copy a signing secret out of the dashboard.
   Render exposes its own public URL as RENDER_EXTERNAL_URL. */
const API_ORIGIN = process.env.PUBLIC_API_ORIGIN || process.env.RENDER_EXTERNAL_URL || '';

async function registerWebhook(){
  if (!stripeEnabled) return;
  try {
    const result = await ensureWebhookEndpoint(API_ORIGIN);
    if (result.status === 'created' && result.secret){
      store.setMeta('stripe_webhook_secret', result.secret);
      console.log(`webhook: created ${result.url} and stored its signing secret`);
    } else if (result.status === 'exists'){
      const held = store.getMeta('stripe_webhook_secret') || process.env.STRIPE_WEBHOOK_SECRET;
      console.log(held
        ? `webhook: already registered at ${result.url}`
        : `webhook: endpoint ${result.url} exists but its secret is unknown — `
          + `delete it in Stripe and redeploy, or set STRIPE_WEBHOOK_SECRET`);
    } else {
      console.log(`webhook: not registered (${result.reason})`);
    }
  } catch (err){
    // Never block startup on this — payments still settle via the success
    // redirect, and the webhook can be registered by hand.
    console.error(`webhook: registration failed — ${err.message}`);
  }
}

/* The launch promotion. Stripe enforces the 100-redemption limit and shows
   the code field inside Checkout, so nothing here has to be trusted. */
async function registerLaunchPromo(){
  if (!stripeEnabled) return;
  const code = process.env.LAUNCH_PROMO_CODE || 'HACKATHON';
  const max = Number(process.env.LAUNCH_PROMO_MAX) || 100;
  try {
    const r = await ensurePromotionCode({ code, maxRedemptions: max });
    if (r.status === 'created') console.log(`promo: created ${r.code} — ${r.max} redemptions`);
    else if (r.status === 'exists') console.log(`promo: ${r.code} exists — ${r.redeemed}/${r.max} used`);
  } catch (err){
    console.error(`promo: setup failed — ${err.message}`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']){
  process.on(sig, () => { server.close(() => process.exit(0)); });
}

export { server };
