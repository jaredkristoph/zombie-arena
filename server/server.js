'use strict';
// HTTP (static client + admin REST API) and WebSocket (lobby + game) server.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, TICK_HZ, DIFF, ACC_COUNT, FIT_COUNT } = require('./game');
const { DEFAULT_ITEMS, buildDefaultMaps, sanitizeMap, sanitizeItem, cleanName } = require('./content');

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_ROOMS = 30;
const MAX_CONN_PER_IP = 10;

// ---------- persistent content ----------
const store = { maps: [], items: [], seeded: [] };
const sanitizeMapKeep = (m) => { const c = sanitizeMap(m); c.builtin = true; return c; };
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    store.maps = (raw.maps || []).map((m) => { const c = sanitizeMap(m); if (m.builtin) c.builtin = true; return c; });
    store.seeded = Array.isArray(raw.seeded) ? raw.seeded.slice(0, 50) : [];
    store.items = (raw.items || []).map((i) => { const c = sanitizeItem(i); if (i.builtin) c.builtin = true; return c; });
  } catch (e) { /* first run or corrupt: fall through to defaults */ }
  if (!store.maps.length) store.maps = buildDefaultMaps();
  if (!store.items.some((i) => i.id === 'pistol')) store.items.unshift(DEFAULT_ITEMS[0]);
  if (store.items.length < 2) store.items = DEFAULT_ITEMS.map((i) => ({ ...i }));
  // balance tweak: katana damage halved (once; later admin edits are kept)
  if (!store.seeded.includes('katana-v2')) {
    const k = store.items.find((i) => i.id === 'katana');
    if (k && k.builtin && k.damage === 26) k.damage = 13;
    store.seeded.push('katana-v2');
  }
  // gun weights (once): heavier guns slow you down; the Gatling / Launcher speed tweaks now come from their weight
  if (!store.seeded.includes('weights-v1')) {
    const W = { pistol: 1, smg: 2.5, shotgun: 3.5, rifle: 4, sniper: 6, gatling: 9, flamethrower: 8, launcher: 7, sword: 2.5, katana: 1.2, greatsword: 6 };
    for (const i of store.items) if (i.builtin && W[i.id] !== undefined && i.weight === undefined) i.weight = W[i.id];
    for (const id of ['gatling', 'launcher', 'turret', 'barricade', 'mine', 'crate']) { const i = store.items.find((x) => x.id === id); if (i && i.builtin) delete i.move; }
    store.seeded.push('weights-v1');
  }
  // the zombie-defense map "Outpost" is added to existing data files once
  if (!store.seeded.includes('outpost-v1')) {
    if (!store.maps.some((m) => m.id === 'outpost')) store.maps.push(sanitizeMapKeep(buildDefaultMaps()[2]));
    store.seeded.push('outpost-v1');
  }
  // Outpost v3: bigger fort, wide gaps, no doors (replaces the built-in copy once)
  if (!store.seeded.includes('outpost-v3')) {
    const fresh = sanitizeMapKeep(buildDefaultMaps()[2]), at = store.maps.findIndex((m) => m.id === 'outpost');
    if (at >= 0 && store.maps[at].builtin) store.maps[at] = fresh;
    store.seeded.push('outpost-v3');
  }
  // katana: walk 100% faster while it is in your hands (once)
  if (!store.seeded.includes('katana-run')) {
    const k = store.items.find((i) => i.id === 'katana');
    if (k && k.builtin && !k.move) k.move = 2;
    store.seeded.push('katana-run');
  }
  // katana run speed lowered from +100% to +50% (once)
  if (!store.seeded.includes('katana-run-150')) {
    const k = store.items.find((i) => i.id === 'katana');
    if (k && k.builtin && k.move === 2) k.move = 1.5;
    store.seeded.push('katana-run-150');
  }
  // Dead Town was redesigned (ramps, doors, bushes, water; once; a map the admin made or renamed is left alone)
  if (!store.seeded.includes('deadtown-v3')) {
    const i = store.maps.findIndex((m) => m.id === 'dead-town' && m.builtin);
    if (i >= 0) store.maps[i] = sanitizeMapKeep(buildDefaultMaps()[0]);
    store.seeded.push('deadtown-v3');
  }
  // items added in later versions are seeded once into existing data files (and can then be deleted by the admin)
  for (const d of DEFAULT_ITEMS) {
    if (!['ammo', 'sword', 'katana', 'greatsword', 'vest', 'plate', 'grenade', 'gatling', 'flamethrower', 'launcher', 'turret', 'barricade', 'mine', 'crate'].includes(d.id) || store.seeded.includes(d.id)) continue;
    if (!store.items.some((i) => i.id === d.id)) store.items.push({ ...d });
    store.seeded.push(d.id);
  }
}
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Could not save data:', e.message); }
}
loadStore();
const itemMap = () => Object.fromEntries(store.items.map((i) => [i.id, i]));

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const failedLogins = new Map();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function isAdmin(req) {
  const ip = req.socket.remoteAddress;
  const f = failedLogins.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 60000) return null; // locked out
  const ok = crypto.timingSafeEqual(sha(req.headers['x-admin-key'] || ''), sha(ADMIN_PASSWORD));
  if (!ok) failedLogins.set(ip, { n: (f && Date.now() - f.t < 60000 ? f.n : 0) + 1, t: Date.now() });
  else failedLogins.delete(ip);
  return ok;
}

async function handleApi(req, res, url) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size, players: conns.size });
  if (req.method === 'GET' && p === '/api/maps') return json(res, 200, store.maps);
  if (req.method === 'GET' && p === '/api/items') return json(res, 200, store.items);
  if (p.startsWith('/api/admin/')) {
    const ok = isAdmin(req);
    if (ok === null) return json(res, 429, { error: 'Too many attempts, wait a minute' });
    if (!ok) return json(res, 401, { error: 'Wrong admin password' });
    if (req.method === 'GET' && p === '/api/admin/check') return json(res, 200, { ok: true });
    try {
      if (req.method === 'PUT' && p === '/api/admin/maps') {
        const m = sanitizeMap(await readBody(req));
        const i = store.maps.findIndex((x) => x.id === m.id);
        if (i >= 0) { if (store.maps[i].builtin) m.builtin = true; store.maps[i] = m; } else store.maps.push(m);
        saveStore();
        return json(res, 200, m);
      }
      if (req.method === 'PUT' && p === '/api/admin/items') {
        const it = sanitizeItem(await readBody(req));
        const i = store.items.findIndex((x) => x.id === it.id);
        if (i >= 0) { if (store.items[i].builtin) it.builtin = true; store.items[i] = it; } else store.items.push(it);
        saveStore();
        return json(res, 200, it);
      }
      let m = p.match(/^\/api\/admin\/maps\/([\w-]+)$/);
      if (req.method === 'DELETE' && m) {
        if (store.maps.length <= 1) return json(res, 400, { error: 'Keep at least one map' });
        store.maps = store.maps.filter((x) => x.id !== m[1]);
        saveStore();
        return json(res, 200, { ok: true });
      }
      m = p.match(/^\/api\/admin\/items\/([\w-]+)$/);
      if (req.method === 'DELETE' && m) {
        if (m[1] === 'pistol') return json(res, 400, { error: 'The pistol cannot be deleted' });
        store.items = store.items.filter((x) => x.id !== m[1]);
        saveStore();
        return json(res, 200, { ok: true });
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  if (p === '/create') p = '/index.html'; // beta: same page, room creation unlocked (see client/game.js)
  const file = path.normalize(path.join(CLIENT_DIR, p));
  if (!file.startsWith(CLIENT_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url).catch(() => { try { json(res, 500, { error: 'Server error' }); } catch (e) { /* ignore */ } });
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  try { serveStatic(req, res, url); } catch (e) { res.writeHead(400); res.end('Bad request'); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048, perMessageDeflate: false });
const conns = new Map();
const rooms = new Map();
const lobbyChat = [];
let nextConn = 1;
const ipCount = new Map();

function sanitizeChat(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
const roomList = () => [...rooms.values()].map((r) => r.info());
let roomsTimer = null;
function pushRooms() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = null;
    const msg = JSON.stringify({ t: 'rooms', rooms: roomList() });
    for (const c of conns.values()) if (!c.room && c.named) c.raw(msg);
  }, 250);
}
function lobbySay(msg) {
  lobbyChat.push(msg);
  if (lobbyChat.length > 30) lobbyChat.shift();
  const s = JSON.stringify(msg);
  for (const c of conns.values()) if (!c.room && c.named) c.raw(s);
}
// ---------- reconnecting ----------
// When a connection drops during a game the player keeps their seat for RECONNECT_GRACE ms. The browser remembers a
// token (per tab) and sends it in "hello"; if it matches, the new connection takes over the seat. A page refresh works the
// same way, even if the old socket has not been noticed as closed yet.
const RECONNECT_GRACE = 90000;
const sessions = new Map(); // token -> { room, player }
const liveByToken = new Map(); // token -> connection
function dropPlayer(room, p) {
  room.leave(p.conn);
  if (!room.players.size) rooms.delete(room.id);
  pushRooms();
}
function takeOver(c, room, p, old) {
  conns.delete(c.id);
  c.id = p.id; c.name = p.name; c.room = room; c.player = p;
  conns.set(c.id, c);
  p.conn = c;
  delete p.dcAt;
  if (old) { old.replaced = true; old.room = null; old.player = null; try { old.ws.close(); } catch (e) { /* ignore */ } }
}
function leaveRoom(c) {
  const r = c.room;
  if (!r) return;
  r.leave(c);
  if (!r.players.size) rooms.delete(r.id);
  pushRooms();
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  const n = (ipCount.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) return ws.close(1013, 'Too many connections');
  ipCount.set(ip, n);
  const c = {
    id: nextConn++, ws, ip, name: '', named: false, room: null, player: null, alive: true, chatTokens: 4, chatT: Date.now(),
    raw(s) { if (ws.readyState === 1) ws.send(s); },
    send(o) { this.raw(JSON.stringify(o)); },
  };
  conns.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => {
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
    if (c.token && liveByToken.get(c.token) === c) liveByToken.delete(c.token);
    if (conns.get(c.id) === c) conns.delete(c.id);
    if (c.replaced) return; // a newer connection took over this player
    const r = c.room, p = c.player;
    if (r && p && r.state !== 'lobby' && c.token) {
      // mid-game: keep the seat so the player can come back
      const stub = { id: p.id, name: p.name, raw() {}, send() {}, dc: true, room: r, player: p };
      p.conn = stub; p.shoot = false; p.dcAt = Date.now();
      sessions.set(c.token, { room: r, player: p });
      c.room = null; c.player = null;
      pushRooms();
      return;
    }
    leaveRoom(c);
  });
  ws.on('error', () => {});
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { onMessage(c, m); } catch (e) { console.error('msg error', e); }
  });
});

function onMessage(c, m) {
  switch (m.t) {
    case 'in': if (c.player && c.room) c.room.onInput(c.player, m); return;
    case 'act': if (c.player && c.room && typeof m.k === 'string') c.room.act(c.player, m.k); return;
    case 'ping': c.send({ t: 'pong', ts: m.ts }); return;
    case 'hello': {
      c.name = cleanName(m.name, 14) || 'Survivor' + (100 + (c.id % 900));
      c.named = true;
      c.acc = Math.max(0, Math.min(ACC_COUNT - 1, Math.round(Number(m.acc)) || 0));
      c.fit = Math.max(0, Math.min(FIT_COUNT - 1, Math.round(Number(m.fit)) || 0));
      // coming back? (same token as a dropped or about-to-be-replaced connection)
      const tok = typeof m.token === 'string' ? m.token.slice(0, 40) : '';
      let back = null;
      if (tok && !c.player) {
        const old = liveByToken.get(tok);
        if (old && old !== c && old.room && old.player) back = { room: old.room, player: old.player, old };
        else {
          const s = sessions.get(tok);
          if (s && s.room.players.get(s.player.id) === s.player) back = { room: s.room, player: s.player, old: null };
        }
      }
      if (back) {
        c.token = tok;
        sessions.delete(tok);
        takeOver(c, back.room, back.player, back.old);
      } else if (!c.token) c.token = crypto.randomBytes(12).toString('hex');
      liveByToken.set(c.token, c);
      c.send({ t: 'hello_ok', dash: 1, teams: 1, build: 'b38', token: c.token, resumed: !!back, id: c.id, name: c.name, weapons: store.items.filter((i) => i.type === 'weapon').map((i) => ({ id: i.id, name: i.name, melee: !!i.melee })), maps: store.maps.map((x) => ({ id: x.id, name: x.name, w: x.w, h: x.h })), rooms: roomList() });
      if (back) { back.room.resume(back.player); pushRooms(); return; }
      c.send({ t: 'chatlog', msgs: lobbyChat });
      return;
    }
    case 'create': {
      if (!c.named || c.room) return;
      if (rooms.size >= MAX_ROOMS) return c.send({ t: 'err', msg: 'Server is full, try again later' });
      const map = store.maps.find((x) => x.id === m.map) || store.maps[0];
      const room = new Room(Math.random().toString(36).slice(2, 7), {
        name: cleanName(m.name, 22) || c.name + "'s room",
        map, items: itemMap(),
        waves: Math.min(99, Math.max(0, Math.round(Number(m.waves)))) || 0,
        difficulty: DIFF[m.difficulty] ? m.difficulty : 'normal',
        maxPlayers: Math.min(20, Math.max(1, Math.round(Number(m.max)) || 4)),
        mode: m.mode === 'pvp' ? 'pvp' : 'coop',
        teams: m.mode === 'pvp' && m.teams === true,
        allowed: Array.isArray(m.weapons) ? m.weapons.filter((x) => typeof x === 'string').slice(0, 60) : undefined,
        start: typeof m.start === 'string' ? m.start : '',
        deathDrop: m.drops !== false,
        killLimit: Math.min(200, Math.max(0, Math.round(Number(m.kills)))) || 0,
      });
      rooms.set(room.id, room);
      room.join(c);
      pushRooms();
      return;
    }
    case 'join': {
      if (!c.named || c.room) return;
      const room = rooms.get(String(m.room));
      if (!room) return c.send({ t: 'err', msg: 'That room no longer exists' });
      if (room.players.size >= room.maxPlayers) return c.send({ t: 'err', msg: 'Room is full' });
      room.join(c);
      pushRooms();
      return;
    }
    case 'acc': {
      c.acc = Math.max(0, Math.min(ACC_COUNT - 1, Math.round(Number(m.v)) || 0));
      c.fit = Math.max(0, Math.min(FIT_COUNT - 1, Math.round(Number(m.f)) || 0));
      if (c.player && c.room) { c.player.acc = c.acc; c.player.fit = c.fit; if (c.room.state === 'lobby') c.room.sendRoom(); }
      return;
    }
    case 'endgame': if (c.room && c.player && c.room.hostId === c.id) { c.room.endByHost(); pushRooms(); } return;
    case 'dash': if (c.player && c.room) c.room.dash(c.player, Number(m.dx) || 0, Number(m.dy) || 0); return;
    case 'team': if (c.room && c.player) c.room.setTeam(c.player, Number(m.team)); return;
    case 'addbot': {
      if (!c.room || !c.player) return;
      const err = c.room.addBot(c.id);
      if (err) c.send({ t: 'toast', text: err }); else pushRooms();
      return;
    }
    case 'rmbot': if (c.room && c.player) { c.room.removeBot(c.id, Number(m.id)); pushRooms(); } return;
    case 'leave': leaveRoom(c); c.send({ t: 'left', rooms: roomList() }); c.send({ t: 'chatlog', msgs: lobbyChat }); return;
    case 'start': {
      if (c.room && c.player && c.room.hostId === c.id) { c.room.startGame(); pushRooms(); }
      return;
    }
    case 'chat': {
      if (!c.named) return;
      const now = Date.now();
      c.chatTokens = Math.min(4, c.chatTokens + (now - c.chatT) / 1000);
      c.chatT = now;
      if (c.chatTokens < 1) return c.send({ t: 'toast', text: 'Slow down, you are chatting too fast' });
      const text = sanitizeChat(m.text);
      if (!text) return;
      c.chatTokens -= 1;
      if (c.room && c.player) c.room.chat(c.player, text);
      else lobbySay({ t: 'chat', id: c.id, name: c.name, color: '#9be564', text });
      return;
    }
    default:
  }
}

// game loop + heartbeat
setInterval(() => { for (const r of rooms.values()) r.tick(); }, 1000 / TICK_HZ);
setInterval(() => {
  for (const [tok, s] of [...sessions]) {
    if (s.room.players.get(s.player.id) !== s.player) { sessions.delete(tok); continue; }
    if (Date.now() - s.player.dcAt > RECONNECT_GRACE || s.room.state === 'lobby') { sessions.delete(tok); dropPlayer(s.room, s.player); }
  }
}, 2000);
setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Zombie Arena server on http://localhost:${PORT}  (admin: /admin)`);
    if (ADMIN_PASSWORD === 'admin') console.warn('WARNING: using default admin password. Set ADMIN_PASSWORD env var!');
  });
}
module.exports = { server, store, rooms };
