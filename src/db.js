import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || new URL('../data/outbid.db', import.meta.url).pathname;

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('url','handle')),
    target       TEXT NOT NULL UNIQUE,   -- canonical: "example.com" or "@handle"
    url          TEXT NOT NULL,          -- where the click-through goes
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    icon_url     TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bids (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id    INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
    status        TEXT NOT NULL CHECK (status IN ('pending','paid','failed')),
    provider      TEXT NOT NULL DEFAULT 'stripe',
    session_id    TEXT UNIQUE,
    created_at    INTEGER NOT NULL,
    paid_at       INTEGER
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visitors (
    visitor_id  TEXT PRIMARY KEY,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    code             TEXT PRIMARY KEY,          -- stored upper-case
    amount_cents     INTEGER NOT NULL,          -- what the code is worth
    max_redemptions  INTEGER NOT NULL,
    redeemed         INTEGER NOT NULL DEFAULT 0,
    active           INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS promo_redemptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL,
    listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    bid_id      INTEGER,
    created_at  INTEGER NOT NULL,
    UNIQUE(code, listing_id)                    -- one redemption per listing
  );

  CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bids_listing  ON bids(listing_id, status, amount_cents DESC);
  CREATE INDEX IF NOT EXISTS idx_bids_paid     ON bids(status, paid_at DESC);
  CREATE INDEX IF NOT EXISTS idx_clicks_time   ON clicks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_clicks_recent ON clicks(listing_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_visitors_seen ON visitors(last_seen DESC);
`);

/* Launch timestamp is recorded once, on first boot. */
const now = Date.now();
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('launched_at', ?)`).run(String(now));

/* Denormalized click counter. Counting the clicks table per row made the
   board query O(rows x clicks); this keeps it O(rows). The clicks table is
   still the source of truth for time-windowed trending. */
const listingCols = db.prepare(`PRAGMA table_info(listings)`).all().map(c => c.name);
if (!listingCols.includes('clicks_total')){
  db.exec(`ALTER TABLE listings ADD COLUMN clicks_total INTEGER NOT NULL DEFAULT 0`);
  db.exec(`
    UPDATE listings SET clicks_total =
      (SELECT COUNT(*) FROM clicks c WHERE c.listing_id = listings.id)
  `);
}

/* Payment records. Kept on the bid row: one bid is one transaction, and
   the money details are useless separated from what was bought.
   Card numbers are never stored — only Stripe's brand/last4, which is all
   that is needed to answer "which card was this?" without holding PAN data. */
const bidCols = db.prepare(`PRAGMA table_info(bids)`).all().map(c => c.name);
for (const [col, type] of [
  ['customer_email',     'TEXT'],
  ['customer_name',      'TEXT'],
  ['stripe_customer_id', 'TEXT'],
  ['payment_intent',     'TEXT'],
  ['receipt_url',        'TEXT'],
  ['amount_paid_cents',  'INTEGER'],
  ['currency',           'TEXT'],
  ['card_brand',         'TEXT'],
  ['card_last4',         'TEXT'],
  ['country',            'TEXT']
]){
  if (!bidCols.includes(col)) db.exec(`ALTER TABLE bids ADD COLUMN ${col} ${type}`);
}
if (!listingCols.includes('category')){
  db.exec(`ALTER TABLE listings ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bids_email ON bids(customer_email)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_bids_pi    ON bids(payment_intent)`);

/* The launch code. Seeded once; edit it in the database or via the admin
   endpoint rather than here, so a redeploy never resets the counter. */
db.prepare(`
  INSERT OR IGNORE INTO promo_codes (code, amount_cents, max_redemptions, active, created_at)
  VALUES ('HACKATHON', 500, 100, 1, ?)
`).run(Date.now());

export const launchedAt = Number(
  db.prepare(`SELECT value FROM meta WHERE key = 'launched_at'`).get().value
);

/* ── Core query: the live board ──────────────────────────────────
   A listing's standing price is its highest *paid* bid. Ties break by
   whoever got there first, so an equal bid can never displace a sitting
   listing — matching the "you must outbid" rule.                    */
const BOARD_SELECT = `
  SELECT
    l.id, l.kind, l.target, l.url, l.title, l.description, l.icon_url,
    b.amount_cents,
    b.paid_at,
    l.clicks_total AS clicks,
    l.category,
    (SELECT b2.amount_paid_cents
       FROM bids b2
      WHERE b2.listing_id = l.id AND b2.status = 'paid'
      ORDER BY b2.amount_cents DESC, b2.paid_at ASC
      LIMIT 1) AS amount_paid_cents
  FROM listings l
  JOIN (
    SELECT listing_id,
           MAX(amount_cents) AS amount_cents,
           MIN(paid_at)      AS paid_at
    FROM bids
    WHERE status = 'paid'
    GROUP BY listing_id
  ) b ON b.listing_id = l.id
`;

export function boardPage(limit, offset, category = null){
  const filter = category ? `WHERE l.category = ?` : '';
  const args = category ? [category, limit, offset] : [limit, offset];
  return db.prepare(`
    ${BOARD_SELECT}
    ${filter}
    ORDER BY b.amount_cents DESC, b.paid_at ASC, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...args);
}

export function boardCount(category = null){
  if (!category){
    return db.prepare(`
      SELECT COUNT(DISTINCT listing_id) AS n FROM bids WHERE status = 'paid'
    `).get().n;
  }
  return db.prepare(`
    SELECT COUNT(DISTINCT b.listing_id) AS n
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid' AND l.category = ?
  `).get(category).n;
}

/* Only categories that actually have paid listings are worth showing a
   count for; the page still lists the empty ones, at zero. */
export function categoryCounts(){
  const rows = db.prepare(`
    SELECT l.category, COUNT(DISTINCT b.listing_id) AS n,
           MAX(b.amount_cents) AS top_cents
    FROM listings l JOIN bids b ON b.listing_id = l.id AND b.status = 'paid'
    GROUP BY l.category
  `).all();
  return new Map(rows.map(r => [r.category, { count: r.n, topCents: r.top_cents }]));
}

/* Removes a listing and everything hanging off it. Bids cascade, so the
   revenue figure drops accordingly — which is correct for a test row, and
   is why this is admin-only. */
export function deleteListing(listingId){
  const info = db.prepare(`DELETE FROM listings WHERE id = ?`).run(listingId);
  return info.changes > 0;
}

export function setCategory(listingId, category){
  db.prepare(`UPDATE listings SET category = ? WHERE id = ?`).run(category, listingId);
  return getListing(listingId);
}

export function topAmount(){
  const row = db.prepare(`
    SELECT MAX(amount_cents) AS n FROM bids WHERE status = 'paid'
  `).get();
  return row.n || 0;
}

/* Rank a hypothetical amount would take: one past everyone who beats it. */
export function rankForAmount(amountCents, excludeListingId = null){
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT listing_id, MAX(amount_cents) AS amount_cents
      FROM bids WHERE status = 'paid'
      GROUP BY listing_id
    )
    WHERE amount_cents >= ? AND listing_id IS NOT ?
  `).get(amountCents, excludeListingId);
  return row.n + 1;
}

export function listingRank(listingId){
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT listing_id, MAX(amount_cents) AS amount_cents, MIN(paid_at) AS paid_at
      FROM bids WHERE status = 'paid'
      GROUP BY listing_id
    ) x
    WHERE x.amount_cents > (
      SELECT MAX(amount_cents) FROM bids WHERE status='paid' AND listing_id = ?
    )
  `).get(listingId);
  return row.n + 1;
}

/* ── Key/value meta ───────────────────────────────────────────── */
export function getMeta(key){
  return db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)?.value ?? null;
}
export function setMeta(key, value){
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/* ── Listings ─────────────────────────────────────────────────── */
export function findListing(target){
  return db.prepare(`SELECT * FROM listings WHERE target = ?`).get(target);
}

export function getListing(id){
  return db.prepare(`SELECT * FROM listings WHERE id = ?`).get(id);
}

export function upsertListing({ kind, target, url, title, description, iconUrl, category }){
  const existing = findListing(target);
  if (existing){
    /* Refresh metadata — the product page may have changed since the last
       bid. The category is left alone: an owner may have had it corrected
       by hand, and a re-bid should not silently undo that. */
    db.prepare(`
      UPDATE listings SET url = ?, title = ?, description = ?, icon_url = ?
      WHERE id = ?
    `).run(url, title, description, iconUrl ?? null, existing.id);
    return getListing(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO listings (kind, target, url, title, description, icon_url, category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, target, url, title, description, iconUrl ?? null, category || 'other', Date.now());
  return getListing(Number(info.lastInsertRowid));
}

/* ── Bids ─────────────────────────────────────────────────────── */
export function createBid({ listingId, amountCents, status, sessionId, provider = 'stripe' }){
  const info = db.prepare(`
    INSERT INTO bids (listing_id, amount_cents, status, provider, session_id, created_at, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    listingId, amountCents, status, provider, sessionId ?? null,
    Date.now(), status === 'paid' ? Date.now() : null
  );
  return Number(info.lastInsertRowid);
}

export function markBidPaid(sessionId){
  const bid = db.prepare(`SELECT * FROM bids WHERE session_id = ?`).get(sessionId);
  if (!bid || bid.status === 'paid') return bid || null;
  db.prepare(`UPDATE bids SET status = 'paid', paid_at = ? WHERE id = ?`).run(Date.now(), bid.id);
  return db.prepare(`SELECT * FROM bids WHERE id = ?`).get(bid.id);
}

/* Written when Stripe confirms a payment, from either the webhook or the
   success redirect. Both can fire, so this must be safe to run twice —
   COALESCE keeps whichever call had the fuller picture. */
export function attachPaymentDetails(sessionId, d){
  db.prepare(`
    UPDATE bids SET
      customer_email     = COALESCE(?, customer_email),
      customer_name      = COALESCE(?, customer_name),
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      payment_intent     = COALESCE(?, payment_intent),
      receipt_url        = COALESCE(?, receipt_url),
      amount_paid_cents  = COALESCE(?, amount_paid_cents),
      currency           = COALESCE(?, currency),
      card_brand         = COALESCE(?, card_brand),
      card_last4         = COALESCE(?, card_last4),
      country            = COALESCE(?, country)
    WHERE session_id = ?
  `).run(
    d.email ?? null, d.name ?? null, d.customerId ?? null, d.paymentIntent ?? null,
    d.receiptUrl ?? null, d.amountPaidCents ?? null, d.currency ?? null,
    d.cardBrand ?? null, d.cardLast4 ?? null, d.country ?? null,
    sessionId
  );
  return db.prepare(`SELECT * FROM bids WHERE session_id = ?`).get(sessionId) || null;
}

/* Full transaction ledger, newest first — for the admin endpoint. */
export function transactions({ limit = 100, offset = 0, email = null } = {}){
  const where = email ? `AND b.customer_email = ?` : '';
  const args = email ? [email, limit, offset] : [limit, offset];
  return db.prepare(`
    SELECT
      b.id, b.status, b.provider, b.session_id, b.payment_intent,
      b.amount_cents, b.amount_paid_cents, b.currency,
      b.customer_email, b.customer_name, b.stripe_customer_id,
      b.card_brand, b.card_last4, b.country, b.receipt_url,
      b.created_at, b.paid_at,
      l.target, l.title
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE 1=1 ${where}
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args);
}

export function transactionCount(){
  return db.prepare(`SELECT COUNT(*) AS n FROM bids`).get().n;
}

export function getBidBySession(sessionId){
  return db.prepare(`SELECT * FROM bids WHERE session_id = ?`).get(sessionId) || null;
}

export function highestPaidBid(listingId){
  const row = db.prepare(`
    SELECT MAX(amount_cents) AS n FROM bids WHERE listing_id = ? AND status = 'paid'
  `).get(listingId);
  return row.n || 0;
}

/* ── Promo codes ──────────────────────────────────────────────── */
export function findPromo(code){
  return db.prepare(`SELECT * FROM promo_codes WHERE code = ?`)
    .get(String(code || '').trim().toUpperCase()) || null;
}

export function promoStatus(code){
  const promo = findPromo(code);
  if (!promo) return { valid: false, reason: 'unknown' };
  if (!promo.active) return { valid: false, reason: 'inactive' };
  const remaining = promo.max_redemptions - promo.redeemed;
  if (remaining <= 0) return { valid: false, reason: 'exhausted', remaining: 0 };
  return {
    valid: true,
    code: promo.code,
    amount: promo.amount_cents / 100,
    remaining,
    total: promo.max_redemptions
  };
}

/* Claims one redemption, or returns null if the code is spent.
   The counter is incremented by a conditional UPDATE inside an immediate
   transaction, so two simultaneous redemptions of the hundredth slot cannot
   both succeed — the second one matches no row. */
export function redeemPromo(code, listingId){
  const normalized = String(code || '').trim().toUpperCase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const already = db.prepare(
      `SELECT 1 FROM promo_redemptions WHERE code = ? AND listing_id = ?`
    ).get(normalized, listingId);
    if (already){ db.exec('ROLLBACK'); return { ok: false, reason: 'already_used' }; }

    const res = db.prepare(`
      UPDATE promo_codes SET redeemed = redeemed + 1
      WHERE code = ? AND active = 1 AND redeemed < max_redemptions
    `).run(normalized);

    if (res.changes === 0){ db.exec('ROLLBACK'); return { ok: false, reason: 'exhausted' }; }

    db.prepare(`
      INSERT INTO promo_redemptions (code, listing_id, created_at) VALUES (?, ?, ?)
    `).run(normalized, listingId, Date.now());

    const promo = db.prepare(`SELECT * FROM promo_codes WHERE code = ?`).get(normalized);
    db.exec('COMMIT');
    return {
      ok: true,
      amountCents: promo.amount_cents,
      remaining: promo.max_redemptions - promo.redeemed
    };
  } catch (err){
    db.exec('ROLLBACK');
    throw err;
  }
}

export function upsertPromo({ code, amountCents, maxRedemptions, active = 1 }){
  const normalized = String(code).trim().toUpperCase();
  db.prepare(`
    INSERT INTO promo_codes (code, amount_cents, max_redemptions, active, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      amount_cents = excluded.amount_cents,
      max_redemptions = excluded.max_redemptions,
      active = excluded.active
  `).run(normalized, amountCents, maxRedemptions, active ? 1 : 0, Date.now());
  return findPromo(normalized);
}

export function listPromos(){
  return db.prepare(`SELECT * FROM promo_codes ORDER BY created_at DESC`).all();
}

/* ── Feeds ────────────────────────────────────────────────────── */
export function recentActivity(limit = 5){
  return db.prepare(`
    SELECT l.id, l.target, l.title, l.icon_url,
           b.amount_cents, b.amount_paid_cents, b.paid_at
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid'
    ORDER BY b.paid_at DESC
    LIMIT ?
  `).all(limit);
}

export function trending(limit = 5, windowMs = 3600_000){
  return db.prepare(`
    SELECT l.id, l.target, l.title, l.icon_url, COUNT(c.id) AS hits
    FROM clicks c JOIN listings l ON l.id = c.listing_id
    WHERE c.created_at > ?
    GROUP BY l.id
    ORDER BY hits DESC
    LIMIT ?
  `).all(Date.now() - windowMs, limit);
}

const insertClick = db.prepare(`INSERT INTO clicks (listing_id, created_at) VALUES (?, ?)`);
const bumpClicks  = db.prepare(`UPDATE listings SET clicks_total = clicks_total + 1 WHERE id = ?`);

export function recordClick(listingId){
  db.exec('BEGIN IMMEDIATE');
  try {
    insertClick.run(listingId, Date.now());
    bumpClicks.run(listingId);
    db.exec('COMMIT');
  } catch (err){
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ── Visitors ─────────────────────────────────────────────────── */
export function touchVisitor(visitorId){
  const now = Date.now();
  db.prepare(`
    INSERT INTO visitors (visitor_id, first_seen, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(visitor_id) DO UPDATE SET last_seen = excluded.last_seen
  `).run(visitorId, now, now);
}

export function visitorStats(onlineWindowMs = 120_000){
  const total  = db.prepare(`SELECT COUNT(*) AS n FROM visitors`).get().n;
  const online = db.prepare(`SELECT COUNT(*) AS n FROM visitors WHERE last_seen > ?`)
    .get(Date.now() - onlineWindowMs).n;
  return { total, online };
}

/* What was actually charged, not what was bid. A promo listing has a bid of
   $5 but was paid at $0, and counting the bid would overstate revenue.
   amount_paid_cents is null for bids taken before it was recorded, so fall
   back to the bid amount for those. */
export function revenueCents(){
  return db.prepare(`
    SELECT COALESCE(SUM(COALESCE(amount_paid_cents, amount_cents)), 0) AS n
    FROM bids WHERE status = 'paid'
  `).get().n;
}
