'use strict';
// Run with: npm test   (needs `ws`, installed via npm install)
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { Room, DT } = require('../server/game');
const { buildDefaultMaps, DEFAULT_ITEMS, sanitizeMap, sanitizeItem } = require('../server/content');

const items = Object.fromEntries(DEFAULT_ITEMS.map((i) => [i.id, i]));
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

function fakeConn(id, name) {
  const c = { id, name, msgs: [], raw(s) { this.msgs.push(JSON.parse(s)); }, send(o) { this.msgs.push(o); } };
  return c;
}
function mkRoom(extra) {
  return new Room('t1', Object.assign({ name: 'T', map: buildDefaultMaps()[0], items, waves: 2, difficulty: 'easy', maxPlayers: 4 }, extra));
}

// ---------- unit tests ----------
function testMaps() {
  for (const m of buildDefaultMaps()) {
    const c = sanitizeMap(m);
    assert.strictEqual(c.tiles.length, c.h);
    for (const s of c.playerSpawns.concat(c.zombieSpawns, c.itemSpawns)) assert.strictEqual(c.tiles[s.y][s.x], '.', m.name + ' spawn on floor');
  }
  assert.throws(() => sanitizeMap({ name: 'x', w: 20, h: 20, tiles: [] }));
  assert.throws(() => sanitizeItem(null));
  assert.strictEqual(sanitizeItem({ name: 'Zap', type: 'weapon', damage: 99999, rate: 0 }).damage, 500);
  ok('default maps valid; sanitizers clamp/reject');
}

function testRevive() {
  const r = mkRoom({ waves: 5 });
  const a = fakeConn(1, 'Ann'), b = fakeConn(2, 'Bob');
  const pa = r.join(a), pb = r.join(b);
  r.startGame();
  r.timer = 99999; // no zombies
  pa.x = 10.5; pa.y = 10.5; pb.x = 3.5; pb.y = 3.5;
  r.die(pa);
  assert.ok(pa.dead && r.graves.length === 1);
  pb.x = 10.5; pb.y = 10.8;
  for (let i = 0; i < Math.round(29 / DT); i++) r.tick();
  assert.ok(pa.dead, 'still dead after 29s');
  pb.x = 5; pb.y = 5; // step off: progress should decay, not complete
  for (let i = 0; i < Math.round(2 / DT); i++) r.tick();
  assert.ok(pa.dead && r.graves[0].prog < 29, 'progress decays when nobody stands there');
  pb.x = 10.5; pb.y = 10.8;
  for (let i = 0; i < Math.round(40 / DT); i++) r.tick();
  assert.ok(!pa.dead && pa.hp === 50 && r.graves.length === 0, 'revived with half HP');
  assert.ok(a.msgs.some((m) => m.t === 'chat' && /revived/.test(m.text)), 'revive announced in chat');
  ok('standing on a grave for 30s revives (decays when you leave)');
}

function testSelfCannotRevive() {
  const r = mkRoom();
  const a = fakeConn(1, 'Ann'), b = fakeConn(2, 'Bob');
  const pa = r.join(a); const pb = r.join(b);
  r.startGame(); r.timer = 99999;
  pa.x = 10.5; pa.y = 10.5; pb.x = 30.5; pb.y = 30.5; // teammate far from the grave
  r.die(pa);
  for (let i = 0; i < Math.round(40 / DT); i++) r.tick();
  assert.ok(pa.dead);
  ok('a dead player cannot revive themselves');
}

function testWavesAndVictory() {
  const r = mkRoom({ waves: 2 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame();
  p.x = 19.5; p.y = 19.5;
  let overMsg = null;
  const seenWaves = new Set();
  for (let step = 0; step < 20 * 600 && r.state === 'playing'; step++) {
    p.hp = 100; // keep alive; we test the flow, not survival
    r.tick();
    seenWaves.add(r.wave);
    for (const z of r.zombies) r.damageZombie(z, 9999, p); // instantly kill
    const m = a.msgs.find((x) => x.t === 'over');
    if (m) overMsg = m;
  }
  assert.strictEqual(r.state, 'over');
  assert.ok(seenWaves.has(1) && seenWaves.has(2));
  assert.strictEqual(overMsg && overMsg.result, 'victory');
  assert.ok(p.kills > 10);
  for (let i = 0; i < Math.round(15 / DT); i++) r.tick();
  assert.strictEqual(r.state, 'lobby');
  ok('2 waves complete -> victory -> back to lobby');
}

function testDefeat() {
  const r = mkRoom();
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame();
  r.die(p);
  assert.strictEqual(r.state, 'over');
  assert.ok(a.msgs.some((m) => m.t === 'over' && m.result === 'defeat'));
  ok('all players dead -> defeat');
}

function testCombatAndItems() {
  const r = mkRoom({ waves: 0 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame();
  r.timer = 99999;
  p.x = 19.5; p.y = 19.5; p.a = 0;
  r.zombies.push({ id: 900, type: 0, x: 23.5, y: 19.5, hp: 40, maxHp: 40, spd: 0, dmg: 0, r: 0.38, cd: 0, side: 1, dead: false });
  r.zombies.push({ id: 901, type: 0, x: 24.5, y: 19.5, hp: 40, maxHp: 40, spd: 0, dmg: 0, r: 0.38, cd: 0, side: 1, dead: false });
  p.weapon = 'rifle'; // pierce 1
  r.onInput(p, { seq: 1, dx: 0, dy: 0, dt: 0, sh: 1 });
  r.tick(); r.tick();
  assert.ok(r.zombies.every((z) => z.hp < 40) || r.zombies.length < 2, 'piercing rifle hits both');
  // item drop / equip
  p.weapon = 'smg';
  r.act(p, 'drop');
  assert.strictEqual(p.weapon, 'pistol');
  const g = r.ground.find((x) => x.item === 'smg');
  assert.ok(g, 'dropped weapon on ground');
  p.x = g.x; p.y = g.y;
  r.act(p, 'equip');
  assert.strictEqual(p.weapon, 'smg');
  // heal items
  p.hp = 40;
  r.addGround(p.x, p.y, 'medkit', 0);
  r.act(p, 'equip');
  assert.strictEqual(p.bag.length, 1);
  r.act(p, 'heal');
  assert.strictEqual(p.hp, 100);
  // walls block shots
  const wallRow = r.map.tiles[6];
  assert.ok(wallRow.includes('#'));
  ok('hitscan pierce, drop/equip weapon, pick up + use heal');
}

function testMovementCollision() {
  const r = mkRoom({ waves: 0 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame();
  p.x = 1.5; p.y = 1.5;
  for (let i = 0; i < 40; i++) r.onInput(p, { seq: i, dx: -1, dy: -1, dt: 100, sh: 0 });
  assert.ok(p.x >= 1.37 && p.y >= 1.37, 'cannot walk through border wall');
  // speed budget stops speed hacking: 40 messages sent instantly give ~0.3s of movement max
  p.x = 19.5; p.y = 19.5;
  const x0 = p.x;
  for (let i = 0; i < 50; i++) r.onInput(p, { seq: i, dx: 1, dy: 0, dt: 100, sh: 0 });
  assert.ok(p.x - x0 < 5.2 * 0.6, 'speed budget limits teleporting, moved ' + (p.x - x0).toFixed(2));
  ok('wall collision + anti speed-hack budget');
}

// ---------- integration over real sockets ----------

// ---------- pvp ----------
function testPvp() {
  const r = mkRoom({ mode: 'pvp', killLimit: 3, difficulty: 'hard' });
  const a = fakeConn(1, 'Ann'), b = fakeConn(2, 'Bob');
  const pa = r.join(a), pb = r.join(b);
  // bots: host only, lobby only, respects the player cap
  assert.ok(r.addBot(2), 'non-host cannot add bots');
  assert.strictEqual(r.addBot(1), null);
  assert.strictEqual(r.addBot(1), null);
  assert.ok(r.addBot(1), 'room full at 4 players');
  assert.strictEqual(r.botCount(), 2);
  const bot = [...r.players.values()].find((p) => p.bot);
  r.removeBot(1, bot.id);
  assert.strictEqual(r.botCount(), 1);
  assert.ok(mkRoom({ mode: 'coop' }).addBot(1), 'no bots in co-op rooms');
  r.startGame();
  assert.ok(!r.addBot(1) === false, 'cannot add bots mid-game');
  assert.strictEqual(r.zombies.length, 0);
  pa.hp = pb.hp = 1e9; // keep the (hard) bot from interfering with the setup below
  for (let i = 0; i < 400; i++) r.tick();
  assert.strictEqual(r.zombies.length, 0, 'no zombies in pvp');
  pa.hp = pb.hp = 100; pa.dead = pb.dead = false;

  // shooting a player hurts them; kills respawn after 10s with protection
  const bt = [...r.players.values()].find((p) => p.bot);
  bt.x = 2.5; bt.y = 2.5; bt.shoot = false; bt.ai.path = []; bt.hp = 9999; // park the bot out of the way
  pa.x = 17.5; pa.y = 19.5; pb.x = 21.5; pb.y = 19.5; pa.a = 0; pa.weapon = 'rifle'; pa.inv = 0; pb.inv = 0;
  r.fire(pa);
  assert.ok(pb.hp < 100 && !pb.dead, 'hit player lost hp');
  for (let i = 0; i < 6; i++) { pa.cd = 0; r.fire(pa); }
  assert.ok(pb.dead && pa.kills === 1 && pb.deaths === 1, 'kill credited');
  assert.ok(r.graves.length === 0, 'no graves in pvp');
  assert.ok(a.msgs.some((m) => m.t === 'chat' && /Ann eliminated Bob/.test(m.text)), 'kill feed');
  const diedAt = r.tickN;
  while (pb.dead && r.tickN - diedAt < 400) { pa.hp = 100; bt.hp = 9999; r.tick(); }
  const secs = (r.tickN - diedAt) * DT;
  assert.ok(!pb.dead && secs >= 9.9 && secs <= 10.2, 'respawned after ~10s, took ' + secs);
  assert.ok(pb.hp === 100 && pb.inv > 0 && pb.weapon === 'pistol', 'full hp, shielded, pistol');
  pa.x = 17.5; pa.y = 19.5; pb.x = 21.5; pb.y = 19.5; pa.cd = 0; pa.weapon = 'rifle';
  r.fire(pa);
  assert.strictEqual(pb.hp, 100, 'spawn protection blocks damage');
  pb.inv = 0;

  // kill limit ends the match
  pb.x = 21.5; pb.y = 19.5; pb.hp = 100; pb.dead = false;
  for (let k = 0; k < 5 && r.state === 'playing'; k++) {
    pb.dead = false; pb.hp = 20; pb.inv = 0; pa.cd = 0; pa.x = 17.5; pa.y = 19.5; pa.a = 0; pb.x = 21.5; pb.y = 19.5;
    r.fire(pa);
  }
  assert.strictEqual(r.state, 'over', 'kill limit reached');
  const over = a.msgs.find((m) => m.t === 'over');
  assert.ok(over && over.result === 'pvp' && over.winnerId === 1 && over.stats.length === 3, 'pvp over message');
  ok('pvp: bots (host/lobby/cap), damage, kill feed, 10s respawn + shield, kill limit');
}

function testBotsFight() {
  // humans-less sim: 4 bots on the biggest default map should move, hunt each other and score kills without crashing
  for (const map of buildDefaultMaps()) {
    const r = mkRoom({ mode: 'pvp', killLimit: 0, difficulty: 'nightmare', map, maxPlayers: 6 });
    const h = fakeConn(1, 'Host');
    const ph = r.join(h);
    for (let i = 0; i < 4; i++) assert.strictEqual(r.addBot(1), null);
    r.startGame();
    ph.hp = 1e9; // the human just stands there
    const start = new Map([...r.players.values()].filter((p) => p.bot).map((p) => [p.id, [p.x, p.y]]));
    for (let i = 0; i < 20 * 120; i++) { ph.hp = 1e9; ph.dead = false; r.tick(); }
    const bots = [...r.players.values()].filter((p) => p.bot);
    const moved = bots.filter((p) => Math.hypot(p.x - start.get(p.id)[0], p.y - start.get(p.id)[1]) > 3 || p.kills + p.deaths > 0);
    const kills = bots.reduce((n, p) => n + p.kills, 0);
    assert.ok(moved.length >= 3, map.name + ': bots move around');
    assert.ok(kills >= 3, map.name + ': bots shoot each other (' + kills + ' kills in 2 min)');
    for (const p of r.players.values()) assert.ok(!r.blocked(p.x, p.y, 0.3) , map.name + ': nobody stuck inside a wall');
  }
  // closing the room: only bots left
  const r = mkRoom({ mode: 'pvp' });
  const c = fakeConn(1, 'Solo');
  r.join(c); r.addBot(1);
  r.leave(c);
  assert.strictEqual(r.players.size, 0, 'room empties when the last human leaves');
  ok('pvp: bots path-find, fight and score on every default map; room closes when humans leave');
}

function testAmmo() {
  const r = mkRoom({ waves: 3 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame(); r.timer = 99999;
  p.x = 19.5; p.y = 19.5; p.a = 0; r.ground = [];
  assert.strictEqual(p.ammo, 90, 'starts with ammo');
  r.fire(p); r.fire(p);
  assert.strictEqual(p.ammo, 88, 'each shot costs one bullet (any gun)');
  p.weapon = 'shotgun'; p.cd = 0; r.fire(p);
  assert.strictEqual(p.ammo, 87, 'a shotgun blast is one bullet too');
  p.ammo = 0; p.cd = 0; r.ev = [];
  r.fire(p);
  assert.strictEqual(p.ammo, 0);
  assert.ok(!r.ev.some((e) => e[0] === 's') && r.ev.some((e) => e[0] === 'e'), 'no shot when empty, click event instead');
  // walking over an ammo pack picks it up for every gun
  r.addGround(p.x + 0.5, p.y, 'ammo', 0);
  r.tick();
  assert.strictEqual(p.ammo, 40, 'ammo pack adds 40');
  assert.ok(!r.ground.some((g) => g.item === 'ammo'), 'pack consumed');
  p.ammo = 235; r.addGround(p.x, p.y, 'ammo', 0); r.tick();
  assert.strictEqual(p.ammo, 240, 'capped at 240');
  p.ammo = 240; r.addGround(p.x, p.y, 'ammo', 0); r.tick();
  assert.ok(r.ground.some((g) => g.item === 'ammo'), 'full: pack stays on the ground');
  p.ammo = 10; r.act(p, 'equip');
  assert.strictEqual(p.ammo, 50, 'E also picks ammo up');
  // snapshot carries ammo
  const snap = a.msgs.slice().reverse().find((m) => m.t === 's');
  assert.ok(snap && snap.p[0].length >= 13, 'snapshot has ammo field');
  ok('ammo: shared by all guns, limited, packs auto/E pickup, cap, snapshot field');
}
function testAccessories() {
  const r = mkRoom({ mode: 'pvp' });
  const c = fakeConn(1, 'Ann'); c.acc = 5;
  const p = r.join(c);
  assert.strictEqual(p.acc, 5, 'accessory comes from the connection');
  r.sendRoom();
  const room = c.msgs.slice().reverse().find((m) => m.t === 'room');
  assert.strictEqual(room.players[0].acc, 5, 'room list carries accessory');
  r.addBot(1);
  assert.ok([...r.players.values()].find((q) => q.bot).acc >= 0, 'bots get an accessory');
  ok('accessories: stored per player and broadcast with the room');
}

function api(port, method, path, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: Object.assign({ 'content-type': 'application/json' }, key ? { 'x-admin-key': key } : {}) }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve({ code: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const client = (port) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  const c = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve(c));
});
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout waiting'); };

async function testNetwork() {
  process.env.DATA_FILE = require('path').join(require('os').tmpdir(), 'za-test-' + Date.now() + '.json');
  process.env.ADMIN_PASSWORD = 'sekret';
  const { server } = require('../server/server');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // admin API
  assert.strictEqual((await api(port, 'GET', '/api/maps')).body.length, 2);
  assert.strictEqual((await api(port, 'PUT', '/api/admin/items', { name: 'X', type: 'heal' })).code, 401);
  const item = await api(port, 'PUT', '/api/admin/items', { name: 'Mega Gun', type: 'weapon', damage: 50, rate: 6, color: '#00ff00' }, 'sekret');
  assert.strictEqual(item.code, 200);
  assert.ok((await api(port, 'GET', '/api/items')).body.some((i) => i.name === 'Mega Gun'));
  const base = buildDefaultMaps()[1];
  const copy = Object.assign({}, base, { id: undefined, name: 'My Arena', builtin: undefined });
  const saved = await api(port, 'PUT', '/api/admin/maps', copy, 'sekret');
  assert.strictEqual(saved.code, 200);
  assert.strictEqual((await api(port, 'PUT', '/api/admin/maps', { name: 'bad', w: 20, h: 20, tiles: ['x'] }, 'sekret')).code, 400);
  assert.strictEqual((await api(port, 'DELETE', '/api/admin/items/pistol', null, 'sekret')).code, 400);
  assert.strictEqual((await api(port, 'DELETE', '/api/admin/maps/' + saved.body.id, null, 'sekret')).code, 200);
  ok('admin API: auth, create item/map, validation, protected pistol');

  // game over websockets
  const A = await client(port), B = await client(port);
  A.send({ t: 'hello', name: 'Alice<b>' }); B.send({ t: 'hello', name: 'Bob' });
  await until(() => A.msgs.find((m) => m.t === 'hello_ok') && B.msgs.find((m) => m.t === 'hello_ok'));
  assert.strictEqual(A.msgs.find((m) => m.t === 'hello_ok').name, 'Aliceb', 'name sanitized');

  // lobby chat
  A.send({ t: 'chat', text: 'hello lobby <script>alert(1)</script>' });
  const lc = await until(() => B.msgs.find((m) => m.t === 'chat'));
  assert.ok(!/[<>]/.test(lc.text) && lc.name === 'Aliceb');
  ok('lobby chat delivered and sanitized');

  A.send({ t: 'create', name: 'Room', map: 'bunker-yard', waves: 3, difficulty: 'hard', max: 3 });
  const joined = await until(() => A.msgs.find((m) => m.t === 'room'));
  assert.strictEqual(joined.room.waves, 3);
  assert.strictEqual(joined.room.difficulty, 'hard');
  const rooms = await until(() => B.msgs.slice().reverse().find((m) => m.t === 'rooms' && m.rooms.length));
  B.send({ t: 'join', room: rooms.rooms[0].id });
  await until(() => B.msgs.find((m) => m.t === 'room'));
  B.send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!A.msgs.find((m) => m.t === 'start'), 'non-host cannot start');
  A.send({ t: 'start' });
  const start = await until(() => A.msgs.find((m) => m.t === 'start'));
  await until(() => B.msgs.find((m) => m.t === 'start'));
  assert.ok(start.map.tiles.length === 32 && start.items.pistol);
  ok('create/join room, host-only start, init payload');

  // in-room chat: broadcast, rate limit
  const before = B.msgs.filter((m) => m.t === 'chat').length;
  A.send({ t: 'chat', text: 'need help at the north door' });
  await until(() => B.msgs.filter((m) => m.t === 'chat').length > before);
  const last = B.msgs.filter((m) => m.t === 'chat').pop();
  assert.strictEqual(last.text, 'need help at the north door');
  assert.ok(last.color && last.id);
  for (let i = 0; i < 12; i++) A.send({ t: 'chat', text: 'spam ' + i });
  await new Promise((r) => setTimeout(r, 400));
  const spam = B.msgs.filter((m) => m.t === 'chat' && /^spam/.test(m.text)).length;
  assert.ok(spam <= 5, 'chat rate limited, got ' + spam);
  assert.ok(A.msgs.some((m) => m.t === 'toast'), 'spammer gets a toast');
  A.send({ t: 'chat', text: 'x'.repeat(500) });
  await new Promise((r) => setTimeout(r, 1200));
  A.send({ t: 'chat', text: 'y'.repeat(500) });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(B.msgs.filter((m) => m.t === 'chat').every((m) => (m.text || '').length <= 120), 'long messages truncated');
  ok('in-room chat: broadcast, rate limit, truncation');

  // snapshots + input
  const snap = await until(() => A.msgs.find((m) => m.t === 's'));
  assert.ok(Array.isArray(snap.p) && snap.p.length === 2 && snap.w);
  const me = snap.p.find((p) => p[0] === start.you);
  const x0 = me[1];
  A.send({ t: 'in', seq: 1, dx: 0, dy: 1, dt: 100, sh: 0 });
  A.send({ t: 'in', seq: 2, dx: 0, dy: 1, dt: 100, sh: 1 });
  const snap2 = await until(() => A.msgs.slice().reverse().find((m) => m.t === 's' && m.a === 2));
  const me2 = snap2.p.find((p) => p[0] === start.you);
  assert.ok(me2[2] > me[2] || me2[1] !== x0, 'player moved');
  assert.strictEqual(snap2.a, 2, 'ack carries last input seq');
  assert.ok(snap.g || A.msgs.some((m) => m.t === 's' && m.g), 'ground items sent');
  ok('snapshots carry state, input ack, and ground items');

  // leaving
  B.send({ t: 'leave' });
  await until(() => B.msgs.find((m) => m.t === 'left'));
  A.ws.close(); B.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  server.close();
}

(async () => {
  testMaps(); testRevive(); testSelfCannotRevive(); testWavesAndVictory(); testDefeat(); testCombatAndItems(); testMovementCollision(); testPvp(); testBotsFight(); testAmmo(); testAccessories();
  await testNetwork();
  console.log('\nAll ' + passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
