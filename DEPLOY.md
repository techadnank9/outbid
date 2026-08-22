# Deploying Outbit

Frontend on Firebase Hosting (`outbidloll.web.app`), API + database on Render.

Order matters: **Render first**, because the frontend needs the API's URL baked in at build time.

---

## 1. Render — API + database

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**
2. Connect `techadnank9/outbid`. Render reads `render.yaml` and proposes a web service with a 1GB disk.
3. Apply. Note the URL it gives you, e.g. `https://outbit.onrender.com`.

Then in the service's **Environment** tab, add:

```
STRIPE_SECRET_KEY       sk_live_...          (from your Stripe dashboard)
STRIPE_WEBHOOK_SECRET   whsec_...            (from step 3 below)
PUBLIC_ORIGIN           https://outbidloll.web.app
ALLOWED_ORIGINS         https://outbidloll.web.app,https://outbidloll.firebaseapp.com
```

Optional analytics:

```
DATAFAST_WEBSITE_ID     dfid_...
DATAFAST_DOMAIN         outbidloll.web.app
DATAFAST_SHARE_URL      https://datafa.st/share/...
```

> **`PUBLIC_ORIGIN` is the site URL, not the API URL.** It builds the Stripe success and cancel
> redirects. Point it at Render by mistake and customers get charged, then land on a page that
> isn't your site. This is the single easiest thing to get wrong here.

Check it came up:

```bash
curl https://<your-service>.onrender.com/healthz
# {"ok":true,"listings":0,"uptime":3}
```

The service refuses to start in production without `STRIPE_SECRET_KEY`, so a failed boot with that
message means the key is missing, not that something is broken.

---

## 2. Firebase — frontend

One-time, on your machine (needs your Google login):

```bash
npm install -g firebase-tools
firebase login
```

Then, every time you deploy:

```bash
API_BASE=https://<your-service>.onrender.com npm run deploy
```

That builds `dist/` with the API origin baked into `config.js` and pushes it to Firebase. The
project is pinned in `.firebaserc`, so it can't deploy to the wrong one.

Site goes live at **https://outbidloll.web.app**.

---

## 3. Stripe — webhook

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. URL: `https://<your-service>.onrender.com/api/webhook/stripe`
3. Event: `checkout.session.completed`
4. Copy the signing secret (`whsec_...`) into Render as `STRIPE_WEBHOOK_SECRET`, then redeploy.

The webhook is signature-verified, so an unsigned or replayed request is rejected. Payments also
settle via the success redirect, so a slow webhook won't stall the board — both paths are
idempotent and a bid can't be double-counted.

---

## Verifying it end to end

1. Open https://outbidloll.web.app — board loads, counters move.
2. Type a URL. Within a second the preview shows that site's real title, description and icon,
   plus the rank your bid would take. If this works, CORS and the API are wired correctly.
3. Place a bid with a [Stripe test card](https://docs.stripe.com/testing) (`4242 4242 4242 4242`)
   while in test mode. You should be redirected to Stripe, then back to your site, and the listing
   should appear on the board.
4. Click a listing — it should redirect to the target and the click count should increment.

If step 2 fails but the board loads, `ALLOWED_ORIGINS` is wrong. If step 3 charges but lands on a
broken page, `PUBLIC_ORIGIN` is wrong.

---

## Redeploying

- **Backend:** push to `main`; Render auto-deploys. The database on the mounted disk is untouched.
- **Frontend:** re-run the `npm run deploy` command above.

## Backups

The database is one file on the Render disk. From the service's shell:

```bash
sqlite3 /var/data/outbit.db ".backup '/var/data/backup-$(date +%F).db'"
```

Worth doing before any schema change, and on a schedule once real money is moving through it.
