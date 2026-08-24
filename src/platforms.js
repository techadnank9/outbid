/* Which network a creator is on. Inferred from the link where possible,
   and chosen in the form otherwise — a bare @handle does not say whether
   it belongs to TikTok or X. */

export const PLATFORMS = [
  { slug: 'x',         name: 'X',         host: 'x.com',         profile: h => `https://x.com/${h}` },
  { slug: 'instagram', name: 'Instagram', host: 'instagram.com', profile: h => `https://instagram.com/${h}` },
  { slug: 'tiktok',    name: 'TikTok',    host: 'tiktok.com',    profile: h => `https://tiktok.com/@${h}` },
  { slug: 'youtube',   name: 'YouTube',   host: 'youtube.com',   profile: h => `https://youtube.com/@${h}` },
  { slug: 'twitch',    name: 'Twitch',    host: 'twitch.tv',     profile: h => `https://twitch.tv/${h}` },
  { slug: 'linkedin',  name: 'LinkedIn',  host: 'linkedin.com',  profile: h => `https://linkedin.com/in/${h}` },
  { slug: 'reddit',    name: 'Reddit',    host: 'reddit.com',    profile: h => `https://reddit.com/user/${h}` },
  { slug: 'threads',   name: 'Threads',   host: 'threads.net',   profile: h => `https://threads.net/@${h}` },
  { slug: 'facebook',  name: 'Facebook',  host: 'facebook.com',  profile: h => `https://facebook.com/${h}` },
  { slug: 'substack',  name: 'Substack',  host: 'substack.com',  profile: h => `https://${h}.substack.com` },
  { slug: 'web',       name: 'Website',   host: null,            profile: h => `https://${h}` }
];

export const PLATFORM_BY_SLUG = new Map(PLATFORMS.map(p => [p.slug, p]));

/* A pasted profile link already says which network it is. */
export function platformFromUrl(url){
  const host = String(url || '').toLowerCase();
  for (const p of PLATFORMS){
    if (p.host && (host.includes(`//${p.host}`) || host.includes(`.${p.host}`))) return p.slug;
  }
  if (host.includes('twitter.com')) return 'x';
  if (host.includes('youtu.be')) return 'youtube';
  return null;
}

/* On a social platform the person is in the path, not the host — every
   TikTok creator shares tiktok.com. Pull the handle out so each is its own
   listing. Returns null when the URL is not a profile. */
const HANDLE_PATH = {
  x:         /^\/@?([A-Za-z0-9_]{1,30})\/?$/,
  instagram: /^\/@?([A-Za-z0-9_.]{1,30})\/?$/,
  tiktok:    /^\/@([A-Za-z0-9_.]{1,30})\/?$/,
  youtube:   /^\/@([A-Za-z0-9_.-]{1,30})\/?$/,
  twitch:    /^\/([A-Za-z0-9_]{1,30})\/?$/,
  linkedin:  /^\/in\/([A-Za-z0-9_-]{1,60})\/?$/,
  reddit:    /^\/(?:user|u)\/([A-Za-z0-9_-]{1,30})\/?$/,
  threads:   /^\/@([A-Za-z0-9_.]{1,30})\/?$/,
  facebook:  /^\/([A-Za-z0-9_.]{1,50})\/?$/
};

export function handleFromUrl(platform, url){
  try {
    const u = new URL(url);
    if (platform === 'substack'){
      const sub = u.hostname.replace(/\.substack\.com$/i, '');
      return sub && sub !== u.hostname ? sub : null;
    }
    const re = HANDLE_PATH[platform];
    if (!re) return null;
    const m = u.pathname.match(re);
    return m ? m[1] : null;
  } catch { return null; }
}

export function platformName(slug){
  return PLATFORM_BY_SLUG.get(slug)?.name || 'Website';
}

/* Where a listing should link to. A handle needs a platform to resolve. */
export function profileUrl(platform, handle){
  const p = PLATFORM_BY_SLUG.get(platform);
  if (!p) return null;
  return p.profile(handle.replace(/^@/, ''));
}
