/* Payment record keeping: what we extract from Stripe, what we store,
   and who is allowed to read it back. */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPaymentDetails } from '../src/payments.js';

/* A realistic expanded Checkout Session, shaped like Stripe's. */
const SESSION = {
  id: 'cs_test_123',
  amount_total: 40000,
  currency: 'usd',
  payment_status: 'paid',
  customer: { id: 'cus_abc', email: 'buyer@example.com', name: 'A Buyer' },
  customer_details: {
    email: 'buyer@example.com',
    name: 'A Buyer',
    address: { country: 'GB' }
  },
  payment_intent: {
    id: 'pi_xyz',
    latest_charge: {
      id: 'ch_1',
      amount: 40000,
      currency: 'usd',
      receipt_url: 'https://pay.stripe.com/receipts/abc',
      billing_details: { email: 'buyer@example.com' },
      payment_method_details: { card: { brand: 'visa', last4: '4242', country: 'GB' } }
    }
  }
};

describe('extracting payment details', () => {
  test('pulls everything we keep out of an expanded session', () => {
    const d = extractPaymentDetails(SESSION);
    assert.equal(d.email, 'buyer@example.com');
    assert.equal(d.name, 'A Buyer');
    assert.equal(d.customerId, 'cus_abc');
    assert.equal(d.paymentIntent, 'pi_xyz');
    assert.equal(d.receiptUrl, 'https://pay.stripe.com/receipts/abc');
    assert.equal(d.amountPaidCents, 40000);
    assert.equal(d.currency, 'USD');
    assert.equal(d.cardBrand, 'visa');
    assert.equal(d.cardLast4, '4242');
    assert.equal(d.country, 'GB');
  });

  test('handles the unexpanded webhook payload, where ids are strings', () => {
    const webhookShape = {
      id: 'cs_test_123',
      amount_total: 40000,
      currency: 'usd',
      customer: 'cus_abc',
      payment_intent: 'pi_xyz',
      customer_details: { email: 'buyer@example.com', name: 'A Buyer' }
    };
    const d = extractPaymentDetails(webhookShape);
    assert.equal(d.email, 'buyer@example.com');
    assert.equal(d.customerId, 'cus_abc');
    assert.equal(d.paymentIntent, 'pi_xyz');
    assert.equal(d.receiptUrl, null, 'no charge in the webhook payload');
    assert.equal(d.cardLast4, null);
  });

  test('never returns a full card number', () => {
    const d = extractPaymentDetails(SESSION);
    const dumped = JSON.stringify(d);
    assert.ok(!/\d{13,19}/.test(dumped), 'no PAN-length digit run in the record');
    assert.deepEqual(Object.keys(d).filter(k => /number|pan|cvc|cvv/i.test(k)), []);
  });

  test('survives a missing or empty session', () => {
    assert.deepEqual(extractPaymentDetails(null), {});
    const d = extractPaymentDetails({ id: 'cs_1' });
    assert.equal(d.email, null);
    assert.equal(d.amountPaidCents, null);
  });
});

/* ── Ledger endpoint ─────────────────────────────────────────── */
const PORT = 4388;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-token-value';
const dir = mkdtempSync(join(tmpdir(), 'outbid-pay-'));
let child;

async function boot(env){
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'p.db'),
           NODE_ENV: 'test', STRIPE_SECRET_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const deadline = Date.now() + 15000;
  for (;;){
    try { await fetch(BASE + '/healthz'); break; }
    catch { if (Date.now() > deadline) throw new Error('no start'); await new Promise(r => setTimeout(r, 120)); }
  }
}

before(() => boot({ ADMIN_TOKEN: ADMIN }));
after(() => { child?.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

describe('transaction ledger', () => {
  test('refuses access without a token', async () => {
    const res = await fetch(BASE + '/api/admin/transactions');
    assert.equal(res.status, 401);
  });

  test('refuses a wrong token', async () => {
    const res = await fetch(BASE + '/api/admin/transactions', {
      headers: { authorization: 'Bearer not-the-token' }
    });
    assert.equal(res.status, 401);
  });

  test('never leaks customer emails to an unauthorized caller', async () => {
    const res = await fetch(BASE + '/api/admin/transactions');
    const text = await res.text();
    assert.ok(!/@/.test(text), 'no email-shaped content in a rejection');
  });

  test('records a bid as a transaction', async () => {
    await fetch(BASE + '/api/bid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'example.com', amount: 25 })
    });

    const res = await fetch(BASE + '/api/admin/transactions', {
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);

    const [tx] = body.items;
    assert.equal(tx.target, 'example.com');
    assert.equal(tx.bid, 25);
    assert.equal(tx.status, 'paid');
    assert.ok(tx.createdAt > 0);
    // dev mode has no Stripe, so no buyer details exist to record
    assert.equal(tx.email, null);
    assert.equal(tx.card, null);
  });

  test('filters by email', async () => {
    const res = await fetch(BASE + '/api/admin/transactions?email=nobody@example.com', {
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    assert.deepEqual((await res.json()).items, []);
  });
});
