import crypto from 'node:crypto';
import { normalizeTitle } from './wiki.js';
import { POPULAR_TITLES } from './popular.js';

export const COUNTDOWN_MS = 3000;
// Landing on one of these pages pops up an alert for every other player.
// Titles are canonical, so links like "USA" or "U.S." count too.
export const ALERT_PAGES = new Set(['United States']);
export const MAX_PLAYERS = 16;
// In "fastest time" mode the race closes this long after the first finish.
export const FINISH_GRACE_MS = 2 * 60_000;
const MAX_NAME_LENGTH = 20;

// Players poll for state, so "online" means "polled recently". Hidden tabs stop
// polling, so these windows are generous enough to survive a quick tab switch.
export const ONLINE_MS = 30_000;
// lastSeen is only rewritten once it is this stale, so most polls are read-only.
export const SEEN_REFRESH_MS = 10_000;

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'time', // 'time' = fastest wins, 'clicks' = fewest clicks wins
  allowBack: false,
  showPaths: false, // show opponents' current pages live during the race
  allowFind: false, // allow the browser's find-in-page (Ctrl/Cmd+F)
  clickLimit: 0, // 0 = unlimited
  timeLimitMin: 0, // 0 = unlimited
  randomSource: 'popular', // 'popular' | 'any'
});

// Player status values:
//   lobby    – waiting / spectating, not part of the current race
//   racing   – still navigating
//   finished – reached the target
//   out      – hit the click limit
//   gaveup   – gave up
//   dnf      – race ended (time limit or host) before they finished
const STATUS_ORDER = { finished: 0, racing: 1, dnf: 2, out: 3, gaveup: 4, lobby: 5 };

export class GameError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!s) throw new GameError('Please enter a name');
  return s;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export class Room {
  constructor(code, wiki, { now = Date.now } = {}) {
    this.code = code;
    this.wiki = wiki;
    this.now = now;
    this.version = 0; // set by the store; lets clients drop out-of-order states
    this.players = new Map();
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.start = null;
    this.target = null;
    this.targetSummary = null;
    this.state = 'lobby'; // 'lobby' | 'racing' | 'finished'
    this.round = 0;
    this.startAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.alerts = []; // this round's landmark alerts: { id, playerId, name, title }
    this.alertSeq = 0;
    this.createdAt = now();
    this.lastActivity = now();
  }

  // ---- membership -------------------------------------------------------

  addPlayer(name) {
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Room is full', 409);
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: cleanName(name),
      lastSeen: this.now(),
      status: 'lobby',
      path: [],
      stack: [],
      clicks: 0,
      finishedMs: null,
      pending: false,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.touch();
    return player;
  }

  authenticate(playerId, token) {
    const p = this.players.get(playerId);
    if (!p || !token || p.token !== token) throw new GameError('Not a member of this room', 403);
    return p;
  }

  removePlayer(playerId) {
    if (!this.players.delete(playerId)) return;
    if (this.hostId === playerId) this.pickNewHost();
    if (this.state === 'racing') this.checkAllDone();
    this.touch();
  }

  pickNewHost() {
    const candidates = [...this.players.values()];
    const online = candidates.find((p) => this.isOnline(p));
    this.hostId = (online || candidates[0])?.id ?? null;
  }

  isOnline(p) {
    return this.now() - p.lastSeen < ONLINE_MS;
  }

  // Records a poll. Only bumps lastSeen when it is getting stale, so the store
  // can skip the write on most polls. Presence is not "activity": it never
  // touches lastActivity, so an open tab alone doesn't keep a room alive.
  markSeen(playerId) {
    const p = this.players.get(playerId);
    if (p && this.now() - p.lastSeen >= SEEN_REFRESH_MS) p.lastSeen = this.now();
  }

  // Runs on every load, since there are no long-lived timers between requests:
  // ends races past their time limit, then sweeps absent players.
  tick() {
    if (this.state === 'racing' && this.endsAt && this.now() >= this.endsAt) this.finishRace();
    this.sweep();
  }

  // Drops long-gone players and hands off an absent host.
  sweep({ dropAfterMs = 10 * 60_000, hostAwayMs = 60_000 } = {}) {
    const t = this.now();
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (t - p.lastSeen > dropAfterMs && p.status !== 'finished') {
        this.players.delete(p.id);
        changed = true;
      }
    }
    const host = this.players.get(this.hostId);
    if (!host || t - host.lastSeen > hostAwayMs) {
      const before = this.hostId;
      this.pickNewHost();
      if (this.hostId !== before) changed = true;
    }
    if (changed) {
      if (this.state === 'racing') this.checkAllDone();
      this.touch();
    }
  }

  touch() {
    this.lastActivity = this.now();
  }

  requireHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('Only the host can do that', 403);
  }

  // ---- lobby setup ------------------------------------------------------

  updateSettings(playerId, patch = {}) {
    this.requireHost(playerId);
    if (this.state === 'racing') throw new GameError('Cannot change settings mid-race', 409);
    const s = this.settings;
    if (patch.mode === 'clicks' || patch.mode === 'time') s.mode = patch.mode;
    if ('allowBack' in patch) s.allowBack = Boolean(patch.allowBack);
    if ('showPaths' in patch) s.showPaths = Boolean(patch.showPaths);
    if ('allowFind' in patch) s.allowFind = Boolean(patch.allowFind);
    if ('clickLimit' in patch) s.clickLimit = clampInt(patch.clickLimit, 0, 100);
    if ('timeLimitMin' in patch) s.timeLimitMin = clampInt(patch.timeLimitMin, 0, 60);
    if (patch.randomSource === 'popular' || patch.randomSource === 'any') {
      s.randomSource = patch.randomSource;
    }
    this.touch();
  }

  async setPage(playerId, which, title) {
    this.requireHost(playerId);
    if (which !== 'start' && which !== 'target') throw new GameError('Unknown page slot');
    if (this.state === 'racing') throw new GameError('Cannot change pages mid-race', 409);
    const article = await this.wiki.getArticle(title);
    if (article.disambiguation) {
      // e.g. "New York" lists the city, the state, the Yankees... pick one.
      let suggestions = [];
      try {
        suggestions = (await this.wiki.search(article.title, 10))
          .filter((r) => !r.disambiguation)
          .slice(0, 5);
      } catch {
        // Suggestions are optional.
      }
      throw new GameError(`"${article.title}" is a disambiguation page. Which one did you mean?`, 400, {
        suggestions,
      });
    }
    await this.assignPage(which, article.title);
  }

  async randomize(playerId, which = 'both') {
    this.requireHost(playerId);
    if (this.state === 'racing') throw new GameError('Cannot change pages mid-race', 409);
    const slots = which === 'both' ? ['start', 'target'] : [which];
    for (const slot of slots) {
      const other = slot === 'start' ? this.target : this.start;
      let title;
      for (let attempt = 0; attempt < 8; attempt++) {
        const article = await this.wiki.getArticle(await this.pickRandom());
        title = article.title;
        if (title !== other && !article.disambiguation) break;
      }
      await this.assignPage(slot, title);
    }
  }

  async pickRandom() {
    if (this.settings.randomSource === 'any') return this.wiki.randomTitle();
    return POPULAR_TITLES[crypto.randomInt(POPULAR_TITLES.length)];
  }

  async assignPage(which, title) {
    this[which] = title;
    if (which === 'target') {
      this.targetSummary = null;
      try {
        this.targetSummary = await this.wiki.getSummary(title);
      } catch {
        // The summary is a nice-to-have; the race works without it.
      }
    }
    this.touch();
  }

  // ---- race -------------------------------------------------------------

  startRace(playerId) {
    this.requireHost(playerId);
    if (this.state === 'racing') throw new GameError('Race already running', 409);
    if (!this.start || !this.target) throw new GameError('Pick a start and a target first');
    if (this.start === this.target) throw new GameError('Start and target must differ');
    const racers = [...this.players.values()].filter((p) => this.isOnline(p));
    if (racers.length === 0) throw new GameError('Nobody is connected');

    for (const p of this.players.values()) {
      p.status = 'lobby';
      p.path = [];
      p.stack = [];
      p.clicks = 0;
      p.finishedMs = null;
      p.pending = false;
    }
    for (const p of racers) {
      p.status = 'racing';
      p.path = [this.start];
      p.stack = [this.start];
    }
    this.round += 1;
    this.state = 'racing';
    this.alerts = [];
    this.startAt = this.now() + COUNTDOWN_MS;
    this.endedAt = null;
    const limitMs = this.settings.timeLimitMin * 60_000;
    this.endsAt = limitMs ? this.startAt + limitMs : null;
    this.touch();
  }

  racingPlayer(playerId) {
    if (this.state !== 'racing') throw new GameError('No race in progress', 409);
    if (this.now() < this.startAt) throw new GameError('The race has not started yet', 409);
    const p = this.players.get(playerId);
    if (!p || p.status !== 'racing') throw new GameError('You are not racing', 409);
    return p;
  }

  // `from` is the page the client clicked on. A repeated or replayed request
  // whose page is no longer the player's current one is rejected, so a
  // double-click can't count twice even across server instances.
  requireOn(p, from) {
    if (from != null && normalizeTitle(from) !== p.stack.at(-1)) {
      throw new GameError('You already moved on from that page', 409);
    }
  }

  async move(playerId, rawTitle, clickedOn) {
    const p = this.racingPlayer(playerId);
    if (p.pending) throw new GameError('Still loading your last click', 429);
    this.requireOn(p, clickedOn);
    const round = this.round;
    const from = p.stack.at(-1);
    p.pending = true;
    let dest;
    try {
      const current = await this.wiki.getArticle(from);
      const wanted = normalizeTitle(rawTitle);
      if (!current.links.has(wanted)) {
        throw new GameError(`"${wanted}" is not linked from "${from}"`);
      }
      dest = await this.wiki.getArticle(wanted);
    } finally {
      p.pending = false;
    }
    // The race may have ended (or restarted) while we were fetching.
    if (this.round !== round || this.state !== 'racing' || p.status !== 'racing') {
      throw new GameError('The race is over', 409);
    }
    p.path.push(dest.title);
    p.stack.push(dest.title);
    this.afterClick(p, dest.title);
    return { title: dest.title, clicks: p.clicks, round };
  }

  back(playerId, from) {
    if (!this.settings.allowBack) throw new GameError('Back is disabled in this room', 403);
    const p = this.racingPlayer(playerId);
    if (p.pending) throw new GameError('Still loading your last click', 429);
    this.requireOn(p, from);
    if (p.stack.length < 2) throw new GameError('Nowhere to go back to');
    p.stack.pop();
    const title = p.stack.at(-1);
    p.path.push(title);
    this.afterClick(p, title);
    return { title, clicks: p.clicks, round: this.round };
  }

  afterClick(p, title) {
    p.clicks += 1;
    // Once per player per page per round, so bouncing back and forth doesn't spam.
    if (ALERT_PAGES.has(title) && !this.alerts.some((a) => a.playerId === p.id && a.title === title)) {
      this.alerts.push({ id: ++this.alertSeq, playerId: p.id, name: p.name, title });
    }
    if (title === this.target) {
      const first = ![...this.players.values()].some((o) => o.status === 'finished');
      p.status = 'finished';
      p.finishedMs = this.now() - this.startAt;
      if (first && this.settings.mode === 'time') {
        const cutoff = this.now() + FINISH_GRACE_MS;
        this.endsAt = this.endsAt ? Math.min(this.endsAt, cutoff) : cutoff;
      }
    } else if (this.settings.clickLimit && p.clicks >= this.settings.clickLimit) {
      p.status = 'out';
    }
    this.checkAllDone();
    this.touch();
  }

  giveUp(playerId) {
    const p = this.racingPlayer(playerId);
    p.status = 'gaveup';
    this.checkAllDone();
    this.touch();
  }

  endRace(playerId) {
    this.requireHost(playerId);
    if (this.state !== 'racing') throw new GameError('No race in progress', 409);
    this.finishRace();
  }

  checkAllDone() {
    if (this.state !== 'racing') return;
    const stillRacing = [...this.players.values()].some((p) => p.status === 'racing');
    if (!stillRacing) this.finishRace();
  }

  finishRace() {
    for (const p of this.players.values()) {
      if (p.status === 'racing') p.status = 'dnf';
    }
    this.state = 'finished';
    this.endedAt = this.now();
    this.touch();
  }

  backToLobby(playerId) {
    this.requireHost(playerId);
    if (this.state === 'racing') throw new GameError('Finish the race first', 409);
    this.state = 'lobby';
    for (const p of this.players.values()) {
      p.status = 'lobby';
      p.path = [];
      p.stack = [];
      p.clicks = 0;
      p.finishedMs = null;
    }
    this.startAt = this.endsAt = this.endedAt = null;
    this.touch();
  }

  // ---- views ------------------------------------------------------------

  standings() {
    const byMode =
      this.settings.mode === 'time'
        ? (a, b) => a.finishedMs - b.finishedMs || a.clicks - b.clicks
        : (a, b) => a.clicks - b.clicks || a.finishedMs - b.finishedMs;
    return [...this.players.values()].sort((a, b) => {
      const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (s) return s;
      if (a.status === 'finished') return byMode(a, b);
      return a.name.localeCompare(b.name);
    });
  }

  viewFor(viewerId) {
    const reveal = this.state === 'finished' || this.settings.showPaths;
    let place = 0;
    const players = this.standings().map((p) => {
      const visible = reveal || p.id === viewerId;
      return {
        id: p.id,
        name: p.name,
        online: this.isOnline(p),
        isHost: p.id === this.hostId,
        status: p.status,
        place: p.status === 'finished' ? ++place : null,
        clicks: p.clicks,
        finishedMs: p.finishedMs,
        current: visible ? p.stack.at(-1) ?? null : null,
        path: visible ? p.path : null,
        canGoBack: p.id === viewerId && p.stack.length > 1,
      };
    });
    return {
      code: this.code,
      version: this.version,
      you: viewerId,
      hostId: this.hostId,
      state: this.state,
      round: this.round,
      settings: this.settings,
      start: this.start,
      target: this.target,
      targetSummary: this.targetSummary,
      // Players don't get alerts for their own moves.
      alerts: this.state === 'racing' ? this.alerts.filter((a) => a.playerId !== viewerId) : [],
      startAt: this.startAt,
      endsAt: this.endsAt,
      endedAt: this.endedAt,
      serverNow: this.now(),
      players,
    };
  }
}

// ---- persistence ----------------------------------------------------------

const PLAYER_FIELDS = ['id', 'token', 'name', 'lastSeen', 'status', 'path', 'stack', 'clicks', 'finishedMs'];
const ROOM_FIELDS = [
  'code', 'hostId', 'settings', 'start', 'target', 'targetSummary', 'state', 'round',
  'startAt', 'endsAt', 'endedAt', 'createdAt', 'lastActivity', 'alerts', 'alertSeq',
];

export function serializeRoom(room) {
  const data = Object.fromEntries(ROOM_FIELDS.map((k) => [k, room[k]]));
  data.players = [...room.players.values()].map((p) => Object.fromEntries(PLAYER_FIELDS.map((k) => [k, p[k]])));
  return JSON.stringify(data);
}

export function deserializeRoom(json, wiki, { now = Date.now } = {}) {
  const data = JSON.parse(json);
  const room = new Room(data.code, wiki, { now });
  for (const k of ROOM_FIELDS) room[k] = data[k];
  room.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  room.alerts ??= []; // rooms saved before alerts existed
  room.alertSeq ??= 0;
  room.players = new Map(data.players.map((p) => [p.id, { ...p, pending: false }]));
  return room;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomCode() {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}
