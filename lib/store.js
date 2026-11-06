// Room persistence. On Vercel every request may hit a different instance, so
// rooms live in Redis (Upstash, over its REST API) instead of process memory.
// Without Redis credentials it falls back to an in-memory store for local dev.
//
// Each room is one key holding "<version>|<json>". Writes are compare-and-set
// on the version, so two players acting at once can't overwrite each other:
// the loser reloads and replays its action.

import { GameError, Room, randomCode, serializeRoom, deserializeRoom } from './game.js';

// A room is deleted after this long without a player action. Polling does not
// count, so a forgotten tab can't keep a room (and its polling) alive forever.
export const ROOM_TTL_SECONDS = 20 * 60;
const MAX_ATTEMPTS = 5;

// KEYS[1] room key. ARGV: expected version ("0" = must not exist), new value,
// TTL in seconds ("0" = keep the current TTL). Returns 1 if written.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local v = '0'
if cur then v = string.match(cur, '^(%d+)|') end
if v ~= ARGV[1] then return 0 end
if ARGV[3] == '0' then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1`;

export function createRedisKv({ url, token, fetchImpl = globalThis.fetch }) {
  async function command(...args) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Redis error: ${data.error || res.status}`);
    return data.result;
  }
  return {
    get: (key) => command('GET', key),
    cas: async (key, expected, value, ttl) =>
      (await command('EVAL', CAS_SCRIPT, '1', key, String(expected), value, String(ttl))) === 1,
  };
}

export function createMemoryKv({ now = Date.now } = {}) {
  const map = new Map(); // key -> { value, expiresAt }
  const live = (key) => {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= now()) map.delete(key);
    return map.get(key);
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async cas(key, expected, value, ttl) {
      const entry = live(key);
      const v = entry ? entry.value.slice(0, entry.value.indexOf('|')) : '0';
      if (v !== String(expected)) return false;
      map.set(key, { value, expiresAt: ttl ? now() + ttl * 1000 : entry.expiresAt });
      return true;
    },
  };
}

export function kvFromEnv(env = process.env) {
  // The Vercel Marketplace Upstash integration sets KV_REST_API_*; a direct
  // Upstash setup uses UPSTASH_REDIS_REST_*.
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisKv({ url, token });
  if (env.VERCEL) console.warn('No Redis credentials: rooms are in memory and will not survive across instances.');
  return createMemoryKv();
}

const roomKey = (code) => `wikirace:room:${code}`;

export class RoomStore {
  constructor(kv, wiki, { now = Date.now } = {}) {
    this.kv = kv;
    this.wiki = wiki;
    this.now = now;
  }

  async create(name) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const room = new Room(randomCode(), this.wiki, { now: this.now });
      const player = room.addPlayer(name);
      room.version = 1;
      if (await this.kv.cas(roomKey(room.code), 0, `1|${serializeRoom(room)}`, ROOM_TTL_SECONDS)) {
        return { room, player };
      }
    }
    throw new GameError('Could not allocate a room code, try again', 503);
  }

  async load(code) {
    code = String(code || '').toUpperCase();
    const raw = await this.kv.get(roomKey(code));
    if (!raw) throw new GameError('Room not found', 404);
    const bar = raw.indexOf('|');
    const room = deserializeRoom(raw.slice(bar + 1), this.wiki, { now: this.now });
    room.version = Number(raw.slice(0, bar));
    return room;
  }

  // Loads the room, runs fn on it and saves the result if anything changed,
  // retrying from a fresh load when another request saved first. A throwing fn
  // saves nothing, so actions are all-or-nothing.
  async update(code, fn) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const room = await this.load(code);
      const before = serializeRoom(room);
      const activityBefore = room.lastActivity;
      room.tick();
      const result = await fn(room);
      const after = serializeRoom(room);
      if (after === before) return { room, result };
      // Only real activity restarts the expiry clock; presence updates keep it.
      const ttl = room.lastActivity !== activityBefore ? ROOM_TTL_SECONDS : 0;
      const next = room.version + 1;
      if (await this.kv.cas(roomKey(room.code), room.version, `${next}|${after}`, ttl)) {
        room.version = next;
        return { room, result };
      }
    }
    throw new GameError('The room is busy, try again', 503);
  }
}
