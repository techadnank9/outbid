/* Resolves what a user typed into a canonical listing, then fetches the real
   page to pull its title, description and icon. No placeholder data. */

import { PLATFORM_BY_SLUG, platformFromUrl, profileUrl, handleFromUrl } from './platforms.js';

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512 * 1024;

const UA = process.env.CRAWLER_UA
  || 'Mozilla/5.0 (compatible; outbid-bot/1.0; +https://outbidloll.web.app)';

/* Hosts that must never be fetched — blocks SSRF into the local network. */
function isBlockedHost(host){
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  // IPv4 literals in private / loopback / link-local / CGNAT space
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m){
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export class InputError extends Error {}

/* ── Parse what the user typed ───────────────────────────────── */
export function parseTarget(raw, platform = null){
  const input = String(raw ?? '').trim();
  if (!input) throw new InputError('Enter a product URL or @handle.');
  if (input.length > 400) throw new InputError('That is too long to be a URL or handle.');

  if (input.startsWith('@')){
    const handle = input.slice(1).trim();
    if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)){
      throw new InputError('A handle can only use letters, numbers and underscores.');
    }
    /* A bare @handle says nothing about which network it is on, so the
       platform chosen in the form decides where it links. Handles are
       keyed per platform, so @sam on TikTok and @sam on X are different
       listings rather than fighting over one row. */
    const slug = PLATFORM_BY_SLUG.has(platform) ? platform : 'x';
    return {
      kind: 'handle',
      platform: slug,
      target: `@${handle.toLowerCase()}${slug === 'x' ? '' : `:${slug}`}`,
      url: profileUrl(slug, handle),
      display: '@' + handle
    };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    throw new InputError('That does not look like a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:'){
    throw new InputError('Only http and https URLs are supported.');
  }
  if (!url.hostname.includes('.') || isBlockedHost(url.hostname)){
    throw new InputError('That does not look like a public website.');
  }

  // One listing per hostname — bidding is for the product, not the deep link.
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  /* A profile link is a person, not a website: key it by handle so two
     creators on the same platform are two listings. */
  const urlPlatform = platformFromUrl(url.href);
  if (urlPlatform){
    const handle = handleFromUrl(urlPlatform, url.href);
    if (handle){
      return {
        kind: 'handle',
        platform: urlPlatform,
        target: `@${handle.toLowerCase()}${urlPlatform === 'x' ? '' : `:${urlPlatform}`}`,
        url: profileUrl(urlPlatform, handle),
        display: '@' + handle
      };
    }
  }

  return {
    kind: 'url',
    platform: urlPlatform || 'web',
    target: host,
    url: `${url.protocol}//${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
    display: host
  };
}

/* ── Minimal HTML meta extraction ────────────────────────────── */
function decodeEntities(s){
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
      const t = e.toLowerCase();
      if (t === 'amp') return '&';
      if (t === 'lt') return '<';
      if (t === 'gt') return '>';
      if (t === 'quot') return '"';
      if (t === 'apos' || t === '#39') return "'";
      if (t === 'nbsp') return ' ';
      if (t.startsWith('#x')) return String.fromCodePoint(parseInt(t.slice(2), 16));
      if (t.startsWith('#'))  return String.fromCodePoint(parseInt(t.slice(1), 10));
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, ...names){
  for (const name of names){
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, 'i'
    );
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return '';
}

export function extractMeta(html, baseUrl){
  const title =
    metaContent(html, 'og:title', 'twitter:title') ||
    decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');

  const description = metaContent(html, 'og:description', 'twitter:description', 'description');

  let icon =
    metaContent(html, 'og:image', 'twitter:image') ||
    html.match(/<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]
        ?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || '';

  if (icon){
    try { icon = new URL(decodeEntities(icon), baseUrl).href; } catch { icon = ''; }
  }

  return {
    title: title.slice(0, 120),
    description: description.slice(0, 260),
    iconUrl: icon || null
  };
}

/* ── Fetch the real page ─────────────────────────────────────── */
/* A listing is per-hostname, so if the exact URL the user pasted 404s we fall
   back to the site root rather than giving up on the metadata entirely. */
export async function fetchMetadata(parsed){
  const fallback = {
    title: parsed.display,
    description: '',
    iconUrl: `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(parsed.target.replace(/^@/, 'x.com'))}`
  };

  const candidates = [parsed.url];
  try {
    const root = new URL(parsed.url).origin + '/';
    if (root !== parsed.url && root !== parsed.url + '/') candidates.push(root);
  } catch { /* parsed.url is always valid here, but stay defensive */ }

  for (const candidate of candidates){
    const meta = await scrape(candidate, fallback);
    if (meta) return meta;
  }
  return fallback;
}

async function scrape(target, fallback){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }
    });

    if (!res.ok) return null;
    if (!(res.headers.get('content-type') || '').includes('html')) return null;

    // Cap the read so a huge or endless response can't exhaust memory.
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < MAX_HTML_BYTES){
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});

    const html = Buffer.concat(chunks).toString('utf8');
    const meta = extractMeta(html, res.url);

    return {
      title: meta.title || fallback.title,
      description: meta.description,
      iconUrl: meta.iconUrl || fallback.iconUrl
    };
  } catch {
    // Unreachable sites still get to be listed — just without scraped copy.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
