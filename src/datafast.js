/* Visitor numbers from DataFast rather than counted here.

   Our own counter records anyone who presents an identifier, which means
   it cannot tell a person from a well-behaved crawler. DataFast already
   does that filtering, so where a token is configured its numbers are used
   and ours become the fallback for when the API is unreachable. */

const BASE = 'https://datafa.st/api/v1';
const TIMEOUT_MS = 4000;
const CACHE_MS = 60_000;

const cache = new Map();

/* Per-brand credentials: DATAFAST_TOKEN_SOCIALRISE, and optionally
   DATAFAST_SITE_SOCIALRISE when the token is account-scoped. */
export function credentialsFor(brand){
  const key = String(brand || '').toUpperCase();
  const token = process.env[`DATAFAST_TOKEN_${key}`] || process.env.DATAFAST_TOKEN || '';
  const websiteId = process.env[`DATAFAST_SITE_${key}`] || process.env.DATAFAST_SITE || '';
  return token ? { token, websiteId } : null;
}

async function call(path, { token, websiteId }, params = {}){
  const url = new URL(BASE + path);
  if (websiteId) url.searchParams.set('websiteId', websiteId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`datafast ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Reads whichever field name the payload uses — the shape is theirs to
   change, and a renamed key should degrade to our own count rather than
   crash the page. */
function pick(obj, ...names){
  for (const n of names){
    const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (typeof v === 'number') return v;
  }
  return null;
}

export async function visitorStats(brand, since){
  const creds = credentialsFor(brand);
  if (!creds) return null;

  const hit = cache.get(brand);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const startAt = new Date(since || Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const endAt = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

    const [realtime, overview] = await Promise.all([
      call('/analytics/realtime', creds).catch(() => null),
      call('/analytics/overview', creds, { startAt, endAt }).catch(() => null)
    ]);

    const online = pick(realtime, 'visitors', 'activeVisitors', 'count', 'data.visitors');
    const total = pick(overview, 'visitors', 'totals.visitors', 'data.visitors');

    // Partial data is worse than none: fall back rather than mix sources.
    if (online == null && total == null) return null;

    const value = { online, visitors: total, source: 'datafast' };
    cache.set(brand, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export function isConfigured(brand){ return Boolean(credentialsFor(brand)); }
