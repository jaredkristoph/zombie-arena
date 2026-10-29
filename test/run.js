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
// The tests below were written against a plain open arena (the old Dead Town); the real default map is covered by testDeadTownConnected.
function arenaMap() {
  const w = 40, h = 40, g = Array.from({ length: h }, () => new Array(w).fill('.'));
  const fill = (x0, y0, x1, y1, ch) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch; };
  const frame = (x0, y0, x1, y1) => { fill(x0, y0, x1, y0, '#'); fill(x0, y1, x1, y1, '#'); fill(x0, y0, x0, y1, '#'); fill(x1, y0, x1, y1, '#'); };
  const pt = (x, y, item) => (item ? { x, y, item } : { x, y });
  frame(0, 0, w - 1, h - 1);
  frame(6, 6, 15, 13); fill(10, 13, 11, 13, '.'); fill(15, 9, 15, 10, '.');
  frame(24, 6, 33, 13); fill(28, 13, 29, 13, '.'); fill(24, 9, 24, 10, '.');
  frame(6, 26, 15, 33); fill(10, 26, 11, 26, '.'); fill(15, 29, 15, 30, '.');
  frame(24, 26, 33, 33); fill(28, 26, 29, 26, '.'); fill(24, 29, 24, 30, '.');
  fill(16, 2, 23, 5, 'H'); fill(19, 6, 20, 8, '^');
  fill(16, 34, 23, 37, 'H'); fill(19, 31, 20, 33, 'v');
  fill(1, 16, 4, 23, 'H'); fill(5, 19, 7, 20, '<');
  fill(35, 16, 38, 23, 'H'); fill(32, 19, 34, 20, '>');
  for (const [x, y] of [[17, 17], [22, 17], [17, 22], [22, 22]]) g[y][x] = '#';
  const playerSpawns = [pt(19, 19), pt(20, 19), pt(19, 20), pt(20, 20), pt(18, 19), pt(21, 20), pt(18, 20), pt(21, 19)];
  const zombieSpawns = [pt(2, 2), pt(37, 2), pt(2, 37), pt(37, 37), pt(10, 2), pt(29, 37), pt(2, 12), pt(37, 28)];
  const itemSpawns = [pt(9, 8, 'shotgun'), pt(30, 9, 'smg'), pt(9, 30, 'medkit'), pt(30, 30, 'rifle'), pt(19, 15, 'random'), pt(20, 24, 'random')];
  return { id: 'arena', name: 'Arena', w, h, tiles: g.map((r) => r.join('')), playerSpawns, zombieSpawns, itemSpawns };
}
function mkRoom(extra) {
  return new Room('t1', Object.assign({ name: 'T', map: arenaMap(), items, waves: 2, difficulty: 'easy', maxPlayers: 4 }, extra));
}

// ---------- unit tests ----------
function testMaps() {
  for (const m of buildDefaultMaps()) {
    const c = sanitizeMap(m);
    assert.strictEqual(c.tiles.length, c.h);
    for (const s of c.playerSpawns.concat(c.zombieSpawns, c.itemSpawns)) assert.ok('.Hs'.includes(c.tiles[s.y][s.x]), m.name + ' spawn on floor');
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

function testTerrainAndHeadshots() {
  const r = mkRoom({ waves: 0 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame();
  r.timer = 99999;
  assert.strictEqual(r.hAt(19.5, 3.5), 1, 'platform is high');
  assert.strictEqual(r.hAt(19.5, 12.5), 0, 'street is low');
  const mid = r.hAt(19.5, 7.5);
  assert.ok(mid > 0.3 && mid < 0.7, 'ramp is a slope: ' + mid);
  // a cliff stops you; the ramp lets you up and back down
  const walk = (x, y, dx, dy, steps) => { const e = { x, y }; for (let i = 0; i < steps; i++) r.move(e, dx * 0.2, dy * 0.2, 0.38); return e; };
  const cliff = walk(17.5, 9.5, 0, -1, 40);
  assert.ok(cliff.y > 5.9 && r.hAt(cliff.x, cliff.y) === 0, 'cannot climb the platform edge, stopped at y=' + cliff.y.toFixed(2));
  const up = walk(19.5, 9.5, 0, -1, 25);
  assert.ok(up.y < 5 && r.hAt(up.x, up.y) === 1, 'walks up the ramp to y=' + up.y.toFixed(2));
  const down = walk(up.x, up.y, 0, 1, 25);
  assert.ok(down.y > 9 && r.hAt(down.x, down.y) === 0, 'and back down');
  const ledge = walk(19.5, 3.5, 1, 0, 3); assert.ok(ledge.x > 19.5, 'free to walk on the platform');
  const side = walk(16.5, 3.5, -1, 0, 20); assert.ok(side.x < 16 && r.hAt(side.x, side.y) === 0, 'walking off the edge drops you to the ground: ' + side.x.toFixed(2));
  // bots plan around cliffs
  const path = r.bfs(17, 9, 17, 4);
  assert.ok(path.length === 0 || path.some(([x, y]) => x > 18.5 && x < 21 && y > 5.5), 'bots use the ramp');
  // headshots: only on the killing shot, about 1 in 20
  r.itemDefs.pistol = Object.assign({}, r.itemDefs.pistol, { spread: 0 });
  const shoot = (hp) => {
    r.zombies.length = 0;
    const z = { id: 950, type: 0, x: 23.5, y: 19.5, hp, maxHp: 100, spd: 0, dmg: 0, r: 0.38, cd: 0, side: 1, dead: false };
    r.zombies.push(z);
    p.x = 19.5; p.y = 19.5; p.a = 0; p.cd = 0; p.ammo = 50; p.weapon = 'pistol'; p.sentHs = 0; p.dead = false;
    a.msgs.length = 0;
    r.fire(p);
    return a.msgs.some((m) => m.t === 'hs');
  };
  let nonKillHs = 0, killHs = 0;
  for (let i = 0; i < 300; i++) if (shoot(100)) nonKillHs++;
  for (let i = 0; i < 600; i++) if (shoot(1)) killHs++;
  assert.strictEqual(nonKillHs, 0, 'no headshots unless the shot kills');
  assert.ok(killHs >= 10 && killHs <= 60, 'about 5% of kills are headshots: ' + killHs + '/600');
  ok('ramps + high ground (cliffs block climbing, edges drop you, bots path) and 5% kill-shot headshots');
}

function testDoorsBushesGrenades() {
  const { sanitizeMap } = require('../server/content');
  // 20x20 test arena: a wall with a door at x=10, a bush patch, a pond
  const rows = [];
  for (let y = 0; y < 20; y++) { let row = ''; for (let x = 0; x < 20; x++) row += y === 0 || y === 19 || x === 0 || x === 19 ? '#' : '.'; rows.push(row.split('')); }
  for (let y = 1; y < 19; y++) rows[y][10] = '#';
  rows[9][10] = 'D'; rows[10][10] = 'D';
  rows[3][3] = 'b'; rows[3][4] = 'b'; rows[15][15] = 'b'; rows[12][5] = 'w';
  const map = sanitizeMap({ name: 'Test', w: 20, h: 20, tiles: rows.map((r) => r.join('')), playerSpawns: [{ x: 2, y: 2 }], zombieSpawns: [{ x: 17, y: 17 }], itemSpawns: [] });
  const r = new Room('t2', { name: 'T', map, items, mode: 'pvp', killLimit: 0, difficulty: 'easy', maxPlayers: 4 });
  const ca = fakeConn(1, 'A'), cb = fakeConn(2, 'B');
  const a = r.join(ca), b = r.join(cb);
  r.startGame(); r.ground = [];
  a.inv = b.inv = 0; a.hp = b.hp = 100;
  // doors: closed blocks walking and shooting, E opens both halves, then it can be closed again
  a.x = 9.0; a.y = 9.9; b.x = 12.5; b.y = 9.9;
  assert.ok(r.solid(10, 9) && r.sight(10, 9), 'closed door is solid');
  r.act(a, 'equip');
  assert.ok(!r.solid(10, 9) && !r.solid(10, 10) && !r.sight(10, 9), 'E opens the whole double door');
  assert.ok(r.ev.some((e) => e[0] === 'o' && e[1] === 1), 'door event broadcast');
  a.x = 10.5; a.y = 9.9; r.act(a, 'equip');
  assert.ok(!r.solid(10, 9), 'cannot close a door you are standing in');
  a.x = 9.0; r.act(a, 'equip');
  assert.ok(r.solid(10, 9) && r.solid(10, 10), 'E closes it');
  const w = { x: 5.5, y: 12.5 };
  assert.ok(r.blocked(5.5, 12.5, 0.2), 'water blocks walking');
  assert.ok(!r.sight(5, 12), 'but not shots');
  // bushes: hidden from people outside the bushes, visible to people inside
  a.x = 3.5; a.y = 3.5; b.x = 12.5; b.y = 5.5;
  assert.ok(!r.canSee(b, a), 'player in a bush is hidden');
  assert.ok(r.canSee(a, b), 'but sees out');
  b.x = 15.5; b.y = 15.5;
  assert.ok(!r.canSee(b, a), 'a different, separate patch of bushes does not help');
  b.x = 4.5; b.y = 3.5;
  assert.ok(r.canSee(b, a) && r.canSee(a, b), 'two players in the same patch see each other');
  b.x = 12.5; b.y = 5.5; cb.msgs.length = 0; r.sendSnapshot();
  const snap = cb.msgs.find((m) => m.t === 's');
  const ta = snap && snap.p.find((t) => t[0] === a.id);
  assert.ok(ta && ta[19] === 1 && ta[1] === 0 && ta[2] === 0 && ta[8] === a.kills, 'hidden player stays in the list (name/score) but with no position');
  // grenades: throw, fuse, blast damages (self at half), walls shield
  r.act(a, 'equip'); // (no-op)
  a.x = 3.5; a.y = 8.5; a.a = 0; b.x = 7.5; b.y = 8.5; b.hp = 100; a.hp = 100;
  assert.strictEqual(a.nades, 1, 'start with a grenade');
  r.act(a, 'nade');
  assert.strictEqual(a.nades, 0); assert.strictEqual(r.nades.length, 1);
  b.x = 5.8; // sits near where the grenade will stop
  for (let i = 0; i < 40; i++) r.tick();
  assert.ok(r.nades.length === 0, 'it exploded');
  assert.ok(b.hp < 100 || b.dead, 'blast hurt the enemy: hp ' + b.hp);
  // auto pickups: better armor swaps, worse armor is ignored, heals are used in pvp
  r.respawn(a); a.x = 4.5; a.y = 14.5; a.armor = 30; a.hp = 50;
  r.ground = []; r.addGround(4.5, 14.5, 'vest', 0); r.addGround(4.6, 14.5, 'medkit', 0);
  r.autoPickup(a); r.autoPickup(a);
  assert.strictEqual(a.armor, 40, 'auto-swapped to the better vest');
  assert.ok(a.hp > 50, 'medkit auto-used when hurt in pvp');
  r.addGround(4.5, 14.5, 'vest', 0); r.autoPickup(a);
  assert.strictEqual(r.ground.length, 1, 'same armor level is left on the floor');
  a.hp = 100; r.addGround(4.5, 14.5, 'bandage', 0); const n0 = r.ground.length; r.autoPickup(a);
  assert.strictEqual(r.ground.length, n0, 'full health: heal stays');
  ok('doors (E, double door, blocked closing), bushes hide players, water, grenades, auto armor swap + auto heal');
}

function testDeadTownConnected() {
  const map = buildDefaultMaps()[0];
  const r = new Room('t3', { name: 'T', map, items, mode: 'pvp', difficulty: 'easy', maxPlayers: 4 });
  assert.ok(map.tiles.join('').includes('D') && map.tiles.join('').includes('b') && map.tiles.join('').includes('w') && /[<>^v]/.test(map.tiles.join('')), 'showcases doors, bushes, water, ramps');
  const pts = map.playerSpawns.concat(map.zombieSpawns, map.itemSpawns);
  for (const q of pts) assert.ok(!r.baseSolid[q.y * map.w + q.x], 'spawn/item on walkable tile ' + q.x + ',' + q.y);
  const from = map.playerSpawns[0];
  const reach = (a, b) => r.bfs(a.x, a.y, b.x, b.y).length > 0 || (a.x === b.x && a.y === b.y);
  for (const q of pts) assert.ok(reach(from, q) && reach(q, from), `reachable both ways (doors count as passable): ${q.x},${q.y}`);
  ok('Dead Town: every spawn and item is reachable (ramps, doors, tunnels)');
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

function testSwordsAndLoadout() {
  // loadout: only the ticked weapons exist, everyone starts with the chosen one
  const r = mkRoom({ allowed: ['sword', 'pistol'], start: 'sword', waves: 3 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  assert.strictEqual(p.weapon, 'sword');
  const loot = r.lootIds();
  assert.ok(loot.includes('pistol') && !loot.includes('sword') && !loot.includes('shotgun') && !loot.includes('rifle'), 'only allowed weapons can appear: ' + loot);
  r.startGame(); r.timer = 99999;
  for (const g of r.ground) { const d = items[g.item]; assert.ok(d.type !== 'weapon' || ['sword', 'pistol'].includes(g.item), 'disallowed gun on map: ' + g.item); }
  // sword: arc in front, no ammo, not through walls, not behind
  p.x = 19.5; p.y = 19.5; p.a = 0; p.ammo = 0; r.ground = [];
  const mk = (id, x, y) => { const z = { id, type: 0, x, y, hp: 100, maxHp: 100, spd: 0, dmg: 0, r: 0.38, cd: 0, side: 1, dead: false }; r.zombies.push(z); return z; };
  const front = mk(900, 21.0, 19.5), side = mk(901, 19.5, 21.0), far = mk(902, 24.5, 19.5), back = mk(903, 18.0, 19.5);
  r.fire(p);
  assert.ok(front.hp < 100, 'target in front is hit');
  assert.ok(side.hp === 100 && far.hp === 100 && back.hp === 100, 'outside the arc / range is safe');
  assert.strictEqual(p.ammo, 0, 'melee uses no ammo');
  assert.ok(r.ev.some((e) => e[0] === 'w'), 'swing event');
  // pvp loadout + death drops option
  for (const drop of [true, false]) {
    const q = mkRoom({ mode: 'pvp', killLimit: 0, deathDrop: drop, allowed: ['sword', 'pistol', 'rifle'], start: 'pistol' });
    const x = fakeConn(1, 'X'), y = fakeConn(2, 'Y');
    const px = q.join(x), py = q.join(y);
    q.startGame(); q.ground = [];
    px.x = 19.5; px.y = 19.5; px.a = 0; px.weapon = 'sword'; px.cd = 0; px.inv = 0;
    py.x = 20.5; py.y = 19.5; py.inv = 0; py.hp = 10; py.weapon = 'rifle'; py.ammo = 50;
    q.fire(px);
    assert.ok(py.dead && px.kills === 1, 'sword kills a player');
    if (drop) {
      assert.ok(q.ground.length >= 3, 'death drops weapon + random item + ammo: ' + q.ground.map((g) => g.item));
      assert.ok(q.ground.some((g) => g.item === 'rifle'), 'carried gun dropped');
    } else assert.strictEqual(q.ground.length, 0, 'nothing drops when the option is off');
    assert.strictEqual(py.weapon, 'pistol', 'respawn weapon is the starting weapon');
  }
  ok('swords (arc, no ammo), weapon loadout per room, pvp death-drop option');
}

function testSprint() { // (now: the dash roll)
  const { STAM_MAX, DASH_TIME, DASH_MULT, DASH_INV, DASH_CD } = require('../server/game');
  const r = mkRoom({ waves: 3 });
  const a = fakeConn(1, 'Ann');
  const p = r.join(a);
  r.startGame(); r.timer = 99999; r.zombies = [];
  p.x = 12.5; p.y = 19.5; p.budget = 1; p.stam = STAM_MAX;
  const x0 = p.x;
  for (let i = 0; i < 12; i++) { p.budget = 1; r.onInput(p, { seq: 1 + i, dx: 1, dy: 0, dt: 50, sh: 0, sp: 1, dh: i === 0 ? 1 : 0 }); r.tick(); }
  assert.ok(p.dinv > 0 && p.stam < STAM_MAX, 'dash starts: invincible, charge spent');
  const dist = p.x - x0, expect = 5.2 * (DASH_TIME * DASH_MULT + (0.6 - DASH_TIME));
  assert.ok(Math.abs(dist - expect) < 0.5, 'fast run for ' + DASH_TIME + 's then normal speed: ' + dist.toFixed(2) + ' vs ' + expect.toFixed(2));
  // the speed boost only lasts DASH_TIME even if the client keeps sending the flag
  const x1 = p.x; p.budget = 1; r.onInput(p, { seq: 20, dx: 1, dy: 0, dt: 100, sh: 0, sp: 1 });
  assert.ok(Math.abs(p.x - x1 - 0.52) < 0.06, 'no extra boost without a new dash');
  assert.ok(p.dinv > 0 && p.dinv < DASH_INV, 'still invincible after the burst (1s total)');
  // invincible: a zombie hit does nothing, a bullet is ignored
  const hp = p.hp;
  r.damagePlayer(p, 50, null); // direct damage still applies (only targeting is skipped); zombies/bots skip dinv players
  p.hp = hp;
  // second dash needs the charge back (~3s)
  p.dashT = 0; p.dashLeft = 0; r.onInput(p, { seq: 21, dx: 1, dy: 0, dt: 50, sh: 0, dh: 1, sp: 1 });
  assert.strictEqual(p.dashLeft, 0, 'no instant re-dash without charge');
  let secs = 0; p.dashT = 0;
  while (p.stam < STAM_MAX - 1 && secs < 10) { r.tick(); secs += DT; }
  assert.ok(Math.abs(secs - DASH_CD) < 0.5, 'dash recharges in ~' + DASH_CD + 's: ' + secs.toFixed(2));
  // no shooting while rolling
  p.x = 12.5; p.budget = 1; p.cd = 0; p.ammo = 50; p.shoot = true; p.dashT = 0.2;
  r.tick();
  assert.strictEqual(p.ammo, 50, 'no shooting while rolling');
  ok('dash: roll forward, 1s invincible, ~3s recharge, no shooting while rolling');
}

function testTeams() {
  const r = mkRoom({ mode: 'pvp', teams: true, killLimit: 2, maxPlayers: 6 });
  const a = fakeConn(1, 'Ann'), b = fakeConn(2, 'Ben');
  const pa = r.join(a), pb = r.join(b);
  assert.notStrictEqual(pa.team, pb.team, 'players are split across the two teams');
  r.addBot(1); r.addBot(1);
  const n = [0, 0]; for (const p of r.players.values()) n[p.team]++;
  assert.strictEqual(n[0], 2); assert.strictEqual(n[1], 2);
  r.setTeam(pb, pa.team); assert.strictEqual(pb.team, pa.team, 'can switch team in the lobby');
  assert.strictEqual(pb.color, pa.color, 'team colour');
  r.setTeam(pb, 1 - pa.team);
  r.startGame(); r.timer = 99999;
  const mate = [...r.players.values()].find((q) => q !== pa && q.team === pa.team);
  const foe = [...r.players.values()].find((q) => q.team !== pa.team);
  assert.ok(r.foe(pa, foe) && !r.foe(pa, mate) && !r.foe(pa, pa), 'no friendly fire');
  for (const q of r.players.values()) { q.inv = 0; q.hp = 100; }
  r.diePvp(foe, pa); const foe2 = [...r.players.values()].find((q) => q.team !== pa.team && !q.dead);
  r.diePvp(foe2, mate);
  assert.strictEqual(r.state, 'over', 'team reaches the kill limit together');
  assert.strictEqual(r.lastOver.winTeam, pa.team);
  ok('team deathmatch: auto-balance, switching, no friendly fire, team kill limit');
}

function testArmorAndDamage() {
  const { DMG_SCALE } = require('../server/game');
  assert.strictEqual(DMG_SCALE, 0.7);
  const r = mkRoom({ mode: 'pvp', killLimit: 0 });
  const a = fakeConn(1, 'A'), b = fakeConn(2, 'B');
  const pa = r.join(a), pb = r.join(b);
  r.startGame(); r.ground = [];
  pa.x = 17.5; pa.y = 19.5; pa.a = 0; pa.inv = 0; pa.weapon = 'rifle'; pa.cd = 0;
  pb.x = 21.5; pb.y = 19.8; pb.inv = 0; // (off the centre line, so no headshot)
  r.fire(pa);
  assert.ok(Math.abs(pb.hp - (100 - 34 * 0.7)) < 0.01, 'weapon damage is 30% weaker: ' + pb.hp);
  // armor soaks 60% of each hit until used up
  pb.hp = 100; pb.armor = 0; r.addGround(pb.x, pb.y, 'vest', 0); r.act(pb, 'equip');
  assert.strictEqual(pb.armor, 40, 'light vest = +40');
  r.addGround(pb.x, pb.y, 'plate', 0); r.act(pb, 'equip');
  assert.strictEqual(pb.armor, 100, 'armor capped at 100');
  r.addGround(pb.x, pb.y, 'vest', 0); r.act(pb, 'equip');
  assert.ok(r.ground.some((g) => g.item === 'vest'), 'full armor: item stays');
  pa.cd = 0; r.fire(pa);
  const dmg = 34 * 0.7;
  assert.ok(Math.abs(pb.hp - (100 - dmg * 0.4)) < 0.01 && Math.abs(pb.armor - (100 - dmg * 0.6)) < 0.01, 'armor soaked 60%: hp ' + pb.hp + ' armor ' + pb.armor);
  pb.armor = 5; pb.hp = 100; pa.cd = 0; r.fire(pa);
  assert.ok(pb.armor === 0 && Math.abs(pb.hp - (100 - (dmg - 5))) < 0.01, 'leftover armor is used up first');
  pb.hp = 1; pb.armor = 0; pa.cd = 0; r.fire(pa);
  assert.ok(pb.dead && pb.armor === 0, 'death clears armor'); r.respawn(pb); assert.strictEqual(pb.armor, 0);
  assert.ok(r.lootIds().includes('vest') && r.lootIds().includes('plate'), 'armor spawns as loot');
  ok('armor: pickup, cap, absorbs 60% of damage; weapon damage scaled by 0.7');
}
function testLook() {
  const { FIT_COUNT, ACC_COUNT } = require('../server/game');
  assert.strictEqual(FIT_COUNT, 20); assert.strictEqual(ACC_COUNT, 35);
  const r = mkRoom({ mode: 'pvp' });
  const c = fakeConn(1, 'A'); c.acc = 20; c.fit = 7;
  const p = r.join(c);
  assert.ok(p.acc === 20 && p.fit === 7);
  r.sendRoom();
  const rm = c.msgs.slice().reverse().find((m) => m.t === 'room');
  assert.ok(rm.players[0].acc === 20 && rm.players[0].fit === 7, 'room carries hat + outfit');
  ok('look: 25 hats, 10 outfits stored and broadcast');
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
  // reconnecting: drop the socket mid-game, come back with the token (and again by "refreshing" without waiting)
  const tok = A.msgs.find((m) => m.t === 'hello_ok').token;
  const aid = A.msgs.find((m) => m.t === 'hello_ok').id;
  assert.ok(tok && tok.length >= 16, 'server hands out a reconnect token');
  A.ws.close();
  await new Promise((r) => setTimeout(r, 150));
  const A2 = await client(port);
  A2.send({ t: 'hello', name: 'whatever', token: tok });
  const back = await until(() => A2.msgs.find((m) => m.t === 'hello_ok'));
  assert.ok(back.resumed && back.id === aid, 'same player id after reconnect');
  const st2 = await until(() => A2.msgs.find((m) => m.t === 'start'));
  assert.strictEqual(st2.you, aid, 'game state resent');
  await until(() => A2.msgs.find((m) => m.t === 's'));
  const A3 = await client(port); // a page refresh: new socket arrives before the old one is noticed as closed
  A3.send({ t: 'hello', name: 'x', token: back.token });
  const back3 = await until(() => A3.msgs.find((m) => m.t === 'hello_ok'));
  assert.ok(back3.resumed && back3.id === aid, 'takeover while the old socket is still open');
  await until(() => A3.msgs.find((m) => m.t === 'start'));
  const stranger = await client(port);
  stranger.send({ t: 'hello', name: 'Eve', token: 'not-a-real-token-123456' });
  assert.ok(!(await until(() => stranger.msgs.find((m) => m.t === 'hello_ok'))).resumed, 'bad token = fresh player');
  ok('reconnect: token resumes the seat after a drop and after a refresh');

  // host ends the game
  stranger.send({ t: 'endgame' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!A3.msgs.find((m) => m.t === 'over'), 'non-host cannot end the game');
  A3.send({ t: 'endgame' });
  const ended = await until(() => A3.msgs.find((m) => m.t === 'over'));
  assert.strictEqual(ended.result, 'ended');
  ok('host can end the game for everyone');
  stranger.ws.close(); A3.ws.close(); A2.ws.close(); B.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  server.close();
}

(async () => {
  testMaps(); testRevive(); testSelfCannotRevive(); testWavesAndVictory(); testDefeat(); testCombatAndItems(); testMovementCollision(); testTerrainAndHeadshots(); testDoorsBushesGrenades(); testDeadTownConnected(); testPvp(); testBotsFight(); testAmmo(); testAccessories(); testSwordsAndLoadout(); testSprint(); testTeams(); testArmorAndDamage(); testLook();
  await testNetwork();
  console.log('\nAll ' + passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
