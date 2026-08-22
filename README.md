# outbid

A front-end clone of the [outbid.lol](https://outbid.lol) pay-to-rank leaderboard, built as static
HTML/CSS/JS with no build step and no dependencies.

## What's here

```
index.html    markup
styles.css    design tokens + all styling (light & dark)
app.js        leaderboard data, pagination, bidding, live counters
build.sh      inlines CSS/JS into dist/index.html (single-file build)
```

## Running it

Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 4321
```

Then visit http://localhost:4321.

For a single self-contained file (handy for GitHub Pages or any static host):

```bash
./build.sh
```

This writes `dist/index.html` with the CSS and JS inlined.

## Implemented

- Hero with an inline, steppable bid amount that resizes to its own glyph width
- URL / @handle claim form that computes the rank a given bid would land at
- 871-entry leaderboard with highlighted top 3 and TOP 3 / TOP 10 / TOP 20 dividers
- Pagination (50 per page, 18 pages) with ellipsis and disabled edge states
- Trending and Latest activity panels
- Live online / visitor counters and a rotating activity feed
- Light and dark themes, persisted to `localStorage`
- Responsive down to 375px

## Notes on the data

Listings are **generated placeholder data**, not scraped from outbid.lol — the real board lists
other people's products and their marketing copy. A seeded PRNG (`mulberry32`) keeps the board
stable between renders, and prices follow a log-log interpolation over anchor points sampled from
the real curve, so the shape matches: bids bunch up in the first few spots, then fall away to the
$5 floor by the tail.

There is no backend. The Outbid button shows what rank your bid would take; it does not take
payment.
