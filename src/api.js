import { randomUUID } from 'node:crypto';
import * as store from './db.js';
import { parseTarget, fetchMetadata, InputError } from './metadata.js';
import { timingSafeEqual } from 'node:crypto';
import {
  stripeEnabled, createCheckoutSession, retrieveSession, verifyWebhook,
  extractPaymentDetails
} from './payments.js';

export const MIN_BID_CENTS = 500;          // $5 floor
export const MAX_BID_CENTS = 100_000_00;   // $100k ceiling
export const PER_PAGE = 50;

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

/* ── Serialization ────────────────────────────────────────────── */
function listingView(row, rank){
  return {
    id: row.id,
    rank,
    target: row.target,
    title: row.title,
    description: row.description,
    icon: row.icon_url,
    price: row.amount_cents / 100,
    claimPrice: row.amount_cents / 100 + 1,
    clicks: row.clicks,
    since: row.paid_at
  };
}

/* ── Rate limiting ────────────────────────────────────────────── */
/* Metadata lookups make an outbound request, so they get their own budget. */
const buckets = new Map();
function rateLimit(key, max, windowMs){
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 600_000;
  for (const [k, v] of buckets){
    const kept = v.filter(t => t > cutoff);
    if (kept.length) buckets.set(k, kept); else buckets.delete(k);
  }
}, 300_000).unref();

/* ── Micro-cache ──────────────────────────────────────────────────
   The board is read far more than it is written. A sub-second TTL keeps
   the page effectively live while collapsing a burst of concurrent
   readers into one SQLite query. Any bid or click clears it. */
const CACHE_TTL_MS = 1000;
const cache = new Map();

function cached(key, produce){
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = produce();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidate(){ cache.clear(); }

/* ── Live updates ─────────────────────────────────────────────── */
const subscribers = new Set();

export function subscribe(res){
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function broadcast(event, data){
  invalidate();
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers){
    try { res.write(frame); } catch { subscribers.delete(res); }
  }
}

/* ── Admin auth ───────────────────────────────────────────────── */
/* A bearer token compared in constant time. Without ADMIN_TOKEN set, the
   endpoint is closed rather than open — failing shut, not open. */
function requireAdmin(ctx){
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected){
    throw new HttpError(503, 'Admin access is not configured.');
  }
  const provided = (ctx.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)){
    throw new HttpError(401, 'Unauthorized.');
  }
}

/* ── Amount validation ────────────────────────────────────────── */
function parseAmount(raw){
  const dollars = Number(raw);
  if (!Number.isFinite(dollars)) throw new HttpError(400, 'Enter a bid amount.');
  const cents = Math.round(dollars * 100);
  if (cents < MIN_BID_CENTS){
    throw new HttpError(400, `The minimum bid is $${MIN_BID_CENTS / 100}.`);
  }
  if (cents > MAX_BID_CENTS){
    throw new HttpError(400, `The maximum bid is $${(MAX_BID_CENTS / 100).toLocaleString()}.`);
  }
  return cents;
}

/* ── Handlers ─────────────────────────────────────────────────── */
function buildBoard(page){
  const total = store.boardCount();
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const offset = (Math.min(page, pages) - 1) * PER_PAGE;
  const rows = store.boardPage(PER_PAGE, offset);

  return {
    page: Math.min(page, pages),
    pages,
    total,
    perPage: PER_PAGE,
    items: rows.map((row, i) => listingView(row, offset + i + 1))
  };
}

export const routes = {

  'GET /api/board': (ctx) => {
    const page = Math.max(1, Number(ctx.query.get('page')) || 1);
    return cached(`board:${page}`, () => buildBoard(page));
  },

  'GET /api/trending': () => cached('trending', () => ({
    items: store.trending().map(r => ({
      id: r.id, target: r.target, title: r.title, icon: r.icon_url, perHour: r.hits
    }))
  })),

  'GET /api/activity': () => cached('activity', () => ({
    items: store.recentActivity().map(r => ({
      id: r.id,
      target: r.target,
      icon: r.icon_url,
      price: r.amount_cents / 100,
      rank: store.listingRank(r.id),
      at: r.paid_at
    }))
  })),

  'GET /api/stats': (ctx) => {
    store.touchVisitor(ctx.visitorId);
    const { total, online } = store.visitorStats();
    const top = store.topAmount();
    return {
      online,
      visitors: total,
      revenue: store.revenueCents() / 100,
      launchedAt: store.launchedAt,
      topBid: top / 100,
      nextBid: top ? top / 100 + 5 : MIN_BID_CENTS / 100,
      minBid: MIN_BID_CENTS / 100,
      listings: store.boardCount(),
      payments: stripeEnabled ? 'stripe' : 'dev'
    };
  },

  /* Transaction ledger. Contains customer emails, so it is never public. */
  'GET /api/admin/transactions': (ctx) => {
    requireAdmin(ctx);
    return {
      total: store.transactionCount(),
      items: store.transactions({
        limit: Math.min(500, Number(ctx.query.get('limit')) || 100),
        offset: Math.max(0, Number(ctx.query.get('offset')) || 0),
        email: ctx.query.get('email') || null
      }).map(t => ({
        id: t.id,
        status: t.status,
        provider: t.provider,
        target: t.target,
        bid: t.amount_cents / 100,
        charged: t.amount_paid_cents == null ? null : t.amount_paid_cents / 100,
        currency: t.currency,
        email: t.customer_email,
        name: t.customer_name,
        card: t.card_brand && t.card_last4 ? `${t.card_brand} ****${t.card_last4}` : null,
        country: t.country,
        stripeCustomer: t.stripe_customer_id,
        paymentIntent: t.payment_intent,
        receipt: t.receipt_url,
        createdAt: t.created_at,
        paidAt: t.paid_at
      }))
    };
  },

  /* Resolve a URL/@handle into a real listing preview + the rank a bid takes. */
  'POST /api/preview': async (ctx) => {
    if (!rateLimit(`preview:${ctx.ip}`, 20, 60_000)){
      throw new HttpError(429, 'Too many lookups. Give it a minute.');
    }

    let parsed;
    try { parsed = parseTarget(ctx.body.target); }
    catch (e){
      if (e instanceof InputError) throw new HttpError(400, e.message);
      throw e;
    }

    const meta = await fetchMetadata(parsed);
    const existing = store.findListing(parsed.target);
    const current = existing ? store.highestPaidBid(existing.id) : 0;

    const result = {
      target: parsed.target,
      kind: parsed.kind,
      url: parsed.url,
      title: meta.title,
      description: meta.description,
      icon: meta.iconUrl,
      alreadyListed: Boolean(current),
      currentPrice: current / 100,
      minimum: (current ? current + 100 : MIN_BID_CENTS) / 100
    };

    if (ctx.body.amount !== undefined && ctx.body.amount !== ''){
      const cents = parseAmount(ctx.body.amount);
      result.amount = cents / 100;
      result.rank = store.rankForAmount(cents, existing?.id ?? null);
      result.beatsCurrent = cents > current;
    }
    return result;
  },

  /* Start a real checkout. The bid row is created up front as `pending`
     and only becomes `paid` when Stripe confirms it. */
  'POST /api/bid': async (ctx) => {
    if (!rateLimit(`bid:${ctx.ip}`, 10, 60_000)){
      throw new HttpError(429, 'Too many attempts. Give it a minute.');
    }

    let parsed;
    try { parsed = parseTarget(ctx.body.target); }
    catch (e){
      if (e instanceof InputError) throw new HttpError(400, e.message);
      throw e;
    }

    const cents = parseAmount(ctx.body.amount);
    const existing = store.findListing(parsed.target);
    const current = existing ? store.highestPaidBid(existing.id) : 0;

    if (current && cents <= current){
      throw new HttpError(409,
        `${parsed.target} is already on the board at $${(current / 100).toLocaleString()}. ` +
        `Bid more than that to raise it.`);
    }

    const meta = await fetchMetadata(parsed);
    const listing = store.upsertListing({
      kind: parsed.kind,
      target: parsed.target,
      url: parsed.url,
      title: meta.title,
      description: meta.description,
      iconUrl: meta.iconUrl
    });

    const rank = store.rankForAmount(cents, listing.id);
    const bidRef = randomUUID();

    if (!stripeEnabled){
      // Dev mode: confirm immediately so the flow is exercisable without keys.
      store.createBid({
        listingId: listing.id, amountCents: cents,
        status: 'paid', sessionId: `dev_${bidRef}`, provider: 'dev'
      });
      broadcast('board', { reason: 'bid', target: listing.target, rank });
      return { status: 'confirmed', rank, target: listing.target, amount: cents / 100 };
    }

    const session = await createCheckoutSession({
      listing, amountCents: cents, rank, origin: ctx.origin, bidRef
    });
    store.createBid({
      listingId: listing.id, amountCents: cents,
      status: 'pending', sessionId: session.id
    });

    return { status: 'checkout', checkoutUrl: session.url, rank, target: listing.target };
  },

  /* Stripe redirects here on success. Confirming from the session (as well as
     the webhook) means the board updates immediately, even if the webhook is
     slow — markBidPaid is idempotent, so both paths are safe. */
  'POST /api/confirm': async (ctx) => {
    const sessionId = String(ctx.body.sessionId || '');
    if (!sessionId) throw new HttpError(400, 'Missing session id.');
    if (!stripeEnabled) throw new HttpError(400, 'Stripe is not configured.');

    const session = await retrieveSession(sessionId);
    if (!session) throw new HttpError(404, 'Unknown checkout session.');
    if (session.payment_status !== 'paid'){
      return { status: session.payment_status || 'unpaid' };
    }

    const bid = store.markBidPaid(sessionId);
    if (!bid) throw new HttpError(404, 'No bid for that session.');

    store.attachPaymentDetails(sessionId, extractPaymentDetails(session));

    const rank = store.listingRank(bid.listing_id);
    broadcast('board', { reason: 'paid', rank });
    return { status: 'confirmed', rank, amount: bid.amount_cents / 100 };
  }
};

/* Webhook is handled outside `routes` because it needs the raw body. */
export function handleWebhook(rawBody, signature){
  const event = verifyWebhook(rawBody, signature);

  if (event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'){
    const session = event.data.object;
    if (session.payment_status === 'paid'){
      const bid = store.markBidPaid(session.id);

      /* The webhook payload is unexpanded, so it carries the email and
         totals but not the charge. Record those now; the success redirect
         fills in the receipt and card, and COALESCE keeps both. */
      store.attachPaymentDetails(session.id, extractPaymentDetails(session));

      if (bid) broadcast('board', { reason: 'webhook' });
    }
  }
  return { received: true };
}

export { HttpError };
