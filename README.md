# wikipedia-game

A multiplayer **WikiRace**. Everyone starts on the same Wikipedia article and races to the same target using only the links inside the article body.

## Run it

```bash
npm start          # http://localhost:3000  (PORT=8080 npm start to change)
npm test
```

You need Node 18 or newer. There are no dependencies to install.

To play with friends on the same network, share `http://<your-ip>:3000/?room=CODE`. To play over the internet, deploy it to any Node host (Render, Fly.io, Railway, a VPS) or tunnel it with `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.

## How it plays

1. Someone creates a room and shares the 4-letter code or the invite link.
2. The host picks a start and a target. They can type titles or press 🎲 to get a random pair, drawn either from well-known articles or from any article.
3. The host sets the rules:
   - **Winner:** fewest clicks or fastest time.
   - **Click limit** and **time limit**.
   - **Back button:** allowed or not. Each back costs a click.
   - **Show opponents' pages live:** if this is off, you only see opponents' click counts until the race ends.
4. After a synchronized 3-second countdown, everyone races. The sidebar shows live standings, and you get a toast when someone finishes.
5. The results screen shows each player's full path. The host can start a new round with one click.

People who join mid-race spectate until the next round. If you refresh or drop your connection, you rejoin automatically, because your identity is kept in `localStorage`. If the host leaves, another player becomes host.

## How it works

- **`server.js`** is a plain `node:http` server. It serves `public/`, a JSON action API and a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream for each player, so state changes reach every player instantly.
- **`lib/game.js`** holds the room and race logic. The server is authoritative. A move is accepted only if the clicked title is in the current article's link list from the Wikipedia API. Redirects are resolved before checking whether a player reached the target.
- **`lib/wiki.js`** wraps the Wikipedia Action API (`action=parse`). It uses an LRU cache and de-duplicates requests that are already in flight, so a room full of players opening the same start page triggers only one fetch.
- **`public/`** is a vanilla JS client. It removes navboxes, sidebars and categories, and disables every link that isn't a valid in-game link.

Rooms live in memory. Restarting the server clears them.
