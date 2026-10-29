# Zombie Arena

A lightweight real-time, top-down **3D co-op zombie shooter**. Join a lobby, survive waves with friends, revive the fallen, chat in-game.

- Client: static files, **Three.js** (loaded from a CDN), no build step.
- Server: one small Node file set (`ws` is the only dependency). Authoritative simulation at 20 ticks/s.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000   (admin: http://localhost:3000/admin.html)
```

Open the page in two browser tabs to try multiplayer. `npm test` runs the server and client smoke tests.

## Controls

| Key | Action |
|---|---|
| WASD / Arrow keys | Walk (you shoot in the direction you last walked) |
| Space | Shoot (hold) |
| E | Equip the nearest item on the ground (weapon or heal item) |
| Q | Drop your weapon |
| H | Use a heal item |
| G | Drop a heal item |
| **Enter** | **Open chat / send message** (Esc cancels). Messages also pop up as speech bubbles over heads |
| Tab | Switch who you spectate while dead |
| M | Mute sound |

## Rules

- **Lobby:** create a room (name, map, wave count, difficulty, max players) or join one. The host starts the game. People can also join a game in progress.
- **Waves:** set any number of waves (1-99), or `0` for endless. More zombies, runners and tanks every wave; a tank boss every 5th wave.
- **Difficulty:** Easy / Normal / Hard / Nightmare scale zombie health, speed, damage, count and drop rate.
- **Death & revive:** when you die you leave a grave. A living teammate must **stand on the grave for 30 seconds** to revive you (progress slowly drains if they step off). You come back with half health. You cannot revive yourself. If everyone is dead, the game is over.
- **Items:** weapons and heal items lie around the map and drop from zombies. Dying drops your weapon.
- **Chat:** lobby chat before you join, room chat in the room lobby, and in-game chat during play (rate-limited, 120 chars max, HTML is stripped).

## Admin: maps and items

Open `/admin.html`, enter the admin password (the `ADMIN_PASSWORD` environment variable on the server; default `admin` - **change it**).

- **Maps:** paint walls, crates, player spawns, zombie spawns and item spawns on a grid (16x16 up to 64x64). Two maps ship by default (Dead Town, Bunker Yard).
- **Items:** create custom weapons (damage, fire rate, range, pellets, spread, pierce, colour) and heal items. They appear on item spawns and in zombie drops.

Data is stored in `data/data.json` on the server (set `DATA_FILE` to move it).

## Deploying (including Vercel)

**Vercel cannot host the game server** - serverless functions don't keep WebSocket connections open. So deploy in two parts:

1. **Game server** on any host with WebSocket support (Render, Railway, Fly.io, a VPS...):
   - Start command: `npm start`
   - Env vars: `ADMIN_PASSWORD=<something secret>`, optionally `ALLOWED_ORIGIN=https://your-app.vercel.app`, and `DATA_FILE` pointing at a persistent disk if your host has one (free tiers often wipe the disk, which resets admin-made maps/items).
2. **Client** on Vercel:
   - Edit `client/config.js` and set `server: "https://your-game-server.example.com"`.
   - Import the repo into Vercel (the included `vercel.json` serves the `client/` folder; or set the Root Directory to `client`). No build command needed.

You can also skip Vercel entirely: the Node server serves the client itself, so one service on Render/Railway/Fly runs everything.

## Layout

```
client/   index.html, style.css, config.js, game.js (UI/net/input), world.js (Three.js scene), util.js, admin.html/js
server/   server.js (HTTP + WebSocket + admin API), game.js (simulation), content.js (default maps/items, validation)
test/     run.js (server + admin API tests), client-smoke.js (client modules against the real server)
```
