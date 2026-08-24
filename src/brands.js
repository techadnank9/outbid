/* Per-brand rules. A creator board wants a lower barrier than a board of
   funded products, so the floor differs per leaderboard rather than being
   one global constant. */

const DEFAULTS = { minBidCents: 500, maxBidCents: 100_000_00 };

const BRANDS = {
  outbid:     { minBidCents: 500 },
  dethrone:   { minBidCents: 500 },
  socialrise: { minBidCents: 100 }   // $1 — creators start cheap
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
export function maxBidCents(brand){ return brandConfig(brand).maxBidCents; }
