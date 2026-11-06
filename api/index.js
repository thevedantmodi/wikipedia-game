// Vercel function for every /api/* route (see the rewrite in vercel.json).
// Module scope survives between invocations on a warm instance, so the
// Wikipedia cache is reused; room state always comes from Redis.
import { createWiki } from '../lib/wiki.js';
import { RoomStore, kvFromEnv } from '../lib/store.js';
import { createHandler } from '../lib/http.js';

const wiki = createWiki();
const store = new RoomStore(kvFromEnv(), wiki);

export default createHandler({ store, wiki });
