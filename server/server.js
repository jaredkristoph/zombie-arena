'use strict';
// HTTP (static client + admin REST API) and WebSocket (lobby + game) server.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, TICK_HZ, DIFF } = require('./game');
const { DEFAULT_ITEMS, buildDefaultMaps, sanitizeMap, sanitizeItem, cleanName } = require('./content');

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_ROOMS = 30;
const MAX_CONN_PER_IP = 10;

// ---------- persistent content ----------
const store = { maps: [], items: [] };
function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    store.maps = (raw.maps || []).map((m) => { const c = sanitizeMap(m); if (m.builtin) c.builtin = true; return c; });
    store.items = (raw.items || []).map((i) => { const c = sanitizeItem(i); if (i.builtin) c.builtin = true; return c; });
  } catch (e) { /* first run or corrupt: fall through to defaults */ }
  if (!store.maps.length) store.maps = buildDefaultMaps();
  if (!store.items.some((i) => i.id === 'pistol')) store.items.unshift(DEFAULT_ITEMS[0]);
  if (store.items.length < 2) store.items = DEFAULT_ITEMS.map((i) => ({ ...i }));
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
    leaveRoom(c);
    conns.delete(c.id);
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
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
      c.send({ t: 'hello_ok', id: c.id, name: c.name, maps: store.maps.map((x) => ({ id: x.id, name: x.name, w: x.w, h: x.h })), rooms: roomList() });
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
        maxPlayers: Math.min(8, Math.max(1, Math.round(Number(m.max)) || 4)),
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
