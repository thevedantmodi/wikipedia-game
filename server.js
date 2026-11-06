import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createWiki } from './lib/wiki.js';
import { Lobby, GameError } from './lib/game.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 16 * 1024;

const wiki = createWiki();
// room code -> Set of { res, playerId }
const subscribers = new Map();

const lobby = new Lobby(wiki, { onRoomChange: broadcast });

function broadcast(room) {
  const subs = subscribers.get(room.code);
  if (!subs) return;
  for (const sub of subs) {
    sub.res.write(`data: ${JSON.stringify(room.viewFor(sub.playerId))}\n\n`);
  }
}

setInterval(() => {
  lobby.sweep();
  for (const [code, subs] of subscribers) {
    if (!lobby.rooms.has(code)) {
      for (const sub of subs) sub.res.end();
      subscribers.delete(code);
    }
  }
}, 15_000).unref();

// ---- helpers --------------------------------------------------------------

function send(req, res, status, body, headers = {}) {
  let payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const out = { 'Content-Type': 'application/json; charset=utf-8', ...headers };
  if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = zlib.gzipSync(payload);
    out['Content-Encoding'] = 'gzip';
  }
  out['Content-Length'] = payload.length;
  res.writeHead(status, out);
  res.end(payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GameError('Request too large', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GameError('Invalid JSON');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 404, { error: 'Not found' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(req, res, 404, { error: 'Not found' });
  }
}

// ---- routes ---------------------------------------------------------------

async function handleArticle(req, res, url) {
  const article = await wiki.getArticle(url.searchParams.get('title'));
  send(
    req,
    res,
    200,
    {
      title: article.title,
      displayTitle: article.displayTitle,
      html: article.html,
      links: article.linkList,
    },
    { 'Cache-Control': 'public, max-age=300' },
  );
}

function handleEvents(req, res, room, url) {
  const player = room.authenticate(url.searchParams.get('pid'), url.searchParams.get('token'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const sub = { res, playerId: player.id };
  if (!subscribers.has(room.code)) subscribers.set(room.code, new Set());
  subscribers.get(room.code).add(sub);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
  room.setConnected(player.id, +1); // also broadcasts the current state to us

  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.get(room.code)?.delete(sub);
    room.setConnected(player.id, -1);
  });
}

async function handleAction(room, playerId, body) {
  switch (body.type) {
    case 'settings':
      return room.updateSettings(playerId, body.settings);
    case 'setPage':
      return room.setPage(playerId, body.which, body.title);
    case 'random':
      return room.randomize(playerId, body.which);
    case 'start':
      return room.startRace(playerId);
    case 'move':
      return room.move(playerId, body.title);
    case 'back':
      return room.back(playerId);
    case 'giveUp':
      return room.giveUp(playerId);
    case 'end':
      return room.endRace(playerId);
    case 'lobby':
      return room.backToLobby(playerId);
    case 'leave':
      return room.removePlayer(playerId);
    default:
      throw new GameError('Unknown action');
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/article') return handleArticle(req, res, url);
  if (req.method === 'GET' && pathname === '/api/search') {
    const results = await wiki.search(url.searchParams.get('q'), 20);
    return send(req, res, 200, { results }, { 'Cache-Control': 'public, max-age=3600' });
  }

  if (req.method === 'POST' && pathname === '/api/rooms') {
    const body = await readJson(req);
    const room = lobby.createRoom();
    try {
      const player = room.addPlayer(body.name);
      return send(req, res, 201, { code: room.code, playerId: player.id, token: player.token });
    } catch (err) {
      lobby.rooms.delete(room.code);
      throw err;
    }
  }

  const m = pathname.match(/^\/api\/rooms\/([A-Za-z]{4})(?:\/(join|events|action))?$/);
  if (m) {
    const room = lobby.getRoom(m[1]);
    const sub = m[2];
    if (req.method === 'GET' && !sub) {
      return send(req, res, 200, { code: room.code, players: room.players.size, state: room.state });
    }
    if (req.method === 'GET' && sub === 'events') return handleEvents(req, res, room, url);
    if (req.method === 'POST' && sub === 'join') {
      const body = await readJson(req);
      const existing = room.players.get(body.playerId);
      if (existing && existing.token === body.token) {
        return send(req, res, 200, { code: room.code, playerId: existing.id, token: existing.token });
      }
      const player = room.addPlayer(body.name);
      return send(req, res, 201, { code: room.code, playerId: player.id, token: player.token });
    }
    if (req.method === 'POST' && sub === 'action') {
      const body = await readJson(req);
      const player = room.authenticate(body.playerId, body.token);
      const result = await handleAction(room, player.id, body);
      return send(req, res, 200, { ok: true, ...(result || {}) });
    }
  }

  if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  send(req, res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) {
      send(req, res, status, { error: err.message || 'Server error', suggestions: err.suggestions });
    }
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`WikiRace running at http://localhost:${PORT}`);
});
