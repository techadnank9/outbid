/* Real Stripe Checkout over the REST API — no SDK, no mock objects.

   Enabled when STRIPE_SECRET_KEY is set. Without it the server runs in
   DEV_PAYMENTS mode, where a bid is confirmed directly instead of going
   through Stripe. That mode is refused when NODE_ENV=production so a
   misconfigured deploy can never hand out free ranks. */

import { createHmac, timingSafeEqual } from 'node:crypto';

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
export async function createCheckoutSession({ listing, amountCents, rank, origin, bidRef }){
  const session = await stripeRequest('checkout/sessions', {
    mode: 'payment',
    success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=1`,
    client_reference_id: bidRef,
    metadata: { listing_id: listing.id, target: listing.target, rank },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: `outbid.lol — rank #${rank} for ${listing.target}`,
          description: `Claims position #${rank} on the leaderboard at $${(amountCents / 100).toFixed(2)}.`
        }
      }
    }]
  }, { idempotencyKey: bidRef });

  return { id: session.id, url: session.url };
}

export async function retrieveSession(id){
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${SECRET_KEY}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

/* ── Webhook signature verification ──────────────────────────── */
/* Implements Stripe's scheme: the signed payload is "<timestamp>.<raw body>",
   HMAC-SHA256 with the endpoint secret, compared in constant time. */
export function verifyWebhook(rawBody, signatureHeader, toleranceSec = 300){
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signatureHeader) throw new Error('Missing stripe-signature header');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const timestamp = Number(parts.t);
  if (!timestamp) throw new Error('Malformed stripe-signature header');

  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec){
    throw new Error('Webhook timestamp outside tolerance window');
  }

  const expected = createHmac('sha256', WEBHOOK_SECRET)
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
