/* Real Stripe Checkout over the REST API — no SDK, no mock objects.

   Enabled when STRIPE_SECRET_KEY is set. Without it the server runs in
   DEV_PAYMENTS mode, where a bid is confirmed directly instead of going
   through Stripe. That mode is refused when NODE_ENV=production so a
   misconfigured deploy can never hand out free ranks. */

import { createHmac, timingSafeEqual } from 'node:crypto';

const BRAND          = process.env.BRAND_NAME || 'Outbid';

/* A 100%-off code discounts whatever it is applied to, so offering the
   promotion field on a large bid lets someone take the top spot for
   nothing and lock out paying customers. Codes are a launch incentive for
   cheap spots, so the field is only offered at or below this amount. */
const PROMO_MAX_BID_CENTS = Number(process.env.PROMO_MAX_BID_CENTS) || 2500;
const SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

export const stripeEnabled = Boolean(SECRET_KEY);

export function assertPaymentsConfigured(){
  if (!stripeEnabled && process.env.NODE_ENV === 'production'){
    throw new Error(
      'STRIPE_SECRET_KEY is required in production — refusing to start with dev payments.'
    );
  }
}

/* Stripe's API takes form-encoded bodies with bracketed nested keys. */
function formEncode(obj, prefix = '', out = new URLSearchParams()){
  for (const [k, v] of Object.entries(obj)){
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => formEncode(item, `${key}[${i}]`, out));
    else out.append(key, String(v));
  }
  return out;
}

async function stripeRequest(path, body, { idempotencyKey } = {}){
  const headers = {
    authorization: `Bearer ${SECRET_KEY}`,
    'content-type': 'application/x-www-form-urlencoded'
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers,
    body: formEncode(body)
  });

  const json = await res.json();
  if (!res.ok){
    throw new Error(json?.error?.message || `Stripe request failed (${res.status})`);
  }
  return json;
}

/* ── Checkout ─────────────────────────────────────────────────── */
export function promoAllowedFor(amountCents){
  return amountCents <= PROMO_MAX_BID_CENTS;
}

export async function createCheckoutSession({ listing, amountCents, rank, origin, bidRef }){
  const session = await stripeRequest('checkout/sessions', {
    mode: 'payment',
    success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=1`,
    client_reference_id: bidRef,
    // Creates a Customer so repeat bidders are recognisable, and makes
    // Stripe email the receipt itself rather than us having to.
    customer_creation: 'always',
    billing_address_collection: 'auto',
    // Stripe renders its own promotion-code field and enforces the limits,
    // so discounts never have to be trusted from our side. Offered only on
    // small bids — see PROMO_MAX_BID_CENTS.
    allow_promotion_codes: promoAllowedFor(amountCents),
    metadata: { listing_id: listing.id, target: listing.target, rank },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: `${BRAND} — rank #${rank} for ${listing.target}`,
          description: `Claims position #${rank} on the leaderboard at $${(amountCents / 100).toFixed(2)}.`
        }
      }
    }]
  }, { idempotencyKey: bidRef });

  return { id: session.id, url: session.url };
}

/* Expanding here means one round trip gives us the buyer's email, the
   payment intent, the charge, the receipt URL and the card brand/last4. */
const SESSION_EXPAND =
  'expand[]=payment_intent&expand[]=payment_intent.latest_charge&expand[]=customer';

export async function retrieveSession(id){
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}?${SESSION_EXPAND}`,
    { headers: { authorization: `Bearer ${SECRET_KEY}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

/* Pulls the record we keep out of a Stripe session.
   Deliberately never touches the full card number — Stripe does not return
   one, and storing it would drag this app into PCI scope. */
export function extractPaymentDetails(session){
  if (!session) return {};

  const pi = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card || null;
  const customer = typeof session.customer === 'object' ? session.customer : null;

  return {
    email:
      session.customer_details?.email ||
      session.customer_email ||
      customer?.email ||
      charge?.billing_details?.email ||
      null,
    name:
      session.customer_details?.name ||
      customer?.name ||
      charge?.billing_details?.name ||
      null,
    customerId: typeof session.customer === 'string' ? session.customer : customer?.id || null,
    paymentIntent: typeof session.payment_intent === 'string'
      ? session.payment_intent
      : pi?.id || null,
    receiptUrl: charge?.receipt_url || null,
    amountPaidCents: session.amount_total ?? charge?.amount ?? null,
    currency: (session.currency || charge?.currency || null)?.toUpperCase() || null,
    cardBrand: card?.brand || null,
    cardLast4: card?.last4 || null,
    country: session.customer_details?.address?.country || card?.country || null
  };
}

/* ── Self-registering webhook ─────────────────────────────────────
   Creating the endpoint through the API means the signing secret never
   has to be copied out of the Stripe dashboard by hand — Stripe returns
   it once, at creation, and we persist it.

   Idempotent: an endpoint already pointing at this URL is reused. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded'
];

export async function ensureWebhookEndpoint(apiOrigin){
  if (!stripeEnabled) return { status: 'skipped', reason: 'no stripe key' };
  if (!apiOrigin)     return { status: 'skipped', reason: 'no api origin' };

  const url = `${apiOrigin.replace(/\/$/, '')}/api/webhook/stripe`;

  const listed = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
    headers: { authorization: `Bearer ${SECRET_KEY}` }
  });
  if (!listed.ok){
    const err = await listed.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Could not list webhooks (${listed.status})`);
  }

  const existing = (await listed.json()).data?.find(e => e.url === url);
  if (existing){
    // Stripe only ever reveals the secret at creation, so an endpoint that
    // already exists is only usable if we still hold its secret.
    return { status: 'exists', id: existing.id, url, secret: null };
  }

  const created = await stripeRequest('webhook_endpoints', {
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: `${BRAND} — bid confirmation`
  });

  return { status: 'created', id: created.id, url, secret: created.secret || null };
}

/* ── Promotion codes ──────────────────────────────────────────────
   Created through the API so nobody has to build them in the Stripe UI.
   A coupon holds the discount; a promotion code is the string customers
   type. Redemption limits are enforced by Stripe, which is the only place
   that can count them correctly. */
export async function ensurePromotionCode({ code, percentOff = 100, maxRedemptions = 100 }){
  if (!stripeEnabled) return { status: 'skipped', reason: 'no stripe key' };

  const listed = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&limit=1`,
    { headers: { authorization: `Bearer ${SECRET_KEY}` } }
  );
  if (!listed.ok){
    const err = await listed.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Could not list promotion codes (${listed.status})`);
  }

  const existing = (await listed.json()).data?.[0];
  if (existing){
    return {
      status: 'exists', code: existing.code, id: existing.id,
      max: existing.max_redemptions, redeemed: existing.times_redeemed
    };
  }

  // A coupon carries the discount; reuse one named after the code.
  const coupon = await stripeRequest('coupons', {
    percent_off: percentOff,
    duration: 'once',
    name: `${code} — ${percentOff}% off`
  }, { idempotencyKey: `coupon_${code}` });

  /* The coupon is nested under `promotion` — a top-level `coupon` param is
     rejected as unknown by the current API. */
  const promo = await stripeRequest('promotion_codes', {
    promotion: { type: 'coupon', coupon: coupon.id },
    code,
    max_redemptions: maxRedemptions
  }, { idempotencyKey: `promo_${code}` });

  return { status: 'created', code: promo.code, id: promo.id,
           max: promo.max_redemptions, redeemed: promo.times_redeemed };
}

export async function getPromotionCode(code){
  if (!stripeEnabled) return null;
  const res = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code)}&limit=1`
      + `&expand[]=data.promotion.coupon`,
    { headers: { authorization: `Bearer ${SECRET_KEY}` } }
  );
  if (!res.ok){
    const err = await res.json().catch(() => ({}));
    return { error: err?.error?.message || `stripe ${res.status}` };
  }
  const found = (await res.json()).data?.[0];
  if (!found) return null;
  return {
    code: found.code,
    active: found.active,
    max: found.max_redemptions,
    redeemed: found.times_redeemed,
    remaining: found.max_redemptions == null ? null : found.max_redemptions - found.times_redeemed,
    percentOff: percentOffOf(found)
  };
}

/* The discount moved from `coupon` to `promotion.coupon`; accept both so a
   response from either API version still reads correctly. */
function percentOffOf(promo){
  const c = promo?.promotion?.coupon ?? promo?.coupon;
  return (typeof c === 'object' ? c?.percent_off : null) ?? null;
}

export async function listPromotionCodes(){
  if (!stripeEnabled) return [];
  const res = await fetch(
    'https://api.stripe.com/v1/promotion_codes?limit=100&expand[]=data.promotion.coupon', {
    headers: { authorization: `Bearer ${SECRET_KEY}` }
  });
  if (!res.ok) return [];
  return (await res.json()).data.map(p => ({
    code: p.code,
    active: p.active,
    percentOff: percentOffOf(p),
    max: p.max_redemptions,
    redeemed: p.times_redeemed,
    remaining: p.max_redemptions == null ? null : p.max_redemptions - p.times_redeemed
  }));
}

/* ── Webhook signature verification ──────────────────────────── */
/* Implements Stripe's scheme: the signed payload is "<timestamp>.<raw body>",
   HMAC-SHA256 with the endpoint secret, compared in constant time. */
export function verifyWebhook(rawBody, signatureHeader, secret = null, toleranceSec = 300){
  const signingSecret = secret || WEBHOOK_SECRET;
  if (!signingSecret) throw new Error('No webhook signing secret available');
  if (!signatureHeader) throw new Error('Missing stripe-signature header');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const timestamp = Number(parts.t);
  if (!timestamp) throw new Error('Malformed stripe-signature header');

  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec){
    throw new Error('Webhook timestamp outside tolerance window');
  }

  const expected = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const provided = parts.v1 || '';
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)){
    throw new Error('Webhook signature mismatch');
  }

  return JSON.parse(rawBody);
}
