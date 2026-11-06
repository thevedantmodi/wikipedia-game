import { normalizeTitle } from '../lib/wiki.js';

// Tiny fake link graph. "USA" is a redirect to "United States".
const GRAPH = {
  Pickle: ['Cucumber', 'USA', 'France'],
  Cucumber: ['France', 'Pickle'],
  'United States': ['France', 'Napoleon'],
  France: ['Napoleon', 'Paris'],
  Paris: ['France'],
  Napoleon: ['France'],
  'New York': ['New York City', 'New York (state)'],
  'New York City': ['France'],
};
const DISAMBIGUATION = new Set(['New York']);
const REDIRECTS = { USA: 'United States' };

export function fakeWiki() {
  return {
    async getArticle(raw) {
      const key = normalizeTitle(raw);
      const title = REDIRECTS[key] || key;
      if (!GRAPH[title]) throw Object.assign(new Error(`No article ${title}`), { status: 404 });
      return {
        title,
        displayTitle: title,
        disambiguation: DISAMBIGUATION.has(title),
        html: '',
        links: new Set(GRAPH[title]),
        linkList: GRAPH[title],
      };
    },
    async getSummary(title) {
      return { title, extract: '', thumbnail: null };
    },
    async search(q) {
      return Object.keys(GRAPH)
        .filter((t) => t.startsWith(q))
        .map((title) => ({ title, description: '', disambiguation: DISAMBIGUATION.has(title) }));
    },
    async randomTitle() {
      return 'Paris';
    },
  };
}
