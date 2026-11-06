import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTDOWN_MS } from '../lib/game.js';
import { RoomStore, createMemoryKv, ROOM_TTL_SECONDS } from '../lib/store.js';
import { fakeWiki } from './helpers.js';

function setup() {
  let clock = 1_000_000;
  const now = () => clock;
  const kv = createMemoryKv({ now });
  // Count writes so tests can check that polling stays read-only.
  let writes = 0;
  const cas = kv.cas;
  kv.cas = async (...args) => {
    writes++;
    return cas(...args);
  };
  const store = new RoomStore(kv, fakeWiki(), { now });
  return {
    store,
    advance: (ms) => (clock += ms),
    writes: () => writes,
  };
}

const poll = (store, code, pid) => store.update(code, (room) => room.markSeen(pid));

async function raceRoom(store, advance) {
  const { room, player: a } = await store.create('A');
  const { result: b } = await store.update(room.code, (r) => r.addPlayer('B'));
  await store.update(room.code, async (r) => {
    await r.setPage(a.id, 'start', 'Pickle');
    await r.setPage(a.id, 'target', 'Napoleon');
    r.startRace(a.id);
  });
  advance(COUNTDOWN_MS);
  return { code: room.code, a, b };
}

test('rooms round-trip through the store', async () => {
  const { store, advance } = setup();
  const { code, a } = await raceRoom(store, advance);
  await store.update(code, (r) => r.move(a.id, 'France', 'Pickle'));
  const room = await store.load(code);
  assert.equal(room.state, 'racing');
  assert.deepEqual(room.players.get(a.id).path, ['Pickle', 'France']);
  await assert.rejects(store.load('ZZZZ'), /Room not found/);
});

test('simultaneous moves by two players both land', async () => {
  const { store, advance } = setup();
  const { code, a, b } = await raceRoom(store, advance);
  await Promise.all([
    store.update(code, (r) => r.move(a.id, 'France', 'Pickle')),
    store.update(code, (r) => r.move(b.id, 'Cucumber', 'Pickle')),
  ]);
  const room = await store.load(code);
  assert.equal(room.players.get(a.id).clicks, 1);
  assert.equal(room.players.get(b.id).clicks, 1);
});

test('a replayed double-click counts once', async () => {
  const { store, advance } = setup();
  const { code, a } = await raceRoom(store, advance);
  const results = await Promise.allSettled([
    store.update(code, (r) => r.move(a.id, 'France', 'Pickle')),
    store.update(code, (r) => r.move(a.id, 'Cucumber', 'Pickle')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await store.load(code)).players.get(a.id).clicks, 1);
});

test('polls only write when lastSeen is stale', async () => {
  const { store, writes, advance } = setup();
  const { room, player } = await store.create('A');
  const before = writes();
  for (let i = 0; i < 5; i++) {
    advance(1000);
    await poll(store, room.code, player.id);
  }
  assert.equal(writes(), before);
  advance(10_000);
  await poll(store, room.code, player.id);
  assert.equal(writes(), before + 1);
});

async function pollFor(store, advance, code, pid, seconds) {
  for (let t = 0; t < seconds; t += 30) {
    advance(30_000);
    await poll(store, code, pid);
  }
}

test('rooms expire after 20 minutes without activity, even while polled', async () => {
  const { store, advance } = setup();
  const { room, player } = await store.create('A');
  await pollFor(store, advance, room.code, player.id, ROOM_TTL_SECONDS - 60);
  advance(90_000);
  await assert.rejects(poll(store, room.code, player.id), /Room not found/);
});

test('an action restarts the expiry clock', async () => {
  const { store, advance } = setup();
  const { room, player } = await store.create('A');
  await pollFor(store, advance, room.code, player.id, ROOM_TTL_SECONDS - 60);
  await store.update(room.code, (r) => r.updateSettings(player.id, { mode: 'time' }));
  await pollFor(store, advance, room.code, player.id, ROOM_TTL_SECONDS - 60);
  assert.equal((await store.load(room.code)).settings.mode, 'time');
});

test('time limits end the race on the next load', async () => {
  const { store, advance } = setup();
  const { room, player } = await store.create('A');
  await store.update(room.code, async (r) => {
    r.updateSettings(player.id, { timeLimitMin: 1 });
    await r.setPage(player.id, 'start', 'Pickle');
    await r.setPage(player.id, 'target', 'Napoleon');
    r.startRace(player.id);
  });
  advance(COUNTDOWN_MS + 60_000);
  const { room: after } = await poll(store, room.code, player.id);
  assert.equal(after.state, 'finished');
  assert.equal(after.players.get(player.id).status, 'dnf');
});
