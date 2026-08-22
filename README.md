# Outbit

A pay-to-rank leaderboard. Buy a spot, the highest bid sits at #1, and anyone can take it from you
by paying more. Real bids, real Stripe checkout, real metadata scraping, real click tracking. No
seed data and no mock objects — the board starts empty and fills up with whatever people pay for.

Built by [@iamadnank9](https://x.com/iamadnank9).

Node 24+ and zero npm dependencies (SQLite comes from `node:sqlite`).

## Run it

```bash
npm start
```

Then open http://localhost:4321. Without `STRIPE_SECRET_KEY` the server starts in **dev payments
mode**, where a bid confirms immediately instead of going through Stripe, so you can exercise the
whole flow locally. A banner on the page says so. Setting `NODE_ENV=production` without a Stripe
key makes the server refuse to start, so dev mode can never reach production by accident.

```bash
npm test     # 46 integration tests against a real server + real SQLite
```

## How it works

```
server.js         HTTP, routing, static files, click redirects, SSE, CORS
build.js          builds dist/ for static hosting
src/db.js         schema, migrations, every query
src/metadata.js   URL/@handle parsing, SSRF guard, live page scraping
src/payments.js   Stripe Checkout over the REST API + webhook verification
src/analytics.js  DataFast tag + share links, injected from env
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

[DataFast](https://datafa.st) — cookieless, no consent banner. Inert until you point it at your
own property:

```bash
export DATAFAST_WEBSITE_ID=dfid_...        # from your DataFast dashboard
export DATAFAST_DOMAIN=outbit.web.app
export DATAFAST_SHARE_URL=https://datafa.st/share/...   # optional public dashboard
```

The tracker tag is templated into the HTML at serve time (it reads its config off data attributes,
so it must be real markup). With `DATAFAST_SHARE_URL` set, the "see stats" and "Live stats" links
point at your public dashboard.

Two goals fire through `window.datafast()`: `checkout_started` when a bid reaches Stripe, and
`bid_confirmed` when payment settles. DataFast also has a native Stripe integration — connect it in
their dashboard to attribute revenue back to traffic source, no code needed.

Never hardcode a website id: traffic would report into someone else's dashboard.

## Deploying the API to Render

`render.yaml` is a ready-to-use blueprint. In Render: **New + → Blueprint**, pick this repo.

The **persistent disk is not optional**. Render's filesystem is otherwise wiped on every deploy
and restart, which would destroy every bid and payment record. The blueprint mounts a 1GB disk at
`/var/data` and points `DB_PATH` at it. That also pins the service to a single instance, which is
what you want anyway: SQLite needs one writer, and the SSE subscriber list, response cache and rate
limiter are all per-process.

Set these in the Render dashboard (never commit them):

| variable | value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `PUBLIC_ORIGIN` | the public site URL, e.g. `https://outbit.web.app` |
| `ALLOWED_ORIGINS` | `https://outbit.web.app,https://outbit.firebaseapp.com` |
| `DATAFAST_WEBSITE_ID` / `DATAFAST_DOMAIN` | optional analytics |

`PUBLIC_ORIGIN` must match the live URL exactly — it builds the Stripe success and cancel
redirects, so a mismatch sends paying customers to a dead page.

Then point a Stripe webhook at `<PUBLIC_ORIGIN>/api/webhook/stripe` for `checkout.session.completed`.

**Node 24+ is required** — `node:sqlite` is still behind a flag on Node 22. The blueprint pins
`NODE_VERSION=24`.

In production the server binds `0.0.0.0`, marks the visitor cookie `Secure`, trusts
`X-Forwarded-For` from the platform proxy, and refuses to start without a Stripe key.
`/healthz` is the readiness probe.

## Split deploy: Firebase Hosting + Render

To serve the site from a Firebase `*.web.app` address on the free Spark plan, the frontend and
backend go to different places. Firebase Hosting can only serve static files (its rewrites reach
Cloud Functions and Cloud Run, never an arbitrary external URL), so it gets the static bundle and
Render runs the API.

| piece | where | why |
|---|---|---|
| frontend (`index.html`, `styles.css`, `app.js`) | Firebase Hosting → `outbit.web.app` | free on Spark, static-only is fine, global CDN |
| backend (Node) | Render web service | needs outbound calls to Stripe and to scraped sites |
| database (SQLite) | Render persistent disk at `/var/data` | must survive restarts, one writer |

**1. Deploy the API to Render** using `render.yaml`, and set `ALLOWED_ORIGINS`:

```
ALLOWED_ORIGINS=https://outbit.web.app,https://outbit.firebaseapp.com
PUBLIC_ORIGIN=https://outbit.web.app
```

Firebase serves the site on both hostnames, so both need to be allowed. `PUBLIC_ORIGIN` is the
frontend, not the API — it builds the Stripe redirects, which must land back on the site the user
was actually looking at.

**2. Build and deploy the frontend:**

```bash
API_BASE=https://outbit-api.onrender.com DATAFAST_WEBSITE_ID=dfid_... DATAFAST_DOMAIN=outbit.web.app npm run build
firebase deploy --only hosting
```

`build.js` writes `dist/` with the API origin baked into `config.js`. It refuses to build without
`API_BASE`, since a static bundle with no backend is silently broken.

### What cross-origin changes

Two things do not survive the split and are handled explicitly:

- **Cookies.** Browsers block third-party cookies, so the API cannot identify a visitor with one.
  The client generates a UUID, keeps it in `localStorage`, and sends it as `x-visitor-id`. The
  cookie remains only as a same-origin convenience.
- **CORS.** Every API response, including errors, carries the allow header — otherwise a failed
  bid surfaces in the browser as an opaque network error instead of a readable message.

Single-origin deployment still works unchanged: run the Node server and it serves the frontend
itself, with `config.js` defaulting to same-origin and CORS off.

### Domains

A custom domain is still worth buying before you charge people — listings here are sold partly for
their SEO value, and a link from a platform subdomain carries less of it. Point it at Firebase
Hosting when you do; only `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` need updating.

### Transaction records

Every bid is a row in `bids`. When Stripe confirms a payment, the buyer's details are recorded
against it:

| column | example |
|---|---|
| `customer_email` | `buyer@example.com` |
| `customer_name` | `A Buyer` |
| `stripe_customer_id` | `cus_...` |
| `payment_intent` | `pi_...` |
| `receipt_url` | Stripe-hosted receipt |
| `amount_paid_cents` / `currency` | what actually cleared, vs `amount_cents` bid |
| `card_brand` / `card_last4` | `visa` / `4242` |
| `country` | billing country |

**Card numbers are never stored.** Stripe does not return them, and holding them would drag this
app into PCI scope. Brand and last4 are enough to identify a card in a support conversation.

Both confirmation paths write these — the webhook (which carries email and totals) and the success
redirect (which carries the charge, receipt and card). Writes use `COALESCE`, so whichever arrives
second fills gaps rather than overwriting.

Read them back over HTTP:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<api>/api/admin/transactions
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<api>/api/admin/transactions?email=buyer@example.com"
```

Set `ADMIN_TOKEN` to a long random string. Without it the endpoint returns 503 rather than opening
up — it fails shut. The token is compared in constant time.

This table holds personal data. Keep `ADMIN_TOKEN` out of the repo, and be ready to delete a
customer's rows on request.

## Backups

The database is one file. Back it up on a schedule:

```bash
sqlite3 /var/data/outbit.db ".backup '/var/data/backup-$(date +%F).db'"
```

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
