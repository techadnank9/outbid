/* Per-brand rules. A creator board wants a lower barrier than a board of
   funded products, so the floor differs per leaderboard rather than being
   one global constant. */

const DEFAULTS = { minBidCents: 500, maxBidCents: 100_000_00, defaultCategory: 'other' };

const BRANDS = {
  outbid:     { minBidCents: 500 },
  dethrone:   { minBidCents: 500 },
  /* $1 — creators start cheap. Where the classifier cannot tell what
     someone makes, they land in AI & Tech rather than Everything Else:
     it is where this board's audience is, and a filled category is more
     useful to a browser than a bucket labelled "other". */
  socialrise: { minBidCents: 100, defaultCategory: 'ai-tech' }
};

/* Env wins, so a floor can be changed without a deploy:
   MIN_BID_CENTS_SOCIALRISE=200 */
export function brandConfig(brand){
  const base = { ...DEFAULTS, ...(BRANDS[brand] || {}) };
  const envKey = `MIN_BID_CENTS_${String(brand || '').toUpperCase()}`;
  const override = Number(process.env[envKey]);
  if (Number.isFinite(override) && override > 0) base.minBidCents = override;
  return base;
}

export function minBidCents(brand){ return brandConfig(brand).minBidCents; }
export function defaultCategory(brand){ return brandConfig(brand).defaultCategory; }
export function maxBidCents(brand){ return brandConfig(brand).maxBidCents; }
