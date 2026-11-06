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

export function fakeWiki() {
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
