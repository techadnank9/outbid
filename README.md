# outbid

A pay-to-rank leaderboard, in the shape of [outbid.lol](https://outbid.lol). Real bids, real
Stripe checkout, real metadata scraping, real click tracking. No seed data and no mock objects —
the board starts empty and fills up with whatever people actually pay for.

Node 22+ and zero npm dependencies (SQLite comes from `node:sqlite`).

## Run it

```bash
npm start
```

Then open http://localhost:4321. Without `STRIPE_SECRET_KEY` the server starts in **dev payments
mode**, where a bid confirms immediately instead of going through Stripe, so you can exercise the
whole flow locally. A banner on the page says so. Setting `NODE_ENV=production` without a Stripe
key makes the server refuse to start, so dev mode can never reach production by accident.

```bash
npm test     # 31 integration tests against a real server + real SQLite
```

## How it works

```
server.js         HTTP, routing, static files, click redirects, SSE
src/db.js         schema, migrations, every query
src/metadata.js   URL/@handle parsing, SSRF guard, live page scraping
src/payments.js   Stripe Checkout over the REST API + webhook verification
src/api.js        handlers, validation, rate limiting, response cache
public/           the frontend
```

**Ranking.** A listing's price is its highest *paid* bid. Ties break by who got there first, so an
equal bid never displaces a sitting listing — you have to actually outbid. One listing per
hostname: `example.com/pricing` and `www.example.com` are the same listing, and re-bidding raises
your existing entry instead of creating a duplicate.

**Scraping.** When a URL is entered, the server fetches the page and extracts its OpenGraph or
`<title>` title, description, and icon. If the exact URL 404s it retries the site root. Unreachable
sites still get listed, just without the copy. Responses are capped at 512KB with an 8s timeout,
and private/loopback/link-local hosts are refused so the scraper can't be pointed at internal
infrastructure.

**Clicks.** Every listing links through `/r/:id`, which records the click and 302s to the target.
That count feeds both the per-listing total and the trending panel (clicks in the last hour).

**Payments.** `POST /api/bid` creates a `pending` bid and a Stripe Checkout session. The bid becomes
`paid` only on confirmation — via the signed webhook, or via the success redirect, whichever lands
first. Both paths are idempotent. Webhook signatures are verified with HMAC-SHA256 and a constant
-time compare, with a 5-minute replay window.

**Live updates.** Server-sent events push a board refresh the moment a bid clears.

## Analytics (DataFast)

outbid.lol uses [DataFast](https://datafa.st) — cookieless, no consent banner — and this does too.
It stays inert until you point it at your own property:

```bash
export DATAFAST_WEBSITE_ID=dfid_...        # from your DataFast dashboard
export DATAFAST_DOMAIN=your-domain.com
export DATAFAST_SHARE_URL=https://datafa.st/share/...   # optional public dashboard
```

The tracker tag is templated into the HTML at serve time (it reads its config off data attributes,
so it must be real markup). With `DATAFAST_SHARE_URL` set, the "see stats" and "Live stats" links
point at your public dashboard, the way outbid.lol's do.

Two goals fire through `window.datafast()`: `checkout_started` when a bid reaches Stripe, and
`bid_confirmed` when payment settles. DataFast also has a native Stripe integration — connect it in
their dashboard to attribute revenue back to traffic source, no code needed.

Never hardcode a website id: traffic would report into someone else's dashboard.

## Going live

```bash
export STRIPE_SECRET_KEY=sk_live_...      # from your own Stripe dashboard
export STRIPE_WEBHOOK_SECRET=whsec_...    # from the webhook endpoint you create
export PUBLIC_ORIGIN=https://your-domain
export NODE_ENV=production
npm start
```

Point a Stripe webhook at `https://your-domain/api/webhook/stripe` for the
`checkout.session.completed` event.

Run it behind a TLS-terminating reverse proxy, under a process manager, and back up `data/outbid.db`.

## Measured performance

Against 5,010 listings and 47,000 clicks on one laptop core, 50 concurrent connections:

| | throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| before tuning | 182 req/s | 153ms | 901ms | 1056ms |
| after | **4,785 req/s** | **5.9ms** | **29ms** | **46ms** |

Two changes got that: a denormalized `clicks_total` column (the board query was counting the clicks
table per row) and a 1-second response cache on the read endpoints, invalidated on any bid or click.

## Known limits

- Single-process SQLite. Fine for a lot of traffic on one box; it does not scale horizontally.
  Multiple instances need Postgres.
- Rate limits are in-memory, so they reset on restart and are per-process.
- No moderation tools. A public paid board needs a way to remove abusive listings.
- Metadata is scraped synchronously during a bid, so a slow site delays that one request.
