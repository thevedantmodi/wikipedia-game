import crypto from 'node:crypto';
import { normalizeTitle } from './wiki.js';
import { POPULAR_TITLES } from './popular.js';

export const COUNTDOWN_MS = 3000;
export const MAX_PLAYERS = 16;
const MAX_NAME_LENGTH = 20;

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'clicks', // 'clicks' = fewest clicks wins, 'time' = fastest wins
  allowBack: false,
  showPaths: false, // show opponents' current pages live during the race
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
  constructor(message, status = 400) {
    super(message);
    this.status = status;
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
  constructor(code, wiki, { now = Date.now, onChange = () => {} } = {}) {
    this.code = code;
    this.wiki = wiki;
    this.now = now;
    this.onChange = onChange;
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
    this.timer = null;
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
      connections: 0,
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
    const online = candidates.find((p) => p.connections > 0);
    this.hostId = (online || candidates[0])?.id ?? null;
  }

  setConnected(playerId, delta) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections = Math.max(0, p.connections + delta);
    p.lastSeen = this.now();
    this.touch();
  }

  // Called periodically: drops long-gone players and hands off an absent host.
  sweep({ dropAfterMs = 120_000, hostAwayMs = 30_000 } = {}) {
    const t = this.now();
    let changed = false;
    for (const p of [...this.players.values()]) {
      if (p.connections === 0 && t - p.lastSeen > dropAfterMs && p.status !== 'finished') {
        this.players.delete(p.id);
        changed = true;
      }
    }
    const host = this.players.get(this.hostId);
    if (!host || (host.connections === 0 && t - host.lastSeen > hostAwayMs)) {
      const before = this.hostId;
      this.pickNewHost();
      if (this.hostId !== before) changed = true;
    }
    if (changed) {
      if (this.state === 'racing') this.checkAllDone();
      this.touch();
    }
  }

  isIdle(idleMs) {
    const anyoneOnline = [...this.players.values()].some((p) => p.connections > 0);
    return !anyoneOnline && this.now() - this.lastActivity > idleMs;
  }

  touch() {
    this.lastActivity = this.now();
    this.onChange(this);
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
    await this.assignPage(which, article.title);
  }

  async randomize(playerId, which = 'both') {
    this.requireHost(playerId);
    if (this.state === 'racing') throw new GameError('Cannot change pages mid-race', 409);
    const slots = which === 'both' ? ['start', 'target'] : [which];
    for (const slot of slots) {
      const other = slot === 'start' ? this.target : this.start;
      let title;
      for (let attempt = 0; attempt < 5; attempt++) {
        title = (await this.wiki.getArticle(await this.pickRandom())).title;
        if (title !== other) break;
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
    const racers = [...this.players.values()].filter((p) => p.connections > 0);
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
    this.startAt = this.now() + COUNTDOWN_MS;
    this.endedAt = null;
    const limitMs = this.settings.timeLimitMin * 60_000;
    this.endsAt = limitMs ? this.startAt + limitMs : null;
    clearTimeout(this.timer);
    if (this.endsAt) {
      const round = this.round;
      this.timer = setTimeout(() => {
        if (this.round === round && this.state === 'racing') this.finishRace();
      }, this.endsAt - this.now());
      this.timer.unref?.();
    }
    this.touch();
  }

  racingPlayer(playerId) {
    if (this.state !== 'racing') throw new GameError('No race in progress', 409);
    if (this.now() < this.startAt) throw new GameError('The race has not started yet', 409);
    const p = this.players.get(playerId);
    if (!p || p.status !== 'racing') throw new GameError('You are not racing', 409);
    return p;
  }

  async move(playerId, rawTitle) {
    const p = this.racingPlayer(playerId);
    if (p.pending) throw new GameError('Still loading your last click', 429);
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

  back(playerId) {
    if (!this.settings.allowBack) throw new GameError('Back is disabled in this room', 403);
    const p = this.racingPlayer(playerId);
    if (p.pending) throw new GameError('Still loading your last click', 429);
    if (p.stack.length < 2) throw new GameError('Nowhere to go back to');
    p.stack.pop();
    const title = p.stack.at(-1);
    p.path.push(title);
    this.afterClick(p, title);
    return { title, clicks: p.clicks, round: this.round };
  }

  afterClick(p, title) {
    p.clicks += 1;
    if (title === this.target) {
      p.status = 'finished';
      p.finishedMs = this.now() - this.startAt;
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
    clearTimeout(this.timer);
    this.timer = null;
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
        online: p.connections > 0,
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
      you: viewerId,
      hostId: this.hostId,
      state: this.state,
      round: this.round,
      settings: this.settings,
      start: this.start,
      target: this.target,
      targetSummary: this.targetSummary,
      startAt: this.startAt,
      endsAt: this.endsAt,
      endedAt: this.endedAt,
      serverNow: this.now(),
      players,
    };
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export class Lobby {
  constructor(wiki, { onRoomChange = () => {}, now = Date.now } = {}) {
    this.wiki = wiki;
    this.rooms = new Map();
    this.onRoomChange = onRoomChange;
    this.now = now;
  }

  createRoom() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.wiki, { now: this.now, onChange: this.onRoomChange });
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('Room not found', 404);
    return room;
  }

  sweep({ idleRoomMs = 30 * 60_000 } = {}) {
    for (const [code, room] of this.rooms) {
      room.sweep();
      if (room.players.size === 0 || room.isIdle(idleRoomMs)) {
        clearTimeout(room.timer);
        this.rooms.delete(code);
      }
    }
  }
}
