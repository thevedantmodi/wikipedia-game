# wikipedia-game

A multiplayer **WikiRace**. Everyone starts on the same Wikipedia article and races to the same target using only the links inside the article body.

## Where to play

[wikirace.vedantmodi.com](wikirace.vedantmodi.com)
[wikirace.hannahjiang.com](wikirace.hannahjiang.com)

## How it plays

1. Someone creates a room and shares the 4-letter code or the invite link.
2. The host picks a start and a target. They can type titles or press 🎲 to get a random pair, drawn either from well-known articles or from any article.
3. The host sets the rules:
   - **Winner:** fastest time (the default) or fewest clicks. In fastest-time races, everyone else gets 2 more minutes once the first player finishes. In a 2-player race it ends right away.
   - **Click limit** and **time limit**.
   - **Back button:** allowed or not. Each back costs a click.
   - **Show opponents' pages live:** if this is off, you only see opponents' click counts until the race ends.
   - **Table of contents:** off by default. When on, each article starts with a numbered Contents box that jumps to its sections.
   - **Find-in-page:** off by default. Ctrl/Cmd+F is intercepted, and article text is drawn with CSS generated content, so even the browser's Edit → Find menu can't search it.
4. After a synchronized 3-second countdown, everyone races. While you race, the page only shows the article, your clicks and your time: the top bar, the target's summary and the live standings are hidden. The **?** button in the corner explains the rules and can reveal what the target is about as a hint. You still get a toast when someone finishes, and everything comes back once you finish or give up.
5. The results screen shows each player's full path. The host can start a new round with one click.

People who join mid-race spectate until the next round. If you refresh or drop your connection, you rejoin automatically, because your identity is kept in `localStorage`. If the host leaves, another player becomes host.

## How it works

- **`lib/http.js`** is the JSON API. It is stateless: every request loads its room from the store. `server.js` runs it locally and also serves `public/`. `api/index.js` runs it as a Vercel function.
- **`lib/store.js`** keeps each room as one Redis key. Writes are compare-and-set on a version number, so simultaneous actions from different players never overwrite each other. A room expires **20 minutes after the last player action**. Polling doesn't count as activity, so a forgotten tab can't keep a room alive.
- **Live updates** come from polling: every second during a race, every 4 seconds otherwise, and not at all while the tab is hidden. A poll is one Redis read. It also writes about every 10 seconds per player to record that the player is still online.
- **`lib/game.js`** holds the room and race logic. The server is authoritative. A move is accepted only if the clicked title is in the current article's link list from the Wikipedia API. Redirects are resolved before checking whether a player reached the target.
- **`lib/wiki.js`** wraps the Wikipedia Action API (`action=parse`). It uses an LRU cache and de-duplicates requests that are already in flight, so a room full of players opening the same start page triggers only one fetch.
- **`public/`** is a vanilla JS client. It removes navboxes, sidebars and categories, and disables every link that isn't a valid in-game link.

With in-memory rooms (no Redis configured), restarting the server clears them.
