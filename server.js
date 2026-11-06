// Local server. In production on Vercel, api/index.js serves the same API and
// the CDN serves public/.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWiki } from './lib/wiki.js';
import { RoomStore, kvFromEnv } from './lib/store.js';
import { createHandler } from './lib/http.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const wiki = createWiki();
const store = new RoomStore(kvFromEnv(), wiki);

http.createServer(createHandler({ store, wiki, publicDir: PUBLIC_DIR })).listen(PORT, () => {
  console.log(`WikiRace running at http://localhost:${PORT}`);
});
