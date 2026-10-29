# Zombie Arena

A lightweight real-time, top-down **3D co-op zombie shooter**. Join a lobby, survive waves with friends, revive the fallen, chat in-game.

- Client: static files, **Three.js** (loaded from a CDN), no build step.
- Server: one small Node file set (`ws` is the only dependency). Authoritative simulation at 20 ticks/s.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000   (admin: http://localhost:3000/admin.html)
```

**Room creation is in beta and hidden from the main page.** Players only see the room list and can join. To create a room open **/create** (http://localhost:3000/create). It's the same game page with the *Create a room* form unlocked. (This hides the form only; it is not a password. Anyone who knows the address can use it.)

Open the page in two browser tabs to try multiplayer. `npm test` runs the server and client smoke tests.

## Controls

| Key | Action |
|---|---|
| WASD / Arrow keys | Walk |
| **Mouse** | Aim at the cursor - your character turns smoothly toward it |
| **Shift** | Dash: a quick forward roll (in the direction you move, or where you face) that makes you invincible for 1 second. The yellow bar under your health is the dash charge; it refills in 3 seconds. You can't shoot or swing while rolling |
| Space / Left click | Shoot (hold) - uses 1 bullet per shot |

Keyboard-only? Use the arrow keys (or just don't touch the mouse): you then aim in the direction you walk, with the same smooth turning. Moving the mouse switches back to mouse aim.
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

## Ammo

Bullets are **limited and shared by every gun**: you start with 90 (max 240) and each shot costs one (a shotgun blast is one bullet too). Walk over an **Ammo Pack** to grab +40 (or press E). Packs lie around the map, drop from zombies (tanks almost always), drop from players you kill in PvP, and you get +25 bullets when a wave is cleared. Dying/respawning resets you to 90. The HUD shows your count; at 0 your gun just clicks. The admin page can edit the Ammo Pack (type "Ammo pack").

## Weapons, swords and room options

- When creating a room, tick which **weapons are allowed** and pick what everyone **starts with**. Only allowed weapons spawn on the map or drop.
- **Swords** (Sword, Katana, Greatsword) are melee: one swing hits everything in a wide arc in front of you, uses no ammo and can't hit through walls. Admins can make more (Items > Type: weapon > Melee).
- PvP rooms have a tickbox: **when a player dies, a random item falls** (their gun plus a random gun / heal item and some ammo). Untick it for a pure skill match where nothing drops.
- **Spectating:** when you're dead you watch a player who is still alive. Press Tab (Shift+Tab for previous), the left/right arrows, or click to switch.

## Armor and damage

- **Armor** items (Light Vest +40, Heavy Armor +80, max 100) lie around the map and drop from kills. Press E to wear one. While you have armor it soaks 60% of every hit (the blue bar above your health) until it is used up. You lose it when you die. Admins can make more (Items > Type: Armor).
- All weapon damage is scaled to 70% (`DMG_SCALE` at the top of `server/game.js`) so fights last longer.

## Your character

The home screen and room lobby show your character on a turntable. Change the **head accessory** (25 hats: cap, cowboy hat, crown, bunny ears, halo, viking helmet, chef hat, jester, unicorn, pumpkin...) with the left/right buttons or the **left/right arrow keys**, and the **outfit** (10 styles: hoodie, red jacket, camo, striped tee, punk, lab coat, knight, overalls, ninja, or your team colour) with the outfit buttons or the **up/down arrow keys**. **Randomize look** picks both at random. Your team colour shows as a ring under your feet. It is remembered in your browser and other players see it in game. Bots get a random one.

## PvP deathmatch (with bots)

Pick **PvP deathmatch** when creating a room and set *Kills to win* (0 = endless).

- Free-for-all: shoot the other players; no zombies. Weapons and heals still spawn on the map and respawn every ~25s.
- **Respawn:** when you are killed you respawn after **10 seconds** at the spawn point farthest from your enemies, with a 2s shield (you blink; shooting ends it).
- **Bots:** the host can click **+ Add bot** in the room lobby (and remove them with the x on their chip). Bots path-find around walls, hunt the nearest player, strafe, grab better weapons and heal themselves. The room's *Bot skill* (difficulty) controls their aim and reaction time. Bots count toward the max players.

## Settings, leaving and reconnecting

- The gear button (top right, on the menu, in the room lobby and in game; **Esc** in game) opens Settings: **camera panning** (default 40%; the camera leans toward your mouse; 0 turns it off), volume and mute. They are saved in your browser.
- In game the panel also has **Leave game**, and for the host **End game for everyone**.
- If your connection drops or you refresh the page, you can come back: the server holds your seat for 90 seconds and resumes the game when you reconnect (the seat is tied to the browser tab). While you are away you stay in the arena and can be hurt.
- The Katana now does half its old damage (13).
- Every kill gives +20% move speed for 10 seconds.

## Team deathmatch

When creating a PvP room, choose **PvP team deathmatch (Red vs Blue)**. Players are balanced across the two teams (switch with the button in the room lobby), bots fill the smaller team, there is no friendly fire, and the first team to the kill limit wins.

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
