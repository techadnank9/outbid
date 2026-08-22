/* Categories, and the classifier that assigns them.

   outbid.lol assigns categories with an LLM. This does it with weighted
   keyword matching over the scraped title, description and domain — which
   needs no API key, costs nothing per bid, and is deterministic, so the
   same listing always lands in the same place. A listing can be moved by
   hand afterwards through the admin endpoint. */

export const CATEGORIES = [
  { slug: 'ai-agents',      name: 'AI Agents & Automation' },
  { slug: 'ai-media',       name: 'AI Image, Video & Audio' },
  { slug: 'dev-tools',      name: 'Developer Tools' },
  { slug: 'infrastructure', name: 'Infrastructure & Hosting' },
  { slug: 'seo',            name: 'SEO & Search Visibility' },
  { slug: 'marketing',      name: 'Marketing & Advertising' },
  { slug: 'sales',          name: 'Sales & Outreach' },
  { slug: 'social',         name: 'Social & Creator Tools' },
  { slug: 'writing',        name: 'Writing & Content' },
  { slug: 'design',         name: 'Design & Creative' },
  { slug: 'productivity',   name: 'Productivity & Notes' },
  { slug: 'analytics',      name: 'Analytics & Data' },
  { slug: 'finance',        name: 'Finance, Payments & Legal' },
  { slug: 'ecommerce',      name: 'Ecommerce & Retail' },
  { slug: 'hiring',         name: 'Hiring, Jobs & Careers' },
  { slug: 'education',      name: 'Education & Learning' },
  { slug: 'health',         name: 'Health, Fitness & Wellness' },
  { slug: 'crypto',         name: 'Crypto & Web3' },
  { slug: 'security',       name: 'Security & Privacy' },
  { slug: 'games',          name: 'Games & Entertainment' },
  { slug: 'travel',         name: 'Travel & Local' },
  { slug: 'agencies',       name: 'Agencies & Services' },
  { slug: 'domains',        name: 'Domains & Web Assets' },
  { slug: 'profiles',       name: 'People & Profiles' },
  { slug: 'other',          name: 'Everything Else' }
];

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map(c => [c.slug, c]));

export function categoryName(slug){
  return CATEGORY_BY_SLUG.get(slug)?.name || 'Everything Else';
}

/* Weighted signals. Domain matches count double — a .dev or a name ending
   in "hq" says more about a product than one word buried in a paragraph. */
const SIGNALS = {
  'ai-agents':     ['ai agent', 'agents', 'autonomous', 'copilot', 'assistant', 'llm', 'gpt', 'chatbot', 'workflow automation', 'automate', 'mcp'],
  'ai-media':      ['image generation', 'text to image', 'text to video', 'video generation', 'voice clone', 'avatar', 'thumbnail', 'photo', 'render', 'diffusion', 'upscale'],
  'dev-tools':     ['developer', 'developers', 'api', 'sdk', 'open source', 'github', 'code', 'coding', 'debug', 'ide', 'cli', 'framework', 'library', 'boilerplate', 'component'],
  'infrastructure':['hosting', 'deploy', 'serverless', 'database', 'cloud', 'container', 'kubernetes', 'cdn', 'uptime', 'devops', 'infrastructure'],
  'seo':           ['seo', 'backlink', 'ranking', 'serp', 'keyword', 'search visibility', 'organic traffic', 'domain authority', 'indexing'],
  'marketing':     ['marketing', 'ads', 'advertising', 'campaign', 'growth', 'brand', 'audience', 'newsletter', 'email marketing', 'funnel'],
  'sales':         ['sales', 'lead', 'crm', 'outreach', 'prospect', 'cold email', 'pipeline', 'deal', 'b2b'],
  'social':        ['social media', 'instagram', 'tiktok', 'twitter', 'linkedin', 'reddit', 'creator', 'influencer', 'posting', 'scheduling', 'ugc'],
  'writing':       ['writing', 'writer', 'blog', 'content', 'copywriting', 'article', 'editor', 'grammar', 'documentation', 'notes app'],
  'design':        ['design', 'figma', 'ui kit', 'template', 'font', 'icon', 'illustration', 'mockup', 'branding', 'logo'],
  'productivity':  ['productivity', 'todo', 'task', 'calendar', 'notes', 'habit', 'focus', 'time tracking', 'project management', 'knowledge base'],
  'analytics':     ['analytics', 'dashboard', 'metrics', 'tracking', 'insight', 'reporting', 'data', 'visualization', 'telemetry', 'ab test'],
  'finance':       ['invoice', 'accounting', 'bookkeeping', 'payment', 'billing', 'tax', 'payroll', 'banking', 'bank', 'loan', 'legal', 'contract', 'llc', 'financial', 'finance', 'money', 'revenue', 'subscription billing'],
  'ecommerce':     ['ecommerce', 'shopify', 'store', 'checkout', 'dropship', 'product photo', 'inventory', 'retail', 'marketplace', 'shipping'],
  'hiring':        ['hiring', 'recruit', 'job board', 'resume', 'cv', 'candidate', 'interview', 'talent', 'freelancer', 'staffing'],
  'education':     ['course', 'learn', 'tutorial', 'education', 'student', 'teaching', 'flashcard', 'exam', 'school', 'bootcamp'],
  'health':        ['fitness', 'workout', 'health', 'calorie', 'nutrition', 'sleep', 'meditation', 'mental health', 'wellness', 'therapy', 'peptide', 'supplement'],
  'crypto':        ['crypto', 'blockchain', 'web3', 'token', 'nft', 'wallet', 'defi', 'solana', 'ethereum', 'bitcoin', 'stablecoin', 'trading'],
  'security':      ['security', 'privacy', 'encryption', 'vpn', 'password', 'auth', 'soc 2', 'gdpr', 'pentest', 'vulnerability', 'compliance'],
  'games':         ['game', 'gaming', 'puzzle', 'play', 'multiplayer', 'steam', 'entertainment', 'streaming', 'movie', 'music'],
  'travel':        ['travel', 'flight', 'hotel', 'trip', 'booking', 'restaurant', 'local', 'map', 'itinerary', 'city guide'],
  'agencies':      ['agency', 'consultancy', 'studio', 'freelance service', 'done for you', 'we build', 'our team', 'clients'],
  'domains':       ['domain', 'brandable', 'namecheap', 'tld', 'website builder', 'landing page builder', 'hosting plan'],
  'profiles':      []   // handled structurally, not by keyword
};

/* Longer phrases are stronger evidence than single common words. */
function weightFor(term){
  return term.includes(' ') ? 3 : 1;
}

/* Substring matching is not safe here: "stripe" contains "trip", "important"
   contains "map", "broadside" contains "ads". Match whole words only. */
const boundaryCache = new Map();
function wordRe(term){
  let re = boundaryCache.get(term);
  if (!re){
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Tolerate a plural: "payments" must match the signal "payment".
    re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:e?s)?(?:[^a-z0-9]|$)`, 'i');
    boundaryCache.set(term, re);
  }
  return re;
}

/* A domain has no spaces, so "devtools.com" should still match "dev tools".
   Split it into tokens and test the collapsed form against each. */
function domainMatches(domain, term){
  const collapsed = term.replace(/\s+/g, '');
  return domain.split(/[^a-z0-9]+/)
    .some(tok => tok === collapsed || tok === collapsed + 's');
}

export function classify({ target, kind, title = '', description = '' }){
  // An @handle is a person, whatever their bio happens to mention.
  if (kind === 'handle') return 'profiles';

  /* A word in the title is far stronger evidence than the same word buried
     in a paragraph — "Agentic Infrastructure" in a title says what the
     product is, where one mention in prose might be incidental. */
  const titleText = String(title).toLowerCase();
  const bodyText = String(description).toLowerCase();
  const domain = String(target || '').toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const { slug } of CATEGORIES){
    const terms = SIGNALS[slug];
    if (!terms?.length) continue;

    let score = 0;
    for (const term of terms){
      const w = weightFor(term);
      const re = wordRe(term);
      if (re.test(titleText)) score += w * 2;
      if (re.test(bodyText)) score += w;
      if (domainMatches(domain, term)) score += w * 2;
    }
    if (score > bestScore){ bestScore = score; best = slug; }
  }

  // One weak single-word hit is not enough to claim a category.
  return bestScore >= 2 ? best : 'other';
}
