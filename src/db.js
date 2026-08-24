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
if (!listingCols.includes('platform')){
  db.exec(`ALTER TABLE listings ADD COLUMN platform TEXT`);
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

/* Each board opened on its own day. Reporting the instance's first boot
   made SocialRise claim it had been live for two days on the day it
   launched. Recorded the first time a board is asked about itself. */
export function launchedAtFor(brand){
  const key = `launched_at:${brand}`;
  const existing = getMeta(key);
  if (existing) return Number(existing);

  /* If the board already has listings, it predates this tracking — use its
     oldest listing rather than pretending it launched just now. */
  const oldest = db.prepare(
    `SELECT MIN(created_at) AS t FROM listings WHERE brand = ?`
  ).get(brand)?.t;

  const when = oldest || Date.now();
  setMeta(key, when);
  return when;
}

/* ── Per-brand boards ─────────────────────────────────────────────
   Each brand is its own leaderboard over shared infrastructure, so the
   same handle can be listed on two of them independently. `target` was
   globally unique, which would have made that impossible — SQLite cannot
   drop an inline constraint, so the table is rebuilt once. */
const hasBrand = db.prepare(`PRAGMA table_info(listings)`).all().some(c => c.name === 'brand');
if (!hasBrand){
  /* bids.listing_id is ON DELETE CASCADE, so DROP TABLE listings deletes
     every bid with it. Foreign keys must be off for the swap — and the
     pragma is a no-op inside a transaction, so it has to be set first. */
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE listings_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        brand        TEXT NOT NULL DEFAULT 'outbid',
        kind         TEXT NOT NULL CHECK (kind IN ('url','handle')),
        target       TEXT NOT NULL,
        url          TEXT NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        icon_url     TEXT,
        category     TEXT NOT NULL DEFAULT 'other',
        platform     TEXT,
        clicks_total INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        UNIQUE (brand, target)
      );

      INSERT INTO listings_new
        (id, brand, kind, target, url, title, description, icon_url, category, platform, clicks_total, created_at)
      SELECT id, 'outbid', kind, target, url, title, description, icon_url,
             COALESCE(category,'other'), platform, COALESCE(clicks_total,0), created_at
      FROM listings;

      DROP TABLE listings;
      ALTER TABLE listings_new RENAME TO listings;
    `);
    /* Refuse to finish if the swap cost us rows. */
    const orphaned = db.prepare(`
      SELECT COUNT(*) AS n FROM bids b
      WHERE NOT EXISTS (SELECT 1 FROM listings l WHERE l.id = b.listing_id)
    `).get().n;
    if (orphaned > 0) throw new Error(`migration left ${orphaned} orphaned bids`);

    db.exec('COMMIT');
  } catch (err){
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
if (!db.prepare(`PRAGMA table_info(listings)`).all().some(c => c.name === 'platform')){
  db.exec(`ALTER TABLE listings ADD COLUMN platform TEXT`);
}
/* visitors was keyed on visitor_id alone, so counts were global. */
if (!db.prepare(`PRAGMA table_info(visitors)`).all().some(c => c.name === 'brand')){
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE visitors_new (
        visitor_id  TEXT NOT NULL,
        brand       TEXT NOT NULL DEFAULT 'outbid',
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        PRIMARY KEY (visitor_id, brand)
      );
      INSERT INTO visitors_new (visitor_id, brand, first_seen, last_seen)
      SELECT visitor_id, 'outbid', first_seen, last_seen FROM visitors;
      DROP TABLE visitors;
      ALTER TABLE visitors_new RENAME TO visitors;
    `);
    db.exec('COMMIT');
  } catch (err){
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_visitors_brand ON visitors(brand, last_seen DESC)`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_brand ON listings(brand)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_brand_cat ON listings(brand, category)`);

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
    l.platform,
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

export function boardPage(brand, limit, offset, category = null){
  const filter = category ? `WHERE l.brand = ? AND l.category = ?` : `WHERE l.brand = ?`;
  const args = category ? [brand, category, limit, offset] : [brand, limit, offset];
  return db.prepare(`
    ${BOARD_SELECT}
    ${filter}
    ORDER BY b.amount_cents DESC, b.paid_at ASC, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...args);
}

export function boardCount(brand = null, category = null){
  /* No brand means every board — used by the health check and boot log,
     which report the whole instance rather than one leaderboard. */
  if (!brand){
    return db.prepare(`
      SELECT COUNT(DISTINCT listing_id) AS n FROM bids WHERE status = 'paid'
    `).get().n;
  }
  if (!category){
    return db.prepare(`
      SELECT COUNT(DISTINCT b.listing_id) AS n
      FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE b.status = 'paid' AND l.brand = ?
    `).get(brand).n;
  }
  return db.prepare(`
    SELECT COUNT(DISTINCT b.listing_id) AS n
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid' AND l.brand = ? AND l.category = ?
  `).get(brand, category).n;
}

/* Only categories that actually have paid listings are worth showing a
   count for; the page still lists the empty ones, at zero. */
export function categoryCounts(brand){
  const rows = db.prepare(`
    SELECT l.category, COUNT(DISTINCT b.listing_id) AS n,
           MAX(b.amount_cents) AS top_cents
    FROM listings l JOIN bids b ON b.listing_id = l.id AND b.status = 'paid'
    WHERE l.brand = ?
    GROUP BY l.category
  `).all(brand);
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

export function topAmount(brand){
  const row = db.prepare(`
    SELECT MAX(b.amount_cents) AS n
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid' AND l.brand = ?
  `).get(brand);
  return row.n || 0;
}

/* Rank a hypothetical amount would take: one past everyone who beats it. */
export function rankForAmount(brand, amountCents, excludeListingId = null){
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT b.listing_id, MAX(b.amount_cents) AS amount_cents
      FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE b.status = 'paid' AND l.brand = ?
      GROUP BY b.listing_id
    )
    WHERE amount_cents >= ? AND listing_id IS NOT ?
  `).get(brand, amountCents, excludeListingId);
  return row.n + 1;
}

export function listingRank(listingId){
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT b.listing_id, MAX(b.amount_cents) AS amount_cents
      FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE b.status = 'paid'
        AND l.brand = (SELECT brand FROM listings WHERE id = ?)
      GROUP BY b.listing_id
    ) x
    WHERE x.amount_cents > (
      SELECT MAX(amount_cents) FROM bids WHERE status='paid' AND listing_id = ?
    )
  `).get(listingId, listingId);
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
export function findListing(brand, target){
  return db.prepare(`SELECT * FROM listings WHERE brand = ? AND target = ?`).get(brand, target);
}

export function getListing(id){
  return db.prepare(`SELECT * FROM listings WHERE id = ?`).get(id);
}

export function upsertListing({ brand, kind, target, url, title, description, iconUrl, category, platform }){
  const existing = findListing(brand, target);
  if (existing){
    /* Refresh metadata — the product page may have changed since the last
       bid. The category is left alone: an owner may have had it corrected
       by hand, and a re-bid should not silently undo that. */
    db.prepare(`
      UPDATE listings SET url = ?, title = ?, description = ?, icon_url = ?,
                          platform = COALESCE(?, platform)
      WHERE id = ?
    `).run(url, title, description, iconUrl ?? null, platform ?? null, existing.id);
    return getListing(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO listings
      (brand, kind, target, url, title, description, icon_url, category, platform, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(brand, kind, target, url, title, description, iconUrl ?? null,
         category || 'other', platform ?? null, Date.now());
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
export function recentActivity(brand, limit = 5){
  return db.prepare(`
    SELECT l.id, l.target, l.title, l.icon_url, l.platform,
           b.amount_cents, b.amount_paid_cents, b.paid_at
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid' AND l.brand = ?
    ORDER BY b.paid_at DESC
    LIMIT ?
  `).all(brand, limit);
}

export function trending(brand, limit = 5, windowMs = 3600_000){
  return db.prepare(`
    SELECT l.id, l.target, l.title, l.icon_url, COUNT(c.id) AS hits
    FROM clicks c JOIN listings l ON l.id = c.listing_id
    WHERE c.created_at > ? AND l.brand = ?
    GROUP BY l.id
    ORDER BY hits DESC
    LIMIT ?
  `).all(Date.now() - windowMs, brand, limit);
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

/* ── Visitors ───────────────────────────────────────────────────
   Counted per board. Without this, a board reports every visitor the
   server has ever seen — SocialRise claimed 84 visitors on the day it
   launched, which were mostly Outbid's. One person visiting two boards is
   a visitor to each, which is why the key is the pair. */
export function touchVisitor(visitorId, brand = 'outbid'){
  const now = Date.now();
  db.prepare(`
    INSERT INTO visitors (visitor_id, brand, first_seen, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(visitor_id, brand) DO UPDATE SET last_seen = excluded.last_seen
  `).run(visitorId, brand, now, now);
}

export function visitorStats(brand = null, onlineWindowMs = 120_000){
  const where = brand ? `WHERE brand = ?` : '';
  const args = brand ? [brand] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM visitors ${where}`).get(...args).n;
  const online = db.prepare(`
    SELECT COUNT(*) AS n FROM visitors
    WHERE last_seen > ? ${brand ? 'AND brand = ?' : ''}
  `).get(Date.now() - onlineWindowMs, ...args).n;
  return { total, online };
}

/* What was actually charged, not what was bid. A promo listing has a bid of
   $5 but was paid at $0, and counting the bid would overstate revenue.
   amount_paid_cents is null for bids taken before it was recorded, so fall
   back to the bid amount for those. */
export function revenueCents(brand = null){
  if (!brand){
    return db.prepare(`
      SELECT COALESCE(SUM(COALESCE(amount_paid_cents, amount_cents)), 0) AS n
      FROM bids WHERE status = 'paid'
    `).get().n;
  }
  return db.prepare(`
    SELECT COALESCE(SUM(COALESCE(b.amount_paid_cents, b.amount_cents)), 0) AS n
    FROM bids b JOIN listings l ON l.id = b.listing_id
    WHERE b.status = 'paid' AND l.brand = ?
  `).get(brand).n;
}
