# Wikirace design

Screen designs for the multiplayer Wikirace game. Live canvas: https://claude.ai/artifact/KcHdWW2BnXCSTQ9dDQw8TN

| File | Screen |
| --- | --- |
| `Main.dc.html` | Home: create a room (speed race, Wiki golf, click-limited, Philosophy), join by code, daily race, public rooms |
| `Lobby.dc.html` | Room lobby: start/target articles, win condition, click and time limits, house rules, players and ready states |
| `Race.dc.html` | Live race: article view with only body links clickable, timer, clicks, your path, live standings, race feed |
| `Results.dc.html` | Results: ranking with time, clicks and route, shortest possible route (BFS), room totals, rematch |
| `canvas.json` | Canvas layout of the four screens |

These are Design Component files (`.dc.html`) from the canvas editor. They load the editor's `support.js` runtime, so they render on the canvas rather than as standalone pages. Treat them as the visual reference for building the app.

## Look

- Fonts: Source Serif 4 (headings, article text), Inter (UI)
- Ground `#F6F6F3`, surface `#FFFFFF`, ink `#1A1A1A`, muted text `#5B5B55`, borders `#DEDED8`
- Link / primary `#3366CC`, target article `#9A3412` on `#FFF4EC`
