/* outbid.lol — leaderboard clone
   Client-side demo: all listings are generated placeholder data. */

const PER_PAGE = 50;
const TOTAL = 871;

/* ── Deterministic RNG so the board is stable between renders ── */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ── Placeholder listing pool ─────────────────────── */
const WORDS_A = ['nova','orbit','lumen','drift','ember','quartz','vellum','saffra','pivot','kite','halcy','tundra','mirage','onyx','pilot','lattice','corvid','ripple','zenith','marlin','cobalt','fern','stellar','harbor','vector','plume','cinder','tally','moss','glide','runic','pique','solstice','beacon','arbor','flint','opal','tessel','walden','yarn'];
const WORDS_B = ['ly','ify','base','kit','hq','flow','loop','labs','deck','stack','forge','wave','desk','grid','pad','box','sync','mint','port','node'];
const TLDS = ['.com','.ai','.io','.dev','.so','.app','.co','.lol','.sh','.xyz'];
const BLURBS = [
  'Turn scattered notes into a searchable knowledge base your whole team actually uses.',
  'Ship background jobs without managing queues. Write a function, get retries and observability.',
  'A calmer inbox. Bundles newsletters, drafts replies, and clears the noise before you wake up.',
  'Track every subscription in one place and cancel the ones you forgot about.',
  'Design tokens that stay in sync between Figma and your codebase, automatically.',
  'Analytics without cookies. One script, no consent banner, numbers you can trust.',
  'Give your app a changelog page in five minutes and email users when you ship.',
  'Automated screenshot testing that flags visual regressions before your users do.',
  'Self-hosted status pages with incident timelines, SLA reporting, and Slack alerts.',
  'Rent GPUs by the minute. Spin up a training run and only pay while it runs.',
  'Invoicing built for freelancers: quotes, contracts, reminders, and taxes in one flow.',
  'A pocket-sized habit tracker with no accounts, no ads, and no cloud sync.',
  'Turn any long video into short vertical clips with captions, ready to post.',
  'Monitor your competitors pricing pages and get a diff whenever anything changes.',
  'Onboarding checklists you can drop into any product with a single component.',
  'Search across every doc, ticket, and thread your company has ever written.',
  'Schedule posts to every network at once and see what actually drove signups.',
  'Turn customer interviews into structured insight your product team can act on.',
  'Deploy preview environments for every pull request, torn down automatically.',
  'A tiny CRM for people who hate CRMs. Contacts, notes, follow-ups. That is it.',
  'Feature flags with instant rollback and per-user targeting, no SDK bloat.',
  'Read receipts and analytics for the PDFs you send to investors.',
  'Bookkeeping that reconciles itself and hands your accountant a clean ledger.',
  'Weekly digests of every open-source release your stack depends on.',
  'Voice notes in, clean documentation out. Built for teams that hate writing docs.',
  'The fastest way to add auth, billing, and teams to a new SaaS project.',
  'Uptime checks from twelve regions with alerting that respects your sleep schedule.',
  'Run SQL against your production data safely with masked columns and audit logs.',
  'Turn spreadsheets into internal tools your ops team can actually use.',
  'Localize your app into thirty languages and keep translations in sync as you ship.'
];
const HANDLES = ['@buildinpublic','@shipfast_dev','@indiehacker','@sarah_builds','@nightowl_eng','@pixelpusher','@devtoolsdaily','@thesolofounder','@growthnerd','@makerlog'];
const AGES = ['3 minutes ago','12 minutes ago','41 minutes ago','1 hour ago','2 hours ago','5 hours ago','9 hours ago','13 hours ago','16 hours ago','20 hours ago','yesterday','yesterday','2 days ago'];

const GRADIENTS = [
  ['#f97316','#ef4444'],['#8b5cf6','#6366f1'],['#ec4899','#f97316'],['#06b6d4','#3b82f6'],
  ['#22c55e','#14b8a6'],['#eab308','#f97316'],['#6366f1','#ec4899'],['#0ea5e9','#8b5cf6'],
  ['#f43f5e','#f59e0b'],['#10b981','#0ea5e9'],['#a855f7','#d946ef'],['#64748b','#1e293b']
];

/* Prices follow a power law from the top bid down to the $5 floor:
   steep through the first few ranks, then a long flat tail. */
/* Anchors are price-as-a-fraction-of-the-top-bid at a given rank, taken from
   the real curve: bids bunch up in the first few spots, then fall away fast. */
const ANCHORS = [
  [1, 1],      [2, 0.928],  [3, 0.907],  [5, 0.713],
  [10, 0.223], [20, 0.089], [50, 0.022], [100, 0.0080],
  [300, 0.0025], [871, 0.000357]
];

function priceAtRank(rank, top){
  let lo = ANCHORS[0], hi = ANCHORS[ANCHORS.length - 1];
  for (let i = 0; i < ANCHORS.length - 1; i++){
    if (rank >= ANCHORS[i][0] && rank <= ANCHORS[i + 1][0]){
      lo = ANCHORS[i]; hi = ANCHORS[i + 1]; break;
    }
  }
  // Log-log interpolation keeps the curve smooth across three orders of magnitude.
  const t = lo[0] === hi[0] ? 0
    : (Math.log(rank) - Math.log(lo[0])) / (Math.log(hi[0]) - Math.log(lo[0]));
  const frac = Math.exp(Math.log(lo[1]) + t * (Math.log(hi[1]) - Math.log(lo[1])));
  return Math.max(5, Math.round(top * frac));
}

function buildBoard(topBid){
  const rnd = mulberry32(20260822);
  const items = [];
  for (let i = 0; i < TOTAL; i++){
    // Nudge each price slightly, then re-sort — keeps the curve organic.
    const price = Math.max(5, Math.round(priceAtRank(i + 1, topBid) * (0.94 + rnd() * 0.12)));
    const isHandle = rnd() < 0.07;
    const name = isHandle
      ? HANDLES[Math.floor(rnd() * HANDLES.length)]
      : WORDS_A[Math.floor(rnd() * WORDS_A.length)]
        + (rnd() < 0.45 ? WORDS_B[Math.floor(rnd() * WORDS_B.length)] : '')
        + TLDS[Math.floor(rnd() * TLDS.length)];

    items.push({
      name,
      isHandle,
      price,
      desc: rnd() < 0.9 ? BLURBS[Math.floor(rnd() * BLURBS.length)] : '',
      age: AGES[Math.floor(rnd() * AGES.length)],
      clicks: Math.floor(rnd() * (i < 20 ? 12000 : 1400)) + 14,
      grad: GRADIENTS[Math.floor(rnd() * GRADIENTS.length)]
    });
  }
  items.sort((a, b) => b.price - a.price);
  items[0].price = topBid - 5;
  return items;
}

/* ── State ────────────────────────────────────────── */
let topBid = 14018;
let board = buildBoard(topBid);
let page = 1;

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');

/* ── Rendering ────────────────────────────────────── */
function gradientStyle(g){
  return `background:linear-gradient(135deg,${g[0]},${g[1]})`;
}
function initial(name){
  return name.replace(/^@/, '').charAt(0).toUpperCase();
}

function renderBoard(){
  const start = (page - 1) * PER_PAGE;
  const slice = board.slice(start, start + PER_PAGE);
  const host = $('boardRows');
  let html = '';

  slice.forEach((item, i) => {
    const rank = start + i + 1;
    const top3 = rank <= 3;
    html += `
      <div class="row${top3 ? ' top' : ''}">
        <div class="rank">#${rank}</div>
        <div class="row-avatar" style="${gradientStyle(item.grad)}">${initial(item.name)}</div>
        <div class="row-main">
          <div class="row-name">${item.name}</div>
          ${item.desc ? `<p class="row-desc">${item.desc}</p>` : ''}
          <div class="row-meta">
            <span>${item.age}</span>
            <span class="clicks">${fmt(item.clicks)} clicks</span>
          </div>
        </div>
        <div class="row-right">
          <div class="row-price">$${fmt(item.price)}</div>
          <div class="row-claim">claim this rank for $${fmt(item.price + 1)}</div>
        </div>
      </div>`;

    if (rank === 3)  html += divider('TOP 3');
    if (rank === 10) html += divider('TOP 10');
    if (rank === 20) html += divider('TOP 20');
  });

  host.innerHTML = html;
  $('rangeLabel').textContent = `${start + 1} - ${Math.min(start + PER_PAGE, TOTAL)} of ${fmt(TOTAL)}`;
  renderPagination();
}

function divider(label){
  return `<div class="divider"><span>${label}</span></div>`;
}

function renderPagination(){
  const pages = Math.ceil(TOTAL / PER_PAGE);
  const nums = [];
  if (pages <= 7){
    for (let i = 1; i <= pages; i++) nums.push(i);
  } else if (page <= 4){
    nums.push(1, 2, 3, 4, '…', pages);
  } else if (page >= pages - 3){
    nums.push(1, '…', pages - 3, pages - 2, pages - 1, pages);
  } else {
    nums.push(1, '…', page - 1, page, page + 1, '…', pages);
  }

  $('pageNums').innerHTML = nums.map(n =>
    n === '…'
      ? `<span class="page-ellipsis">…</span>`
      : `<button class="page-num${n === page ? ' active' : ''}" data-page="${n}">${n}</button>`
  ).join('');

  $('prevPage').disabled = page === 1;
  $('nextPage').disabled = page === pages;
}

function renderPanels(){
  const trending = [...board.slice(0, 40)]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);

  $('trendingList').innerHTML = trending.map(it => `
    <li>
      <span class="avatar" style="${gradientStyle(it.grad)}">${initial(it.name)}</span>
      <span class="name">${it.name}</span>
      <span class="clicks">${fmt(Math.round(it.clicks / 8))} clicks/h</span>
    </li>`).join('');

  renderActivity();
}

const ACTIVITY_AGES = ['1 minute ago','5 minutes ago','6 minutes ago','8 minutes ago','9 minutes ago'];
function renderActivity(){
  const rnd = mulberry32(Math.floor(Date.now() / 60000));
  const items = Array.from({length: 5}, (_, i) => {
    const idx = 120 + Math.floor(rnd() * (TOTAL - 130));
    const it = board[idx];
    return `
      <li>
        <span class="avatar" style="${gradientStyle(it.grad)}">${initial(it.name)}</span>
        <span class="name">${it.name} <span class="meta">at #${idx + 1} · $${fmt(it.price)}</span></span>
        <span class="meta">${ACTIVITY_AGES[i]}</span>
      </li>`;
  });
  $('activityList').innerHTML = items.join('');
}

/* ── Bid control ──────────────────────────────────── */
function setBid(v){
  topBid = Math.max(5, Math.min(999999, v));
  $('bidInput').value = topBid;
  sizeBidInput();
}
/* `ch` is far wider than a DM Sans digit advance, so size to the intrinsic
   content width — which also accounts for the negative letter-spacing. */
function sizeBidInput(){
  const el = $('bidInput');
  el.style.width = '0';
  el.style.width = el.scrollWidth + 2 + 'px';
}
/* The heading font-size is clamped to the viewport, and the webfont lands
   after first paint — re-measure on both. */
addEventListener('resize', sizeBidInput);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeBidInput);

$('stepUp').addEventListener('click', () => setBid(topBid + 1));
$('stepDown').addEventListener('click', () => setBid(topBid - 1));
$('bidInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  topBid = Number(e.target.value) || 0;
  sizeBidInput();
});
$('bidInput').addEventListener('blur', () => setBid(Number($('bidInput').value) || 5));

/* ── Claim form ───────────────────────────────────── */
$('urlInput').addEventListener('input', (e) => {
  $('outbidBtn').disabled = e.target.value.trim().length === 0;
});

$('claimForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('urlInput').value.trim();
  if (!value) return;

  const rank = board.findIndex(it => topBid >= it.price) + 1 || board.length + 1;
  toast(`${value} would land at #${rank} for $${fmt(topBid)} — checkout is not wired up in this demo.`);
});

/* ── Toast ────────────────────────────────────────── */
let toastTimer;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

/* ── Pagination events ────────────────────────────── */
$('pageNums').addEventListener('click', (e) => {
  const btn = e.target.closest('.page-num');
  if (!btn) return;
  page = Number(btn.dataset.page);
  renderBoard();
  document.getElementById('leaderboard').scrollIntoView({behavior: 'smooth', block: 'start'});
});
$('prevPage').addEventListener('click', () => { if (page > 1){ page--; renderBoard(); } });
$('nextPage').addEventListener('click', () => {
  if (page < Math.ceil(TOTAL / PER_PAGE)){ page++; renderBoard(); }
});

$('refreshBtn').addEventListener('click', () => {
  const btn = $('refreshBtn');
  btn.classList.add('spinning');
  setTimeout(() => {
    btn.classList.remove('spinning');
    renderActivity();
    toast('Leaderboard refreshed');
  }, 700);
});

/* ── Live counters ────────────────────────────────── */
let online = 671;
let visitors = 1148077;
setInterval(() => {
  online = Math.max(400, online + Math.round((Math.random() - 0.5) * 12));
  visitors += Math.floor(Math.random() * 4);
  $('onlineCount').textContent = `${fmt(online)} online`;
  $('visitorCount').textContent = fmt(visitors);
}, 3000);

setInterval(renderActivity, 45000);

/* ── Theme ────────────────────────────────────────── */
/* localStorage throws in sandboxed frames and data: URLs — never let it
   take the rest of the page down with it. */
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch {} }
};

const saved = store.get('theme');
if (saved) document.documentElement.dataset.theme = saved;
else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';

$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
});

/* ── Boot ─────────────────────────────────────────── */
setBid(board[0].price + 5);
renderBoard();
renderPanels();
