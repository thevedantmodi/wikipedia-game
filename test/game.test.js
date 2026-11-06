import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, COUNTDOWN_MS } from '../lib/game.js';
import { normalizeTitle } from '../lib/wiki.js';

// Tiny fake link graph. "USA" is a redirect to "United States".
const GRAPH = {
  Pickle: ['Cucumber', 'USA', 'France'],
  Cucumber: ['France', 'Pickle'],
  'United States': ['France', 'Napoleon'],
  France: ['Napoleon', 'Paris'],
  Paris: ['France'],
  Napoleon: ['France'],
};
const REDIRECTS = { USA: 'United States' };

function fakeWiki() {
  return {
    async getArticle(raw) {
      const key = normalizeTitle(raw);
      const title = REDIRECTS[key] || key;
      if (!GRAPH[title]) throw Object.assign(new Error(`No article ${title}`), { status: 404 });
      return { title, displayTitle: title, html: '', links: new Set(GRAPH[title]), linkList: GRAPH[title] };
    },
    async getSummary(title) {
      return { title, extract: '', thumbnail: null };
    },
    async randomTitle() {
      return 'Paris';
    },
  };
}

function setup({ settings = {}, players = 2 } = {}) {
  let clock = 1_000_000;
  const room = new Room('ABCD', fakeWiki(), { now: () => clock });
  const ps = [];
  for (let i = 0; i < players; i++) {
    const p = room.addPlayer(`P${i}`);
    room.setConnected(p.id, +1);
    ps.push(p);
  }
  const host = ps[0];
  room.updateSettings(host.id, settings);
  return {
    room,
    players: ps,
    host,
    advance: (ms) => (clock += ms),
    async begin() {
      await room.setPage(host.id, 'start', 'pickle');
      await room.setPage(host.id, 'target', 'Napoleon');
      room.startRace(host.id);
      clock += COUNTDOWN_MS;
    },
  };
}

test('normalizeTitle matches MediaWiki title rules', () => {
  assert.equal(normalizeTitle('foo_bar'), 'Foo bar');
  assert.equal(normalizeTitle('  New   York#History '), 'New York');
  assert.equal(normalizeTitle(''), '');
});

test('first player becomes host; only host can configure', async () => {
  const { room, players } = setup();
  assert.equal(room.hostId, players[0].id);
  await assert.rejects(room.setPage(players[1].id, 'start', 'Pickle'), /Only the host/);
  assert.throws(() => room.startRace(players[1].id), /Only the host/);
});

test('moves must follow real links and resolve redirects', async () => {
  const { room, players, begin } = setup();
  await begin();
  const [a] = players;
  await assert.rejects(room.move(a.id, 'Napoleon'), /not linked/);
  const res = await room.move(a.id, 'USA');
  assert.equal(res.title, 'United States');
  assert.deepEqual(a.path, ['Pickle', 'United States']);
  await room.move(a.id, 'Napoleon');
  assert.equal(a.status, 'finished');
  assert.equal(a.clicks, 2);
});

test('moves are rejected during the countdown', async () => {
  const { room, players, host, advance } = setup();
  await room.setPage(host.id, 'start', 'Pickle');
  await room.setPage(host.id, 'target', 'Napoleon');
  room.startRace(host.id);
  await assert.rejects(room.move(players[0].id, 'France'), /not started/);
  advance(COUNTDOWN_MS);
  await room.move(players[0].id, 'France');
});

test('race ends when everyone is done; fewest clicks ranks first', async () => {
  const { room, players, begin, advance } = setup({ settings: { mode: 'clicks' } });
  await begin();
  const [a, b] = players;
  // b is faster but takes more clicks
  await room.move(b.id, 'Cucumber');
  await room.move(b.id, 'France');
  await room.move(b.id, 'Napoleon');
  assert.equal(room.state, 'racing');
  advance(10_000);
  await room.move(a.id, 'France');
  await room.move(a.id, 'Napoleon');
  assert.equal(room.state, 'finished');
  const view = room.viewFor(a.id);
  assert.deepEqual(view.players.map((p) => [p.name, p.place]), [['P0', 1], ['P1', 2]]);
});

test('time mode ranks by finish time', async () => {
  const { room, players, begin, advance } = setup({ settings: { mode: 'time' } });
  await begin();
  const [a, b] = players;
  await room.move(b.id, 'Cucumber');
  await room.move(b.id, 'France');
  await room.move(b.id, 'Napoleon');
  advance(10_000);
  await room.move(a.id, 'France');
  await room.move(a.id, 'Napoleon');
  const view = room.viewFor(a.id);
  assert.equal(view.players[0].name, 'P1');
});

test('opponent paths are hidden mid-race unless showPaths is on', async () => {
  const { room, players, begin } = setup();
  await begin();
  const [a, b] = players;
  await room.move(b.id, 'France');
  const hidden = room.viewFor(a.id).players.find((p) => p.id === b.id);
  assert.equal(hidden.current, null);
  assert.equal(hidden.path, null);
  assert.equal(hidden.clicks, 1);
  const own = room.viewFor(b.id).players.find((p) => p.id === b.id);
  assert.equal(own.current, 'France');
});

test('back button costs a click and only works when allowed', async () => {
  const { room, players, begin } = setup({ settings: { allowBack: true } });
  await begin();
  const [a] = players;
  await room.move(a.id, 'Cucumber');
  const res = room.back(a.id);
  assert.equal(res.title, 'Pickle');
  assert.equal(a.clicks, 2);
  assert.deepEqual(a.path, ['Pickle', 'Cucumber', 'Pickle']);
  assert.throws(() => room.back(a.id), /Nowhere/);

  const other = setup();
  await other.begin();
  await other.room.move(other.players[0].id, 'France');
  assert.throws(() => other.room.back(other.players[0].id), /disabled/);
});

test('click limit knocks players out', async () => {
  const { room, players, begin } = setup({ settings: { clickLimit: 1 }, players: 1 });
  await begin();
  await room.move(players[0].id, 'Cucumber');
  assert.equal(players[0].status, 'out');
  assert.equal(room.state, 'finished');
});

test('host leaving hands host to someone else', () => {
  const { room, players } = setup({ players: 3 });
  room.removePlayer(players[0].id);
  assert.equal(room.hostId, players[1].id);
});

test('late joiners spectate and back-to-lobby resets everyone', async () => {
  const { room, players, begin, host } = setup();
  await begin();
  const late = room.addPlayer('Late');
  room.setConnected(late.id, +1);
  assert.equal(late.status, 'lobby');
  await assert.rejects(room.move(late.id, 'France'), /not racing/);
  room.giveUp(players[0].id);
  room.giveUp(players[1].id);
  assert.equal(room.state, 'finished');
  room.backToLobby(host.id);
  assert.equal(room.state, 'lobby');
  assert.ok([...room.players.values()].every((p) => p.status === 'lobby' && p.clicks === 0));
});

test('concurrent double-click only counts once', async () => {
  const { room, players, begin } = setup();
  await begin();
  const [a] = players;
  const results = await Promise.allSettled([room.move(a.id, 'France'), room.move(a.id, 'Cucumber')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(a.clicks, 1);
});
