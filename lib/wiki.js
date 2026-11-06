// Thin client for the Wikipedia Action API with an in-memory cache.
// The server uses it both to serve article HTML to players and to validate
// that every move follows a real link on the player's current page.

const API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT =
  'WikiRaceMultiplayer/1.0 (https://github.com/hannahjiang06/wikipedia-game)';

export class WikiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// MediaWiki treats "foo_bar", "Foo bar" and "Foo bar#Section" as the same page.
export function normalizeTitle(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).trim();
  if (!s) return '';
  const [first, ...rest] = s;
  return first.toUpperCase() + rest.join('');
}

// formatversion=2 returns page properties as an object; v1 as [{name, *}].
function isDisambiguation(properties) {
  if (!properties) return false;
  if (Array.isArray(properties)) return properties.some((p) => p.name === 'disambiguation');
  return 'disambiguation' in properties;
}

class LruCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

export function createWiki({ fetchImpl = globalThis.fetch, cacheSize = 300 } = {}) {
  const articles = new LruCache(cacheSize); // normalized title -> article
  const summaries = new LruCache(cacheSize);
  const inflight = new Map();

  async function call(params) {
    const url = new URL(API);
    for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
      url.searchParams.set(k, v);
    }
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new WikiError(`Could not reach Wikipedia (${err.cause?.code || err.message})`, 502);
    }
    if (!res.ok) throw new WikiError(`Wikipedia responded with ${res.status}`, 502);
    return res.json();
  }

  async function fetchArticle(title) {
    const data = await call({
      action: 'parse',
      page: title,
      prop: 'text|links|displaytitle|properties',
      redirects: '1',
      disableeditsection: '1',
      disabletoc: '1',
      disablelimitreport: '1',
    });
    if (data.error) {
      if (data.error.code === 'missingtitle' || data.error.code === 'invalidtitle') {
        throw new WikiError(`No Wikipedia article named "${title}"`, 404);
      }
      throw new WikiError(data.error.info || 'Wikipedia error', 502);
    }
    const p = data.parse;
    const linkList = [];
    for (const l of p.links || []) {
      if (l.ns === 0 && l.exists) linkList.push(normalizeTitle(l.title));
    }
    return {
      title: normalizeTitle(p.title),
      displayTitle: p.displaytitle || p.title,
      disambiguation: isDisambiguation(p.properties),
      html: p.text,
      links: new Set(linkList),
      linkList,
    };
  }

  // Resolves redirects; the returned article's `title` is canonical.
  async function getArticle(rawTitle) {
    const key = normalizeTitle(rawTitle);
    if (!key) throw new WikiError('Missing article title');
    const cached = articles.get(key);
    if (cached) return cached;
    if (inflight.has(key)) return inflight.get(key);
    const promise = fetchArticle(key)
      .then((article) => {
        articles.set(key, article);
        articles.set(article.title, article);
        return article;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  // Title autocomplete. Disambiguation pages are flagged so callers can skip them.
  async function search(rawQuery, limit = 8) {
    const query = String(rawQuery ?? '').trim();
    if (!query) return [];
    const data = await call({
      action: 'query',
      generator: 'prefixsearch',
      gpssearch: query,
      gpslimit: String(limit),
      gpsnamespace: '0',
      prop: 'description|pageprops',
      ppprop: 'disambiguation',
      redirects: '1',
    });
    const seen = new Set();
    return (data.query?.pages || [])
      .filter((p) => !p.missing)
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .map((p) => ({
        title: normalizeTitle(p.title),
        description: p.description || '',
        disambiguation: Boolean(p.pageprops && 'disambiguation' in p.pageprops),
      }))
      .filter((r) => !seen.has(r.title) && seen.add(r.title));
  }

  async function getSummary(rawTitle) {
    const key = normalizeTitle(rawTitle);
    const cached = summaries.get(key);
    if (cached) return cached;
    const data = await call({
      action: 'query',
      titles: key,
      redirects: '1',
      prop: 'extracts|pageimages',
      exintro: '1',
      explaintext: '1',
      exsentences: '3',
      piprop: 'thumbnail',
      pithumbsize: '240',
    });
    const page = data.query?.pages?.[0];
    const summary = {
      title: page?.title || key,
      extract: page?.extract || '',
      thumbnail: page?.thumbnail?.source || null,
    };
    summaries.set(key, summary);
    return summary;
  }

  async function randomTitle() {
    const data = await call({
      action: 'query',
      list: 'random',
      rnnamespace: '0',
      rnlimit: '1',
      rnfilterredir: 'nonredirects',
    });
    const title = data.query?.random?.[0]?.title;
    if (!title) throw new WikiError('Could not pick a random article', 502);
    return normalizeTitle(title);
  }

  return { getArticle, getSummary, randomTitle, search };
}
