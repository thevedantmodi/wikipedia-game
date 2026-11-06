// HTTP API, shared by the local server (server.js) and the Vercel function
// (api/index.js). Stateless: every request loads its room from the store.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { GameError } from './game.js';

const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(req, res, status, body, headers = {}) {
  let payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const out = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
  if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = zlib.gzipSync(payload);
    out['Content-Encoding'] = 'gzip';
  }
  out['Content-Length'] = payload.length;
  res.writeHead(status, out);
  res.end(payload);
}

async function readJson(req) {
  // Vercel's Node runtime parses the body before the handler runs.
  if (req.body !== undefined) {
    if (typeof req.body !== 'string') return req.body || {};
    req = [Buffer.from(req.body)];
  }
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

async function serveStatic(req, res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) return send(req, res, 404, { error: 'Not found' });
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

function runAction(room, playerId, body) {
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
      return room.move(playerId, body.title, body.from);
    case 'back':
      return room.back(playerId, body.from);
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

// publicDir is only set for the local server; on Vercel the CDN serves public/.
export function createHandler({ store, wiki, publicDir = null }) {
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

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // vercel.json rewrites /api/<path> to the single function as ?__path=<path>.
    const rewritten = url.searchParams.get('__path');
    const pathname = rewritten != null ? `/api/${rewritten}` : url.pathname;

    if (req.method === 'GET' && pathname === '/api/article') return handleArticle(req, res, url);
    if (req.method === 'GET' && pathname === '/api/search') {
      const results = await wiki.search(url.searchParams.get('q'), 20);
      return send(req, res, 200, { results }, { 'Cache-Control': 'public, max-age=3600' });
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readJson(req);
      const { room, player } = await store.create(body.name);
      return send(req, res, 201, { code: room.code, playerId: player.id, token: player.token });
    }

    const m = pathname.match(/^\/api\/rooms\/([A-Za-z]{4})(?:\/(join|state|action))?$/);
    if (m) {
      const [, code, sub] = m;
      if (req.method === 'GET' && !sub) {
        const room = await store.load(code);
        return send(req, res, 200, { code: room.code, players: room.players.size, state: room.state });
      }
      // Polled by every open (visible) tab: one Redis read, plus a write only
      // when the player's lastSeen is stale or the room needs a tick.
      if (req.method === 'GET' && sub === 'state') {
        const pid = url.searchParams.get('pid');
        const { room } = await store.update(code, (room) => {
          room.authenticate(pid, url.searchParams.get('token'));
          room.markSeen(pid);
        });
        return send(req, res, 200, room.viewFor(pid));
      }
      if (req.method === 'POST' && sub === 'join') {
        const body = await readJson(req);
        const { result: player } = await store.update(code, (room) => {
          const existing = room.players.get(body.playerId);
          if (existing && existing.token === body.token) {
            room.markSeen(existing.id);
            return existing;
          }
          return room.addPlayer(body.name);
        });
        return send(req, res, 201, { code: code.toUpperCase(), playerId: player.id, token: player.token });
      }
      if (req.method === 'POST' && sub === 'action') {
        const body = await readJson(req);
        const { room, result } = await store.update(code, async (room) => {
          const player = room.authenticate(body.playerId, body.token);
          return runAction(room, player.id, body);
        });
        // Return the fresh state so the acting player doesn't wait for a poll.
        const view = room.players.has(body.playerId) ? room.viewFor(body.playerId) : null;
        return send(req, res, 200, { ok: true, ...(result || {}), state: view });
      }
    }

    if (publicDir && req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStatic(req, res, publicDir, pathname);
    }
    send(req, res, 404, { error: 'Not found' });
  }

  return async function handle(req, res) {
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
  };
}
