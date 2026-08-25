/* DataFast (https://datafa.st) — cookieless, GDPR-friendly page analytics.

   Configured entirely through env so the tracker is inert until you point it
   at your own DataFast property. Never hardcode a website id: traffic would
   be reported into somebody else's dashboard. */

import { createHash } from 'node:crypto';

const WEBSITE_ID = process.env.DATAFAST_WEBSITE_ID || '';   // dfid_...
const DOMAIN     = process.env.DATAFAST_DOMAIN || '';       // your-domain.com
const SHARE_URL  = process.env.DATAFAST_SHARE_URL || '';    // public dashboard
const BRAND      = process.env.BRAND_NAME || 'Outbid';      // per-domain name
const THEME      = process.env.BRAND_THEME || '';           // '' = base look

/* Each brand gets its own type. Loading only what a brand uses keeps the
   font payload honest rather than shipping both families everywhere. */
const FONT_SETS = {
  '': 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Geist+Mono:wght@400;500;600;700&display=swap',
  socialrise: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600;700&display=swap'
};

/* DataFast ships two trackers: script.js (the default from the dashboard)
   and script.cookieless.js, which sets no cookies and so needs no consent
   banner. Switch with DATAFAST_SCRIPT=cookieless. */
const SCRIPT = process.env.DATAFAST_SCRIPT === 'cookieless'
  ? 'https://datafa.st/js/script.cookieless.js'
  : 'https://datafa.st/js/script.js';

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
  return `<script defer src="${SCRIPT}" `
       + `data-website-id="${attr(WEBSITE_ID)}" data-domain="${attr(DOMAIN)}"></script>`;
}

/* "see stats" / "Live stats" point at the DataFast public share dashboard
   when one is configured. The fallback is the About page's live figures —
   a real stats page, rather than scrolling to a counter on the same page. */
export function statsHref(){
  return SHARE_URL ? attr(SHARE_URL) : '/about#stats';
}

export function statsTargetAttrs(){
  return SHARE_URL ? ' target="_blank" rel="noopener"' : '';
}

/* Injected config participates in the ETag — otherwise a config change would
   keep serving the previously cached HTML. */
export const analyticsFingerprint = createHash('sha1')
  .update(`${WEBSITE_ID}|${DOMAIN}|${SHARE_URL}|${SCRIPT}|${BRAND}|${THEME}`)
  .digest('hex')
  .slice(0, 8);

/* Copy that should speak the brand's language. A leaderboard of creators
   should not ask for a "product URL". */
const COPY = {
  '': {
    showPlatforms: false,
    minBid: '$5',
    heroVerb: 'Claim',
    cta: 'Outbid',
    inputHint: 'Your product URL or @handle',
    rebidHint: 'Already on the list? Enter the same URL or @handle and up your bid.'
  },
  socialrise: {
    showPlatforms: true,
    minBid: '$1',
    heroVerb: 'Rise to',
    cta: 'Rise',
    inputHint: 'Your @handle or profile link',
    rebidHint: 'Already climbing? Enter the same @handle and raise your bid.'
  }
};

export function renderHtml(html){
  const copy = COPY[THEME] || COPY[''];
  const fonts = FONT_SETS[THEME] || FONT_SETS[''];
  const themeCss = THEME
    ? `\n<link rel="stylesheet" href="/theme-${attr(THEME)}.css" />`
    : '';

  return html
    .replaceAll('%BRAND%', attr(BRAND))
    .replaceAll('%BRAND_SLUG%', attr(THEME || 'base'))
    .replaceAll('%FONTS%', `<link href="${fonts}" rel="stylesheet">`)
    .replaceAll('%THEME_CSS%', themeCss)
    .replaceAll('%PLATFORM_HIDDEN%', copy.showPlatforms ? '' : ' hidden')
    .replaceAll('%MIN_BID%', attr(copy.minBid))
    .replaceAll('%MIN_BID_NUM%', attr(copy.minBid.replace(/[^0-9.]/g, '')))
    .replaceAll('%HERO_VERB%', attr(copy.heroVerb))
    .replaceAll('%CTA%', attr(copy.cta))
    .replaceAll('%INPUT_HINT%', attr(copy.inputHint))
    .replaceAll('%REBID_HINT%', attr(copy.rebidHint))
    .replaceAll('<!--ANALYTICS-->', analyticsTag())
    .replaceAll('%STATS_HREF%', statsHref())
    .replaceAll('%STATS_TARGET%', statsTargetAttrs());
}
