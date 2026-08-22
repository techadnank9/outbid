/* DataFast (https://datafa.st) — cookieless, GDPR-friendly page analytics.

   Configured entirely through env so the tracker is inert until you point it
   at your own DataFast property. Never hardcode a website id: traffic would
   be reported into somebody else's dashboard. */

import { createHash } from 'node:crypto';

const WEBSITE_ID = process.env.DATAFAST_WEBSITE_ID || '';   // dfid_...
const DOMAIN     = process.env.DATAFAST_DOMAIN || '';       // your-domain.com
const SHARE_URL  = process.env.DATAFAST_SHARE_URL || '';    // public dashboard

export const analyticsEnabled = Boolean(WEBSITE_ID && DOMAIN);

function attr(value){
  return String(value).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/* The tracker reads its config off the tag's data attributes, so it has to be
   real markup in the document — it cannot be configured from JS after load. */
export function analyticsTag(){
  if (!analyticsEnabled) return '';
  return `<script defer src="https://datafa.st/js/script.cookieless.js" `
       + `data-website-id="${attr(WEBSITE_ID)}" data-domain="${attr(DOMAIN)}"></script>`;
}

/* "see stats" / "Live stats" point at a DataFast public share link when one is
   configured; otherwise they fall back to the on-page revenue section. */
export function statsHref(){
  return SHARE_URL ? attr(SHARE_URL) : '#stats';
}

export function statsTargetAttrs(){
  return SHARE_URL ? ' target="_blank" rel="noopener"' : '';
}

/* Injected config participates in the ETag — otherwise a config change would
   keep serving the previously cached HTML. */
export const analyticsFingerprint = createHash('sha1')
  .update(`${WEBSITE_ID}|${DOMAIN}|${SHARE_URL}`)
  .digest('hex')
  .slice(0, 8);

export function renderHtml(html){
  return html
    .replaceAll('<!--ANALYTICS-->', analyticsTag())
    .replaceAll('%STATS_HREF%', statsHref())
    .replaceAll('%STATS_TARGET%', statsTargetAttrs());
}
