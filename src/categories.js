/* Categories, and the classifier that assigns them.

   outbid.lol assigns categories with an LLM. This does it with weighted
   keyword matching over the scraped title, description and domain — which
   needs no API key, costs nothing per bid, and is deterministic, so the
   same listing always lands in the same place. A listing can be moved by
   hand afterwards through the admin endpoint. */

/* Two boards, two vocabularies. Outbid lists products, so its categories
   describe software. SocialRise lists people, so its categories describe
   what someone makes — which is what a viewer actually browses by. */
export const CREATOR_CATEGORIES = [
  { slug: 'health',        name: 'Health & Fitness' },
  { slug: 'wellness',      name: 'Wellness & Mindset' },
  { slug: 'lifestyle',     name: 'Lifestyle & Vlogs' },
  { slug: 'ai-tech',       name: 'AI & Tech' },
  { slug: 'beauty',        name: 'Beauty & Fashion' },
  { slug: 'food',          name: 'Food & Cooking' },
  { slug: 'travel',        name: 'Travel & Adventure' },
  { slug: 'gaming',        name: 'Gaming & Esports' },
  { slug: 'music',         name: 'Music & Audio' },
  { slug: 'comedy',        name: 'Comedy & Entertainment' },
  { slug: 'education',     name: 'Education & Explainers' },
  { slug: 'business',      name: 'Business & Money' },
  { slug: 'art',           name: 'Art & Design' },
  { slug: 'sports',        name: 'Sports & Athletes' },
  { slug: 'film',          name: 'Film & Photography' },
  { slug: 'science',       name: 'Science & Space' },
  { slug: 'news',          name: 'News & Commentary' },
  { slug: 'parenting',     name: 'Family & Parenting' },
  { slug: 'pets',          name: 'Pets & Animals' },
  { slug: 'cars',          name: 'Cars & Motors' },
  { slug: 'home',          name: 'Home & DIY' },
  { slug: 'crypto',        name: 'Crypto & Investing' },
  { slug: 'books',         name: 'Books & Writing' },
  { slug: 'faith',         name: 'Faith & Culture' },
  { slug: 'other',         name: 'Everything Else' }
];

const CREATOR_SIGNALS = {
  health:    ['fitness', 'workout', 'gym', 'training', 'coach', 'nutrition', 'muscle', 'run', 'yoga', 'pilates', 'weight loss'],
  wellness:  ['wellness', 'mindset', 'meditation', 'mental health', 'therapy', 'self care', 'healing', 'mindful', 'journal', 'sleep'],
  lifestyle: ['lifestyle', 'vlog', 'daily', 'day in my life', 'routine', 'minimalism', 'productivity', 'life'],
  'ai-tech': ['ai', 'artificial intelligence', 'tech', 'technology', 'developer', 'coding', 'software', 'startup', 'gadget', 'engineer', 'llm', 'automation'],
  beauty:    ['beauty', 'makeup', 'skincare', 'fashion', 'style', 'outfit', 'hair', 'nails', 'grwm'],
  food:      ['food', 'recipe', 'cooking', 'chef', 'baking', 'restaurant', 'kitchen', 'foodie', 'meal'],
  travel:    ['travel', 'adventure', 'backpack', 'nomad', 'destination', 'wanderlust', 'trip', 'explore'],
  gaming:    ['gaming', 'gamer', 'esports', 'twitch', 'stream', 'speedrun', 'minecraft', 'fortnite', 'valorant', 'playthrough'],
  music:     ['music', 'musician', 'singer', 'producer', 'beats', 'guitar', 'piano', 'dj', 'rapper', 'songwriter'],
  comedy:    ['comedy', 'comedian', 'funny', 'sketch', 'meme', 'humor', 'standup', 'entertainment'],
  education: ['education', 'teacher', 'tutorial', 'explain', 'learn', 'study', 'course', 'lecture', 'exam'],
  business:  ['business', 'entrepreneur', 'founder', 'marketing', 'sales', 'money', 'finance', 'ecommerce', 'side hustle', 'agency'],
  art:       ['art', 'artist', 'illustration', 'design', 'drawing', 'painting', 'animation', 'sculpture', 'creative'],
  sports:    ['sports', 'athlete', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'boxing', 'mma', 'cricket', 'tennis'],
  film:      ['film', 'photography', 'photographer', 'filmmaker', 'cinema', 'camera', 'video', 'director', 'editing'],
  science:   ['science', 'space', 'astronomy', 'physics', 'biology', 'nasa', 'research', 'experiment', 'nature'],
  news:      ['news', 'journalist', 'politics', 'commentary', 'analysis', 'reporter', 'current affairs', 'podcast'],
  parenting: ['parenting', 'mom', 'dad', 'family', 'baby', 'kids', 'toddler', 'pregnancy', 'motherhood'],
  pets:      ['pet', 'dog', 'cat', 'animal', 'puppy', 'kitten', 'wildlife', 'rescue'],
  cars:      ['car', 'cars', 'automotive', 'motor', 'racing', 'drive', 'ev', 'garage', 'motorcycle'],
  home:      ['home', 'diy', 'interior', 'renovation', 'garden', 'decor', 'woodworking', 'build'],
  crypto:    ['crypto', 'bitcoin', 'trading', 'investing', 'stocks', 'web3', 'nft', 'markets', 'portfolio'],
  books:     ['book', 'reading', 'author', 'writing', 'novel', 'poetry', 'booktok', 'literature'],
  faith:     ['faith', 'christian', 'muslim', 'islam', 'bible', 'quran', 'spiritual', 'church', 'culture']
};

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

const SETS = {
  outbid: { list: CATEGORIES, signals: null },        // signals filled in below
  socialrise: { list: CREATOR_CATEGORIES, signals: CREATOR_SIGNALS }
};

export function categoriesFor(brand){
  return (SETS[brand] || SETS.outbid).list;
}

export function categoryMapFor(brand){
  return new Map(categoriesFor(brand).map(c => [c.slug, c]));
}

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map(c => [c.slug, c]));

export function categoryName(slug, brand = 'outbid'){
  return categoryMapFor(brand).get(slug)?.name || 'Everything Else';
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

export function classify({ target, kind, title = '', description = '', brand = 'outbid' }){
  /* On a board of products, an @handle is simply a person and there is no
     more to say. On a creator board every listing is a person, so the
     question is what they make — and the bio is the evidence. */
  if (kind === 'handle' && brand !== 'socialrise') return 'profiles';

  /* A word in the title is far stronger evidence than the same word buried
     in a paragraph — "Agentic Infrastructure" in a title says what the
     product is, where one mention in prose might be incidental. */
  const titleText = String(title).toLowerCase();
  const bodyText = String(description).toLowerCase();
  const domain = String(target || '').toLowerCase();

  const set = SETS[brand] || SETS.outbid;
  const signals = set.signals || SIGNALS;

  let best = null;
  let bestScore = 0;

  for (const { slug } of set.list){
    const terms = signals[slug];
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
