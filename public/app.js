const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Elements to strip from articles: navboxes, sidebars and categories are not
// part of the article body under the usual wikirace rules.
const STRIP_SELECTORS = [
  'script', 'link', 'meta',
  '.navbox', '.navbox-styles', '.vertical-navbox', '.sidebar', '.sistersitebox',
  '.side-box', '.catlinks', '.mw-editsection', '#toc', '.toc', '.mw-empty-elt',
  '.portalbox', '.noprint.portal', '.authority-control', '.mw-authority-control',
].join(',');

const STATUS_LABEL = {
  racing: 'racing',
  finished: 'finished',
  out: 'out of clicks',
  gaveup: 'gave up',
  dnf: 'did not finish',
  lobby: 'spectating',
};
const STATUS_ICON = { racing: '🏃', out: '🛑', gaveup: '🏳️', dnf: '⌛', lobby: '👀' };
const MEDALS = ['🥇', '🥈', '🥉'];

let session = null; // { code, playerId, token }
let state = null;
let clockOffset = 0;
let pollTimer = null;
let polling = false;
let tickTimer = null;
let moving = false;
let localNav = null; // { round, title, clicks } from our latest move response
let shown = { round: null, title: null }; // article currently on screen
let loadingTitle = null;
const articleCache = new Map();
let prevStatuses = new Map();

// ---- utilities -------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function normalizeTitle(raw) {
  let s = String(raw ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  if (!s) return '';
  const [first, ...rest] = s;
  return first.toUpperCase() + rest.join('');
}

function serverNow() {
  return Date.now() + clockOffset;
}

function formatMs(ms) {
  if (ms == null || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function formatMsPrecise(ms) {
  return `${formatMs(ms)}.${Math.floor((ms % 1000) / 100)}`;
}

function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function showError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
      status: res.status,
      suggestions: data.suggestions || [],
    });
  }
  return data;
}

async function action(type, extra = {}) {
  const code = session.code;
  const data = await api('POST', `/api/rooms/${code}/action`, {
    playerId: session.playerId,
    token: session.token,
    type,
    ...extra,
  });
  if (data.state && session?.code === code) applyState(data.state);
  return data;
}

async function tryAction(type, extra) {
  try {
    return await action(type, extra);
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

const storage = {
  name: () => localStorage.getItem('wikirace:name') || '',
  setName: (n) => localStorage.setItem('wikirace:name', n),
  creds: (code) => JSON.parse(localStorage.getItem(`wikirace:room:${code}`) || 'null'),
  setCreds: (c) => localStorage.setItem(`wikirace:room:${c.code}`, JSON.stringify(c)),
  clearCreds: (code) => localStorage.removeItem(`wikirace:room:${code}`),
};

// ---- theme -----------------------------------------------------------------

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Wikipedia's TemplateStyles key their dark variants on these classes.
  root.classList.toggle('skin-theme-clientpref-night', theme === 'dark');
  root.classList.toggle('skin-theme-clientpref-day', theme !== 'dark');
}

function setTheme(theme) {
  applyTheme(theme);
  try { localStorage.setItem('wikirace:theme', theme); } catch {}
}

function bindTheme() {
  for (const btn of $$('.theme-toggle')) {
    btn.onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
  // Follow the OS setting until the player picks a theme explicitly.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('wikirace:theme'); } catch {}
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
  });
}

// ---- home ------------------------------------------------------------------

function showScreen(id) {
  $('#home').hidden = id !== 'home';
  $('#room').hidden = id !== 'room';
}

function readName() {
  const name = $('#name-input').value.trim();
  if (!name) {
    showError($('#home-error'), 'Enter a name first.');
    $('#name-input').focus();
    return null;
  }
  storage.setName(name);
  return name;
}

async function createRoom() {
  const name = readName();
  if (!name) return;
  try {
    const creds = await api('POST', '/api/rooms', { name });
    storage.setCreds(creds);
    enterRoom(creds);
  } catch (err) {
    showError($('#home-error'), err.message);
  }
}

async function joinRoom(code, { silent = false } = {}) {
  code = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    showError($('#home-error'), 'Room codes are 4 letters.');
    return;
  }
  const saved = storage.creds(code);
  const name = saved ? storage.name() || 'Player' : readName();
  if (!name) return;
  try {
    const creds = await api('POST', `/api/rooms/${code}/join`, {
      name,
      playerId: saved?.playerId,
      token: saved?.token,
    });
    storage.setCreds(creds);
    enterRoom(creds);
  } catch (err) {
    if (saved) storage.clearCreds(code);
    if (!silent) showError($('#home-error'), err.message);
    else showError($('#home-error'), `Couldn't rejoin room ${code}: ${err.message}`);
    showScreen('home');
  }
}

function goHome(message) {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  session = state = localNav = null;
  shown = { round: null, title: null };
  prevStatuses = new Map();
  history.replaceState(null, '', '/');
  showScreen('home');
  showError($('#home-error'), message);
}

// ---- room connection -------------------------------------------------------

function enterRoom(creds) {
  session = creds;
  state = null;
  seenAlertId = null;
  history.replaceState(null, '', `/?room=${creds.code}`);
  $('#room-code').textContent = creds.code;
  showScreen('room');
  showError($('#home-error'), '');
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 200);
  poll();
}

function applyState(next) {
  // Poll and action responses can arrive out of order; keep the newest.
  if (state && next.version < state.version) return;
  clockOffset = next.serverNow - Date.now();
  announce(next);
  showAlerts(next.alerts || []);
  state = next;
  render();
}

// State comes from polling: every second during a race, slower otherwise, and
// not at all while the tab is hidden, so idle tabs cost no Redis reads.
const POLL_RACING_MS = 1000;
const POLL_IDLE_MS = 4000;

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!session || document.hidden) return;
  pollTimer = setTimeout(poll, state?.state === 'racing' ? POLL_RACING_MS : POLL_IDLE_MS);
}

async function poll() {
  if (!session || polling) return;
  const { code, playerId, token } = session;
  polling = true;
  try {
    const qs = new URLSearchParams({ pid: playerId, token });
    const next = await api('GET', `/api/rooms/${code}/state?${qs}`);
    if (session?.code === code) applyState(next);
  } catch (err) {
    if (session?.code !== code) return;
    if (err.status === 404) {
      storage.clearCreds(code);
      goHome(`Room ${code} has closed. Rooms close after 20 minutes without activity.`);
    } else if (err.status === 403) {
      // We were dropped after being away too long: rejoin as a new player.
      storage.clearCreds(code);
      joinRoom(code, { silent: true });
    }
  } finally {
    polling = false;
    schedulePoll();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else poll();
});

// Landmark alerts ("Bob reached United States!") from the server. The server
// already leaves out the viewer's own alerts. On the first state after
// joining or refreshing, existing alerts are marked seen instead of replayed.
let seenAlertId = null;
const ALERT_ICONS = { 'United States': '🇺🇸' };

function showAlerts(alerts) {
  const newest = Math.max(0, ...alerts.map((a) => a.id));
  if (seenAlertId == null) {
    seenAlertId = newest;
    return;
  }
  for (const a of alerts) {
    if (a.id > seenAlertId) popAlert(`${ALERT_ICONS[a.title] || '📍'} ${a.name} reached ${a.title}!`);
  }
  seenAlertId = Math.max(seenAlertId, newest);
}

function popAlert(text) {
  const el = h('div', { class: 'alert-pop', role: 'status' }, text);
  $('#alerts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

function announce(next) {
  if (state && state.round === next.round) {
    for (const p of next.players) {
      const before = prevStatuses.get(p.id);
      if (before === 'racing' && p.status === 'finished' && p.id !== next.you) {
        const closing =
          next.settings.mode === 'time' && next.endsAt && !state.endsAt && me()?.status === 'racing'
            ? ` The race ends in ${formatMs(next.endsAt - serverNow())}!`
            : '';
        toast(`🎉 ${p.name} reached the target in ${p.clicks} click${p.clicks === 1 ? '' : 's'}!${closing}`);
      }
    }
  }
  prevStatuses = new Map(next.players.map((p) => [p.id, p.status]));
}

function me() {
  return state?.players.find((p) => p.id === state.you);
}

function isHost() {
  return state && state.hostId === state.you;
}

// ---- rendering -------------------------------------------------------------

function render() {
  if (!state) return;
  document.body.classList.toggle('is-host', isHost());
  $('#lobby').hidden = state.state !== 'lobby';
  $('#race').hidden = state.state !== 'racing';
  $('#results').hidden = state.state !== 'finished';
  if (state.state === 'lobby') renderLobby();
  else if (state.state === 'racing') renderRace();
  else renderResults();
}

const AVATAR_COLORS = ['accent', 'orange', 'teal', 'violet'];

function renderPlayerList(ul) {
  ul.replaceChildren(
    ...state.players.map((p, i) => {
      const meta = [p.isHost && 'host', p.id === state.you && 'you'].filter(Boolean).join(' · ');
      return h('li', { class: p.online ? '' : 'offline' },
        h('span', {
          class: `dot avatar-${AVATAR_COLORS[i % AVATAR_COLORS.length]}`,
          title: p.online ? 'online' : 'offline',
          'aria-hidden': 'true',
        }, (p.name || '?').trim().charAt(0).toUpperCase() || '?'),
        h('span', { class: 'pname' }, p.name, meta && h('span', { class: 'pmeta' }, meta)),
        !p.online && h('span', { class: 'pstatus' }, 'Offline'),
      );
    }),
  );
}

function renderTargetSummary(container) {
  const s = state.targetSummary;
  if (!state.target) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(
    h('div', { class: 'ts-head' },
      s?.thumbnail && h('img', { src: s.thumbnail, alt: '' }),
      h('div', {},
        h('div', { class: 'muted small-text' }, 'Target'),
        h('div', { class: 'ts-title' }, state.target),
      ),
    ),
    s?.extract && h('p', { class: 'ts-extract' }, s.extract),
  );
}

function renderLobby() {
  const host = isHost();
  const hostPlayer = state.players.find((p) => p.isHost);
  $('#host-hint').textContent = host
    ? 'You are the host. Pick the pages and rules, then start the race.'
    : `${hostPlayer?.name ?? 'The host'} is setting up the race.`;

  for (const which of ['start', 'target']) {
    const input = $(`#${which}-input`);
    input.disabled = !host;
    if (document.activeElement !== input) input.value = state[which] || '';
  }
  renderTargetSummary($('#target-preview'));

  for (const el of $$('[data-setting]')) {
    const key = el.dataset.setting;
    el.disabled = !host;
    if (document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(state.settings[key]);
    else if (el.type === 'radio') el.checked = el.value === state.settings[key];
    else el.value = state.settings[key];
  }

  $('#start-btn').disabled = !state.start || !state.target;
  $('#player-count').textContent = `${state.players.length} ${state.players.length === 1 ? 'player' : 'players'}`;
  renderPlayerList($('#lobby-players'));
}

function desiredTitle() {
  const mine = me();
  if (!mine?.current) return null;
  if (localNav && localNav.round === state.round && localNav.clicks > mine.clicks) {
    return localNav.title;
  }
  return mine.current;
}

function renderRace() {
  const mine = me();
  const racingStarted = serverNow() >= state.startAt;
  const participant = mine && mine.status !== 'lobby';

  $('#race-start').textContent = state.start;
  $('#race-target').textContent = state.target;
  $('#race-target').title = state.targetSummary?.extract || '';
  renderTargetSummary($('#target-card'));

  $('#my-clicks').textContent = mine?.clicks ?? 0;
  $('#click-limit').textContent = state.settings.clickLimit ? ` / ${state.settings.clickLimit}` : '';
  const racing = mine?.status === 'racing';
  $('#back-btn').hidden = !(state.settings.allowBack && racing);
  $('#back-btn').disabled = !mine?.canGoBack || moving;
  $('#giveup-btn').hidden = !racing;

  // Banner for non-racing states
  const banner = $('#race-banner');
  let msg = null;
  if (!participant) msg = '👀 You joined mid-race, so you are spectating. You will race next round.';
  else if (mine.status === 'finished')
    msg = `🎉 You reached ${state.target} in ${mine.clicks} clicks (${formatMsPrecise(mine.finishedMs)})! Waiting for the others…`;
  else if (mine.status === 'out') msg = '🛑 Out of clicks. Watch the others finish!';
  else if (mine.status === 'gaveup') msg = '🏳️ You gave up. Watch the others finish!';
  banner.hidden = !msg;
  banner.textContent = msg || '';
  $('#article-wrap').classList.toggle('locked', !racing);

  // Breadcrumbs
  const path = mine?.path || [];
  $('#my-path').replaceChildren(
    ...path.flatMap((t, i) => [i > 0 && h('span', { class: 'sep' }, '›'), h('span', {}, t)]).filter(Boolean),
  );
  $('#my-path').scrollLeft = $('#my-path').scrollWidth;

  // Standings
  $('#race-players').replaceChildren(
    ...state.players.map((p, i) =>
      h('li', { class: `${p.status} ${p.online ? '' : 'offline'} ${p.id === state.you ? 'me' : ''}` },
        h('span', { class: `avatar c${p.id === state.you ? 'me' : i % 4}`, 'aria-hidden': 'true' },
          (p.name || '?').trim().charAt(0).toUpperCase() || '?'),
        h('div', { class: 'who' },
          h('div', { class: 'who-name' },
            h('b', {}, p.name),
            p.id === state.you && h('span', { class: 'tag you' }, 'you'),
          ),
          h('div', { class: 'who-sub' },
            p.status === 'lobby'
              ? 'spectating'
              : [
                  p.current && p.id !== state.you && p.status === 'racing' ? `on ${p.current}` : null,
                  p.finishedMs != null ? formatMsPrecise(p.finishedMs) : null,
                  p.status !== 'racing' ? STATUS_LABEL[p.status] : null,
                ].filter(Boolean).join(' · ') || STATUS_LABEL[p.status],
          ),
        ),
        h('span', { class: 'place', title: p.place ? `Place ${p.place}` : STATUS_LABEL[p.status] },
          p.place ? MEDALS[p.place - 1] || `#${p.place}` : STATUS_ICON[p.status]),
        p.status !== 'lobby' &&
          h('span', { class: 'clicks', title: `${p.clicks} click${p.clicks === 1 ? '' : 's'}` }, p.clicks),
      ),
    ),
  );

  if (participant && racingStarted) ensureArticle();
  else if (!participant) {
    $('#article').replaceChildren();
    shown = { round: null, title: null };
  }
  updateClock();
}

function renderResults() {
  const participants = state.players.filter((p) => p.status !== 'lobby');
  const winner = participants.find((p) => p.place === 1);
  $('#results-title').textContent = winner
    ? winner.id === state.you
      ? '🏆 You win!'
      : `🏆 ${winner.name} wins!`
    : 'Race over — nobody made it!';
  $('#results-route').textContent = `${state.start} → ${state.target} · ${
    state.settings.mode === 'time' ? 'fastest time wins' : 'fewest clicks wins'
  }`;
  $('#results-list').replaceChildren(
    ...participants.map((p) =>
      h('li', { class: `results-row ${p.status} ${p.place === 1 ? 'winner' : ''} ${p.id === state.you ? 'me' : ''}` },
        h('span', { class: 'place', title: p.place ? `Place ${p.place}` : STATUS_LABEL[p.status] },
          p.place ? MEDALS[p.place - 1] || `#${p.place}` : STATUS_ICON[p.status]),
        h('span', { class: 'result-name' },
          h('b', {}, p.name),
          p.id === state.you && h('span', { class: 'tag you' }, 'you'),
        ),
        h('span', { class: `result-time ${p.finishedMs != null ? '' : 'dnf'}` },
          p.finishedMs != null ? formatMsPrecise(p.finishedMs) : STATUS_LABEL[p.status]),
        h('span', { class: 'result-clicks' },
          `${p.clicks}`, h('span', { class: 'unit' }, ` click${p.clicks === 1 ? '' : 's'}`)),
        h('div', { class: 'result-path' },
          ...(p.path || []).flatMap((t, i, arr) => [
            i > 0 && h('span', { class: 'sep' }, '›'),
            h('a', {
              href: wikiUrl(t),
              target: '_blank',
              rel: 'noopener',
              class: i === arr.length - 1 && p.status === 'finished' ? 'is-target' : null,
            }, t),
          ]),
        ),
      ),
    ),
  );
}

function updateClock() {
  if (!state || state.state !== 'racing') return;
  const now = serverNow();
  const mine = me();
  const countdown = $('#countdown');
  const remainingStart = state.startAt - now;
  if (remainingStart > 0) {
    countdown.hidden = false;
    countdown.textContent = Math.ceil(remainingStart / 1000);
  } else {
    countdown.hidden = true;
  }
  let text;
  if (mine?.finishedMs != null) text = formatMsPrecise(mine.finishedMs);
  else if (state.endsAt) text = `${formatMs(state.endsAt - now)} left`;
  else text = formatMs(now - state.startAt);
  $('#my-timer').textContent = text;
}

function tick() {
  if (!state || state.state !== 'racing') return;
  updateClock();
  const mine = me();
  if (mine && mine.status !== 'lobby' && serverNow() >= state.startAt) ensureArticle();
}

// ---- articles --------------------------------------------------------------

async function fetchArticle(title) {
  if (articleCache.has(title)) return articleCache.get(title);
  const data = await api('GET', `/api/article?title=${encodeURIComponent(title)}`);
  articleCache.set(title, data);
  if (articleCache.size > 40) articleCache.delete(articleCache.keys().next().value);
  return data;
}

async function ensureArticle() {
  const title = desiredTitle();
  if (!title) return;
  if (shown.round === state.round && shown.title === title) return;
  if (loadingTitle === title) return;
  loadingTitle = title;
  $('#article-wrap').classList.add('loading');
  try {
    const data = await fetchArticle(title);
    if (desiredTitle() !== title) return; // superseded
    renderArticle(data);
    shown = { round: state.round, title };
  } catch (err) {
    toast(`Couldn't load "${title}": ${err.message}`, 'error');
  } finally {
    if (loadingTitle === title) loadingTitle = null;
    $('#article-wrap').classList.remove('loading');
  }
}

function renderArticle(data) {
  const doc = new DOMParser().parseFromString(data.html, 'text/html');
  const root = doc.body;
  root.querySelectorAll(STRIP_SELECTORS).forEach((el) => el.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
  }

  const links = new Set(data.links);
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) continue; // footnotes and in-page anchors
    const m = href.match(/^\/wiki\/([^?#]+)/);
    let title = null;
    if (m) {
      try {
        title = normalizeTitle(decodeURIComponent(m[1]));
      } catch {
        title = null;
      }
    }
    if (title && links.has(title) && title !== data.title) {
      a.classList.add('game-link');
      if (title === state?.target) a.classList.add('is-target');
      a.dataset.title = title;
      a.setAttribute('href', '#');
    } else {
      a.classList.add('dead-link');
      a.removeAttribute('href');
    }
  }
  // Protocol-relative image URLs break under file:// and some proxies.
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src?.startsWith('//')) img.setAttribute('src', `https:${src}`);
    img.removeAttribute('srcset');
    img.setAttribute('loading', 'lazy');
  }

  const titleEl = h('h1', { class: 'article-title' });
  titleEl.textContent = new DOMParser().parseFromString(data.displayTitle, 'text/html').body.textContent;
  const body = h('div', { class: 'article-body' });
  body.append(...root.childNodes);
  if (!state.settings.allowFind) hideTextFromFind(titleEl, body);
  $('#article').replaceChildren(titleEl, body);
  $('#article-wrap').scrollTop = 0;
  window.scrollTo({ top: 0 });
}

// Browsers' find-in-page (including the Edit > Find menu, which can't be
// intercepted) does not search CSS generated content, so render every text
// node through ::before { content: attr(data-t) }.
function hideTextFromFind(...roots) {
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        !n.nodeValue.trim() || n.parentElement?.closest('style')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const span = document.createElement('span');
      span.className = 'nf';
      span.dataset.t = node.nodeValue;
      node.replaceWith(span);
    }
  }
}

function findBlocked() {
  return state?.state === 'racing' && !state.settings.allowFind && me()?.status === 'racing';
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!findBlocked()) return;
    const key = e.key.toLowerCase();
    const isFind = (e.metaKey || e.ctrlKey) && (key === 'f' || key === 'g');
    if (isFind || e.key === 'F3') {
      e.preventDefault();
      e.stopPropagation();
      toast('Find-in-page is disabled for this race 🙈');
    }
  },
  true,
);

async function clickLink(title) {
  const mine = me();
  if (moving || mine?.status !== 'racing') return;
  moving = true;
  $('#article-wrap').classList.add('loading');
  try {
    const res = await action('move', { title, from: shown.title });
    localNav = { round: res.round, title: res.title, clicks: res.clicks };
    // Preload while we wait for the state broadcast.
    await ensureArticle();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    moving = false;
    $('#article-wrap').classList.remove('loading');
    render();
  }
}

async function goBack() {
  if (moving) return;
  moving = true;
  try {
    const res = await action('back', { from: shown.title });
    localNav = { round: res.round, title: res.title, clicks: res.clicks };
    await ensureArticle();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    moving = false;
    render();
  }
}

// ---- wiring ----------------------------------------------------------------

// Shows an error under the page pickers, with "did you mean" buttons when the
// server suggests alternatives (e.g. "New York" -> "New York City").
function showPageError(which, err) {
  const el = $('#lobby-error');
  const suggestions = err.suggestions || [];
  el.replaceChildren(
    h('div', {}, err.message),
    suggestions.length > 0 &&
      h('div', { class: 'suggestions' },
        ...suggestions.map((s) =>
          h('button', { class: 'small', onclick: () => setPage(which, s.title) },
            s.title,
            s.description && h('span', { class: 'muted' }, ` — ${s.description}`),
          ),
        ),
      ),
  );
  el.hidden = false;
}

const pendingPage = {};

async function setPage(which, title) {
  const input = $(`#${which}-input`);
  title = title.trim();
  if (!title || title === state?.[which] || title === pendingPage[which]) return;
  pendingPage[which] = title;
  input.value = title;
  input.classList.add('busy');
  showError($('#lobby-error'), '');
  try {
    await action('setPage', { which, title });
  } catch (err) {
    showPageError(which, err);
    input.value = state?.[which] || '';
  } finally {
    delete pendingPage[which];
    input.classList.remove('busy');
  }
}

// Title autocomplete backed by Wikipedia's prefix search. Disambiguation pages
// are left out so you pick "New York City" rather than "New York".
function setupPagePicker(which) {
  const input = $(`#${which}-input`);
  input.setAttribute('autocomplete', 'off');
  const wrap = h('div', { class: 'ac' });
  input.replaceWith(wrap);
  // preventDefault keeps focus in the input when dragging the list's scrollbar
  const list = h('ul', { class: 'ac-list', role: 'listbox', onmousedown: (e) => e.preventDefault() });
  list.hidden = true;
  wrap.append(input, list);

  let results = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const paint = () => {
    list.replaceChildren(
      ...results.map((r, i) =>
        h('li', {
            class: i === active ? 'active' : '',
            role: 'option',
            // mousedown fires before the input's blur, so the pick isn't lost
            onmousedown: (e) => {
              e.preventDefault();
              choose(r.title);
            },
          },
          h('span', { class: 'ac-title' }, r.title),
          r.description && h('span', { class: 'ac-desc' }, r.description),
        ),
      ),
    );
    list.hidden = results.length === 0;
  };
  const choose = (title) => {
    close();
    setPage(which, title);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      results = [];
      return close();
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
        if (mine !== seq || document.activeElement !== input) return;
        results = data.results.filter((r) => !r.disambiguation);
        active = -1;
        paint();
      } catch {
        close();
      }
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) return;
      e.preventDefault();
      const n = results.length;
      if (e.key === 'ArrowDown') active = (active + 1) % n;
      else active = active <= 0 ? n - 1 : active - 1;
      paint();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = active >= 0 ? results[active].title : input.value;
      seq++; // ignore searches still in flight
      clearTimeout(timer);
      choose(picked);
      input.blur();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => {
    clearTimeout(timer);
    seq++;
    close();
    setPage(which, input.value);
  });
}

function bind() {
  bindTheme();
  $('#name-input').value = storage.name();
  $('#create-btn').onclick = createRoom;
  $('#join-btn').onclick = () => joinRoom($('#code-input').value);
  $('#code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom($('#code-input').value);
  });
  $('#code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  $('#name-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if ($('#code-input').value.length === 4) joinRoom($('#code-input').value);
    else createRoom();
  });

  $('#copy-link').onclick = async () => {
    const link = `${location.origin}/?room=${session.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      toast(link);
    }
  };
  $('#leave-btn').onclick = async () => {
    if (!confirm('Leave this room?')) return;
    await tryAction('leave');
    storage.clearCreds(session.code);
    goHome();
  };

  for (const which of ['start', 'target']) setupPagePicker(which);

  for (const btn of $$('[data-random]')) {
    btn.onclick = async () => {
      btn.disabled = true;
      showError($('#lobby-error'), '');
      try {
        await action('random', { which: btn.dataset.random });
      } catch (err) {
        showError($('#lobby-error'), err.message);
      } finally {
        btn.disabled = false;
      }
    };
  }

  for (const el of $$('[data-setting]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      tryAction('settings', { settings: { [key]: value } });
    });
  }

  $('#start-btn').onclick = async () => {
    showError($('#lobby-error'), '');
    try {
      await action('start');
    } catch (err) {
      showError($('#lobby-error'), err.message);
    }
  };

  $('#article').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('game-link')) {
      e.preventDefault();
      clickLink(a.dataset.title);
    } else if (!(a.getAttribute('href') || '').startsWith('#')) {
      e.preventDefault();
    }
  });
  $('#back-btn').onclick = goBack;
  $('#giveup-btn').onclick = () => confirm('Give up this race?') && tryAction('giveUp');
  $('#end-btn').onclick = () => confirm('End the race for everyone?') && tryAction('end');
  $('#to-lobby-btn').onclick = () => tryAction('lobby');
  $('#rematch-btn').onclick = async () => {
    if (await tryAction('lobby')) await tryAction('random', { which: 'both' });
  };
}

// Expose sticky header heights so the race header / sidebar can stick right below them.
function trackStickyHeights() {
  if (typeof ResizeObserver === 'undefined') return;
  for (const [sel, prop] of [['.topbar', '--topbar-h'], ['.race-head', '--race-head-h']]) {
    const el = $(sel);
    if (!el) continue;
    new ResizeObserver(() => {
      if (el.offsetHeight) document.documentElement.style.setProperty(prop, `${el.offsetHeight}px`);
    }).observe(el);
  }
}

function boot() {
  bind();
  trackStickyHeights();
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (code && /^[A-Z]{4}$/.test(code)) {
    $('#code-input').value = code;
    if (storage.creds(code)) {
      joinRoom(code, { silent: true });
      return;
    }
    (storage.name() ? $('#join-btn') : $('#name-input')).focus();
  }
  showScreen('home');
}

boot();
