/* outbid — frontend. Every number on this page comes from the API. */

/* Empty means same-origin (local dev, or backend serving the frontend).
   A split deploy (static on Firebase, API on Render) sets this to the API
   origin at build time. */
const API_BASE = (window.__CONFIG__?.apiBase || '').replace(/\/$/, '');
const url = (path) => API_BASE + path;

/* The visitor id lives client-side because a cross-origin API cannot set a
   usable cookie — browsers block third-party cookies. */
const VISITOR_ID = (() => {
  const KEY = 'outbid_vid';
  try {
    let id = localStorage.getItem(KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)){
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();   // private mode: counted as a new visitor
  }
})();

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

async function api(path, options){
  const res = await fetch(url(path), {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-visitor-id': VISITOR_ID,
      ...options?.headers
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ── Relative time ────────────────────────────────────────────── */
function ago(ts){
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60)     return s === 1 ? '1 second ago' : `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60)     return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24)     return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d === 1)    return 'yesterday';
  return `${d} days ago`;
}

function durationSince(ts){
  const h = Math.floor((Date.now() - ts) / 3600_000);
  if (h < 1)  return 'less than an hour';
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

let promo = null;   // the validated promo code, or null

/* ── State ────────────────────────────────────────────────────── */
let state = {
  page: 1,
  pages: 1,
  total: 0,
  stats: null,
  bidEdited: false,  // stop overwriting the field once the user types in it
  category: new URLSearchParams(location.search).get('category') || null
};

/* ── Avatars ──────────────────────────────────────────────────── */
/* Real favicons, with a deterministic colour block as the fallback so a
   listing whose icon 404s still looks intentional. */
const FALLBACK_HUES = [12, 28, 45, 140, 175, 205, 232, 258, 290, 320, 345];
function hueFor(target){
  let h = 0;
  for (let i = 0; i < target.length; i++) h = (h * 31 + target.charCodeAt(i)) >>> 0;
  return FALLBACK_HUES[h % FALLBACK_HUES.length];
}
function avatar(item, cls){
  const letter = item.target.replace(/^@/, '').charAt(0).toUpperCase();
  const hue = hueFor(item.target);
  const style = `background:linear-gradient(135deg,hsl(${hue} 72% 58%),hsl(${(hue + 38) % 360} 70% 48%))`;
  const img = item.icon
    ? `<img src="${escapeAttr(item.icon)}" alt="" loading="lazy"
            onerror="this.remove()" />`
    : '';
  return `<span class="${cls}" style="${style}">${letter}${img}</span>`;
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const escapeAttr = escapeHtml;

/* ── Board ────────────────────────────────────────────────────── */
async function loadBoard(page = state.page){
  const host = $('boardRows');
  host.setAttribute('aria-busy', 'true');

  try {
    const q = new URLSearchParams({ page });
    if (state.category) q.set('category', state.category);
    const data = await api(`/api/board?${q}`);
    state.page = data.page;
    state.pages = data.pages;
    state.total = data.total;

    renderCategoryBanner(data);

    if (!data.items.length){
      host.innerHTML = state.category
        ? `<div class="empty">
             <p class="empty-title">Nothing in this category yet.</p>
             <p class="empty-sub">$5 takes #1 here. <a href="/categories">Browse other categories</a>.</p>
           </div>`
        : `<div class="empty">
             <p class="empty-title">Nobody has claimed a spot yet.</p>
             <p class="empty-sub">The board is empty. The first bid takes #1.</p>
           </div>`;
      $('rangeLabel').textContent = '';
      $('pagination').hidden = true;
      return;
    }

    $('pagination').hidden = false;
    host.innerHTML = data.items.map(rowHtml).join('');

    const start = (data.page - 1) * data.perPage + 1;
    const end = start + data.items.length - 1;
    $('rangeLabel').textContent = `${fmtInt(start)} - ${fmtInt(end)} of ${fmtInt(data.total)}`;
    renderPagination();
  } catch (err){
    host.innerHTML = `<div class="empty"><p class="empty-title">Could not load the board.</p>
      <p class="empty-sub">${escapeHtml(err.message)}</p></div>`;
  } finally {
    host.removeAttribute('aria-busy');
  }
}

function renderCategoryBanner(data){
  const el = $('categoryBanner');
  if (!el) return;
  if (!state.category){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <span>Showing <strong>${escapeHtml(data.categoryName || state.category)}</strong>
      — ${fmtInt(data.total)} ${data.total === 1 ? 'listing' : 'listings'}</span>
    <a href="/">Show the whole board →</a>`;
}

function rowHtml(item){
  const top3 = item.rank <= 3;
  const dividers = { 3: 'TOP 3', 10: 'TOP 10', 20: 'TOP 20' };
  const divider = dividers[item.rank]
    ? `<div class="divider"><span>${dividers[item.rank]}</span></div>` : '';

  return `
    <a class="row${top3 ? ' top' : ''}" href="${url(`/r/${item.id}`)}" target="_blank" rel="noopener nofollow">
      <div class="rank">#${item.rank}</div>
      ${avatar(item, 'row-avatar')}
      <div class="row-main">
        <div class="row-name">${escapeHtml(item.target)}</div>
        ${item.description ? `<p class="row-desc">${escapeHtml(item.description)}</p>` : ''}
        <div class="row-meta">
          <span>${ago(item.since)}</span>
          <span class="clicks">${fmtInt(item.clicks)} clicks</span>
          ${item.category && !state.category
            ? `<span class="row-category">${categoryIcon(item.category)}${escapeHtml(item.categoryName)}</span>`
            : ''}
        </div>
      </div>
      <div class="row-right">
        <div class="row-price">${fmtMoney(item.price)}</div>
        <div class="row-claim">claim this rank for ${fmtMoney(item.claimPrice)}</div>
      </div>
    </a>` + divider;
}

function renderPagination(){
  const { page, pages } = state;
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
      ? '<span class="page-ellipsis">…</span>'
      : `<button class="page-num${n === page ? ' active' : ''}" data-page="${n}">${n}</button>`
  ).join('');

  $('prevPage').disabled = page === 1;
  $('nextPage').disabled = page === pages;
}

/* ── Panels ───────────────────────────────────────────────────── */
async function loadPanels(){
  const [trend, activity] = await Promise.allSettled([
    api('/api/trending'), api('/api/activity')
  ]);

  if (trend.status === 'fulfilled'){
    const items = trend.value.items;
    $('trendingList').innerHTML = items.length
      ? items.map(it => `
          <li>
            <a class="panel-link" href="${url(`/r/${it.id}`)}" target="_blank" rel="noopener nofollow">
              ${avatar(it, 'avatar')}<span class="name">${escapeHtml(it.target)}</span>
            </a>
            <span class="clicks">${fmtInt(it.perHour)} clicks/h</span>
          </li>`).join('')
      : '<li class="panel-empty">No clicks in the last hour yet.</li>';
  }

  if (activity.status === 'fulfilled'){
    const items = activity.value.items;
    $('activityList').innerHTML = items.length
      ? items.map(it => `
          <li>
            <a class="panel-link" href="${url(`/r/${it.id}`)}" target="_blank" rel="noopener nofollow">
              ${avatar(it, 'avatar')}
              <span class="name">${escapeHtml(it.target)}
                <span class="meta">at #${it.rank} · ${fmtMoney(it.price)}</span>
              </span>
            </a>
            <span class="meta">${ago(it.at)}</span>
          </li>`).join('')
      : '<li class="panel-empty">No bids yet.</li>';
  }
}

/* ── Categories ───────────────────────────────────────────────── */
let categories = [];

async function loadCategories(){
  try {
    categories = (await api('/api/categories')).items;
  } catch { return; }

  renderPickerMenu();
  renderTabs();
}

/* ── Category picker (custom, so each option can carry its icon) ── */
let chosenCategory = '';

function renderPickerMenu(){
  const menu = $('catPickerMenu');
  if (!menu) return;
  menu.innerHTML = categories.map(c => `
    <button type="button" role="option" class="cat-option${chosenCategory === c.slug ? ' selected' : ''}"
            data-slug="${c.slug}" aria-selected="${chosenCategory === c.slug}">
      ${categoryIcon(c.slug)}<span>${escapeHtml(c.name)}</span>
    </button>`).join('');
}

function setChosenCategory(slug, byUser){
  chosenCategory = slug || '';
  const label = $('catPickerLabel');
  const found = categories.find(c => c.slug === chosenCategory);
  if (label){
    label.innerHTML = found
      ? `${categoryIcon(found.slug)}<span>${escapeHtml(found.name)}</span>`
      : 'Choose a category';
    label.classList.toggle('placeholder', !found);
  }
  if (byUser) $('catPicker')?.setAttribute('data-touched', '1');
  renderPickerMenu();
}

function openPicker(open){
  const menu = $('catPickerMenu');
  const btn = $('catPickerBtn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

$('catPickerBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openPicker($('catPickerMenu').hidden);
});

$('catPickerMenu')?.addEventListener('click', (e) => {
  const opt = e.target.closest('.cat-option');
  if (!opt) return;
  setChosenCategory(opt.dataset.slug, true);
  openPicker(false);
});

// Clicking away or pressing Escape closes it, like a native select.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#catPicker')) openPicker(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') openPicker(false);
});

/* Busiest categories first, so the tabs lead with where the action is
   rather than with an arbitrary alphabetical order. */
function renderTabs(){
  const tabs = $('categoryTabs');
  if (!tabs) return;

  const ordered = [...categories].sort((a, b) =>
    b.listings - a.listings || a.name.localeCompare(b.name));

  tabs.innerHTML =
    `<button class="cat-tab${!state.category ? ' active' : ''}" data-slug="">
       ${categoryIcon('__all')}All
     </button>`
    + ordered.map(c => `
        <button class="cat-tab${state.category === c.slug ? ' active' : ''}" data-slug="${c.slug}">
          ${categoryIcon(c.slug)}${escapeHtml(c.name)}${c.listings ? `<span class="cat-tab-count">${c.listings}</span>` : ''}
        </button>`).join('');

  const active = tabs.querySelector('.cat-tab.active');
  if (active && state.category) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

$('categoryTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-tab');
  if (!btn) return;
  state.category = btn.dataset.slug || null;

  // Keep the URL shareable without reloading the page.
  const url = new URL(location.href);
  if (state.category) url.searchParams.set('category', state.category);
  else url.searchParams.delete('category');
  history.replaceState({}, '', url);

  renderTabs();
  loadBoard(1);
});

/* ── Stats ────────────────────────────────────────────────────── */
async function loadStats(){
  try {
    const s = await api('/api/stats');
    state.stats = s;

    $('onlineCount').textContent  = `${fmtInt(s.online)} online`;
    $('visitorCount').textContent = fmtInt(s.visitors);
    $('revenueAmount').textContent = fmtInt(Math.round(s.revenue));
    $('launchAge').textContent = durationSince(s.launchedAt);

    // A promo fixes the price, so the periodic refresh must not reset it.
    if (!state.bidEdited && !promo) setBid(s.nextBid);

    $('minBid').textContent = fmtMoney(s.minBid);
    document.body.classList.toggle('dev-payments', s.payments === 'dev');
  } catch { /* counters simply hold their last value */ }
}

/* ── Bid control ──────────────────────────────────────────────── */
function currentBid(){
  return Number($('bidInput').value) || 0;
}
function setBid(dollars){
  $('bidInput').value = Math.max(0, Math.round(dollars));
  sizeBidInput();
}
/* `ch` is far wider than a DM Sans digit, so size to intrinsic content width —
   which also accounts for the heading's negative letter-spacing. */
function sizeBidInput(){
  const el = $('bidInput');
  el.style.width = '0';
  el.style.width = el.scrollWidth + 2 + 'px';
}
addEventListener('resize', sizeBidInput);
if (document.fonts?.ready) document.fonts.ready.then(sizeBidInput);

$('stepUp').addEventListener('click', () => { state.bidEdited = true; setBid(currentBid() + 1); previewSoon(); });
$('stepDown').addEventListener('click', () => { state.bidEdited = true; setBid(Math.max(1, currentBid() - 1)); previewSoon(); });

$('bidInput').addEventListener('input', (e) => {
  state.bidEdited = true;
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 7);
  sizeBidInput();
  previewSoon();
});

/* ── Live preview of what a bid would buy ─────────────────────── */
let previewTimer;
let previewSeq = 0;

function previewSoon(){
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 500);
}

/* Bumping the sequence invalidates any lookup still in flight, so a slow
   response can't repopulate the box after we've cleared it. */
function cancelPreview(){
  clearTimeout(previewTimer);
  previewSeq++;
  $('preview').hidden = true;
}

async function runPreview(){
  const target = $('urlInput').value.trim();
  const box = $('preview');

  if (!target){ cancelPreview(); return; }

  const seq = ++previewSeq;
  box.hidden = false;
  box.className = 'preview loading';
  box.innerHTML = '<span class="spinner"></span> Checking…';

  try {
    const data = await api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ target, amount: currentBid() })
    });
    if (seq !== previewSeq) return;   // a newer lookup already won

    if (!$('catPicker')?.dataset.touched && data.category) setChosenCategory(data.category, false);

    const warn = data.alreadyListed && !data.beatsCurrent;
    box.className = 'preview' + (warn ? ' warn' : '');
    box.innerHTML = `
      ${avatar({ target: data.target, icon: data.icon }, 'avatar')}
      <div class="preview-main">
        <div class="preview-title">${escapeHtml(data.title || data.target)}</div>
        ${data.description ? `<div class="preview-desc">${escapeHtml(data.description)}</div>` : ''}
      </div>
      <div class="preview-rank">
        ${warn
          ? `already at ${fmtMoney(data.currentPrice)} — bid ${fmtMoney(data.minimum)}+`
          : `lands at <strong>#${data.rank}</strong>`}
      </div>`;
  } catch (err){
    if (seq !== previewSeq) return;
    box.className = 'preview warn';
    box.textContent = err.message;
  }
}

$('urlInput').addEventListener('input', (e) => {
  $('outbidBtn').disabled = e.target.value.trim().length === 0;
  previewSoon();
});

/* ── Promo codes ──────────────────────────────────────────────── */

$('promoToggle')?.addEventListener('click', () => {
  const entry = $('promoEntry');
  entry.hidden = !entry.hidden;
  $('promoToggle').hidden = !entry.hidden ? true : false;
  if (!entry.hidden) $('promoInput').focus();
});

let promoTimer;
$('promoInput')?.addEventListener('input', () => {
  clearTimeout(promoTimer);
  promoTimer = setTimeout(checkPromo, 400);
});

async function checkPromo(){
  const code = $('promoInput').value.trim();
  const status = $('promoStatus');
  promo = null;

  if (!code){ status.textContent = ''; status.className = 'promo-status'; syncBidForPromo(); return; }

  try {
    const res = await api(`/api/promo?code=${encodeURIComponent(code)}`);
    if (res.valid){
      promo = res;
      status.className = 'promo-status ok';
      status.textContent = `Free listing — ${fmtInt(res.remaining)} of ${fmtInt(res.total)} left`;
    } else {
      status.className = 'promo-status bad';
      status.textContent = res.reason === 'exhausted'
        ? 'All claimed — this code is finished'
        : 'Not a valid code';
    }
  } catch {
    status.className = 'promo-status bad';
    status.textContent = 'Could not check that code';
  }
  syncBidForPromo();
  previewSoon();
}

/* A valid code fixes the price, so the bid stepper would be misleading. */
function syncBidForPromo(){
  const wrap = $('bidInput')?.closest('.bid-control');
  if (!wrap) return;
  wrap.classList.toggle('locked', Boolean(promo));
  if (promo) setBid(promo.amount);
  $('outbidBtn').textContent = promo ? 'Claim free' : 'Outbid';
}

/* ── Placing a bid ────────────────────────────────────────────── */
$('claimForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = $('urlInput').value.trim();
  if (!target) return;

  const btn = $('outbidBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  const label = btn.textContent;
  btn.textContent = 'Working…';

  try {
    const data = await api('/api/bid', {
      method: 'POST',
      body: JSON.stringify({
        target,
        amount: currentBid(),
        category: chosenCategory || undefined,
        promo: promo ? $('promoInput').value.trim() : undefined
      })
    });

    if (data.status === 'checkout'){
      goal('checkout_started', { target: data.target, rank: data.rank });
      window.location.href = data.checkoutUrl;   // real Stripe Checkout
      return;
    }

    goal('bid_confirmed', { target: data.target, rank: data.rank, amount: data.amount });
    toast(data.promo
      ? `${data.target} is live at #${data.rank} — free with ${data.promo}. ${fmtInt(data.remaining)} left.`
      : `${data.target} is live at #${data.rank} for ${fmtMoney(data.amount)}.`);
    $('urlInput').value = '';
    cancelPreview();
    state.bidEdited = false;
    setChosenCategory('', false);
    $('catPicker')?.removeAttribute('data-touched');
    if (promo){
      $('promoInput').value = '';
      promo = null;
      $('promoStatus').textContent = '';
      syncBidForPromo();
    }
    await refreshAll();
  } catch (err){
    toast(err.message, true);
  } finally {
    btn.textContent = label;
    btn.classList.remove('busy');
    btn.disabled = $('urlInput').value.trim().length === 0;
  }
});

/* ── Returning from Stripe ────────────────────────────────────── */
async function settleReturnFromCheckout(){
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('paid');
  if (params.get('canceled')){
    toast('Checkout canceled — no charge was made.');
    history.replaceState({}, '', location.pathname);
    return;
  }
  if (!sessionId) return;

  try {
    const data = await api('/api/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    if (data.status === 'confirmed'){
      goal('bid_confirmed', { rank: data.rank, amount: data.amount });
      toast(`Payment received — you are at #${data.rank}.`);
    } else {
      toast('Payment is still processing. The board will update shortly.');
    }
  } catch (err){
    toast(err.message, true);
  } finally {
    history.replaceState({}, '', location.pathname);
    await refreshAll();
  }
}

/* ── Analytics goals ──────────────────────────────────────────── */
/* datafast() only exists once the tracker script loads, and the tracker is
   only injected when DataFast is configured — so this is a no-op otherwise. */
function goal(name, meta){
  try { window.datafast?.(name, meta); } catch { /* never break the flow */ }
}

/* ── Toast ────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, isError = false){
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

/* ── Pagination events ────────────────────────────────────────── */
$('pageNums').addEventListener('click', (e) => {
  const btn = e.target.closest('.page-num');
  if (!btn) return;
  loadBoard(Number(btn.dataset.page));
  $('leaderboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('prevPage').addEventListener('click', () => { if (state.page > 1) loadBoard(state.page - 1); });
$('nextPage').addEventListener('click', () => { if (state.page < state.pages) loadBoard(state.page + 1); });

$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.classList.add('spinning');
  await refreshAll();
  btn.classList.remove('spinning');
});

async function refreshAll(){
  await Promise.all([loadBoard(), loadPanels(), loadStats(), loadCategories()]);
}

/* ── Live updates ─────────────────────────────────────────────── */
/* SSE pushes board changes the moment a bid clears; the interval is a
   fallback so counters stay fresh if the stream drops. */
function connectLive(){
  const es = new EventSource(url('/api/events'));
  es.addEventListener('board', () => refreshAll());
  es.onerror = () => { /* EventSource retries on its own */ };
}

setInterval(loadStats, 15_000);
setInterval(loadPanels, 30_000);


/* ── Boot ─────────────────────────────────────────────────────── */
(async function boot(){
  await refreshAll();
  await settleReturnFromCheckout();
  connectLive();
})();
