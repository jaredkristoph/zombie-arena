'use strict';
// Authoritative game room: players, zombies, waves, items, graves, chat.

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const PLAYER_R = 0.38, PLAYER_SPEED = 5.2, PLAYER_HP = 100, BAG_MAX = 4;
const PICK_R = 1.6, GRAVE_R = 1.5, REVIVE_SECONDS = 30, BREAK_SECONDS = 8, MAX_ALIVE = 45;
const AMMO_START = 90, AMMO_MAX = 240, WAVE_AMMO = 25, AMMO_PICK_R = 0.95, ACC_COUNT = 14;
const RESPAWN_SECONDS = 10, SPAWN_PROTECT = 2, PVP_ITEM_EVERY = 25, MAX_BOTS = 7;
const BOT_NAMES = ['Rex', 'Nova', 'Blitz', 'Vex', 'Ghost', 'Rogue', 'Viper', 'Echo'];
// bot skill per difficulty: aim error (rad), turn speed (rad/s), reaction delay (s)
const BOT_SKILL = {
  easy: { err: 0.28, turn: 5, react: 0.7 },
  normal: { err: 0.16, turn: 8, react: 0.45 },
  hard: { err: 0.08, turn: 12, react: 0.25 },
  nightmare: { err: 0.03, turn: 18, react: 0.12 },
};
const normAng = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
const COLORS = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a', '#6a4c93', '#ff924c', '#4dd0e1', '#f06292'];

const DIFF = {
  easy: { hp: 0.7, spd: 0.85, dmg: 0.6, cnt: 0.7, drop: 1.4 },
  normal: { hp: 1, spd: 1, dmg: 1, cnt: 1, drop: 1 },
  hard: { hp: 1.4, spd: 1.12, dmg: 1.4, cnt: 1.35, drop: 0.8 },
  nightmare: { hp: 2, spd: 1.25, dmg: 2, cnt: 1.8, drop: 0.6 },
};
// index is sent to the client: 0 walker, 1 runner, 2 tank
const ZTYPES = [
  { hp: 40, spd: 1.7, dmg: 10, r: 0.38 },
  { hp: 24, spd: 3.3, dmg: 7, r: 0.33 },
  { hp: 240, spd: 1.15, dmg: 22, r: 0.62 },
];

const r2 = (v) => Math.round(v * 100) / 100;
const rand = Math.random;

class Room {
  constructor(id, cfg) {
    this.id = id;
    this.name = cfg.name;
    this.map = cfg.map;
    this.itemDefs = cfg.items; // id -> def
    this.waves = cfg.waves; // 0 = endless
    this.difficulty = DIFF[cfg.difficulty] ? cfg.difficulty : 'normal';
    this.d = DIFF[this.difficulty];
    this.maxPlayers = cfg.maxPlayers;
    this.mode = cfg.mode === 'pvp' ? 'pvp' : 'coop';
    this.killLimit = Math.max(0, Math.min(200, Math.round(Number(cfg.killLimit)) || 0)); // pvp only, 0 = endless
    this.botSeq = 0;
    this.reviveSeconds = cfg.reviveSeconds || REVIVE_SECONDS;
    this.W = this.map.w;
    this.H = this.map.h;
    this.solidArr = new Uint8Array(this.W * this.H);
    for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) this.solidArr[y * this.W + x] = this.map.tiles[y][x] === '.' ? 0 : 1;
    this.state = 'lobby';
    this.players = new Map();
    this.hostId = null;
    this.chatLog = [];
    this.nextId = 1;
    this.resetWorld();
  }

  // ---------- helpers ----------
  solid(tx, ty) {
    return tx < 0 || ty < 0 || tx >= this.W || ty >= this.H || this.solidArr[ty * this.W + tx] === 1;
  }
  blocked(x, y, r) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.solid(tx, ty)) continue;
        const cx = Math.max(tx, Math.min(x, tx + 1)), cy = Math.max(ty, Math.min(y, ty + 1));
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }
  // slides along walls; writes result into out
  move(e, dx, dy, r) {
    let nx = e.x + dx;
    if (this.blocked(nx, e.y, r)) nx = e.x;
    let ny = e.y + dy;
    if (this.blocked(nx, ny, r)) ny = e.y;
    e.x = nx; e.y = ny;
  }
  rayWall(ox, oy, dx, dy, max) {
    for (let d = 0.2; d <= max; d += 0.2) if (this.solid(Math.floor(ox + dx * d), Math.floor(oy + dy * d))) return d;
    return max;
  }
  weapon(id) {
    const w = this.itemDefs[id];
    return w && w.type === 'weapon' ? w : this.itemDefs.pistol;
  }
  alivePlayers() {
    const out = [];
    for (const p of this.players.values()) if (!p.dead) out.push(p);
    return out;
  }

  // ---------- messaging ----------
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) p.conn.raw(s);
  }
  say(text) {
    this.pushChat({ t: 'chat', sys: 1, text });
  }
  chat(p, text) {
    this.pushChat({ t: 'chat', id: p.id, name: p.name, color: p.color, text });
  }
  pushChat(msg) {
    this.chatLog.push(msg);
    if (this.chatLog.length > 30) this.chatLog.shift();
    this.broadcast(msg);
  }
  info() {
    return {
      id: this.id, name: this.name, map: this.map.name, waves: this.waves, difficulty: this.difficulty,
      max: this.maxPlayers, count: this.players.size, state: this.state, host: this.hostId,
      mode: this.mode, killLimit: this.killLimit, bots: this.botCount(),
    };
  }
  sendRoom() {
    this.broadcast({
      t: 'room', room: this.info(),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot ? 1 : 0, acc: p.acc })),
    });
  }
  initMsg(p) {
    return { t: 'start', you: p.id, map: this.map, items: this.itemDefs, room: this.info(), revive: this.reviveSeconds, pickR: PICK_R, graveR: GRAVE_R, respawn: RESPAWN_SECONDS };
  }
  humans() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }
  botCount() { return this.players.size - this.humans(); }

  // ---------- bots (pvp; the host adds them in the room lobby) ----------
  addBot(by) {
    if (this.mode !== 'pvp') return 'Bots are only available in PvP rooms';
    if (this.state !== 'lobby' || by !== this.hostId) return 'Only the host can add bots from the room lobby';
    if (this.players.size >= this.maxPlayers) return 'Room is full';
    if (this.botCount() >= MAX_BOTS) return 'Too many bots';
    const used = new Set([...this.players.values()].map((p) => p.name));
    let name = '';
    for (let i = 0; i < 40 && !name; i++) {
      const n = 'Bot ' + BOT_NAMES[Math.floor(rand() * BOT_NAMES.length)];
      if (!used.has(n)) name = n;
    }
    if (!name) name = 'Bot ' + (this.botSeq + 1);
    const conn = { id: 100000 + ++this.botSeq, name, raw() {}, send() {}, bot: true };
    const p = this.join(conn);
    p.bot = true;
    p.acc = Math.floor(rand() * ACC_COUNT);
    p.ai = { path: [], pathT: 0, tgt: null, seeT: 0, strafe: rand() < 0.5 ? 1 : -1, strafeT: 1, dest: null, aimErr: 0, errT: 0 };
    this.sendRoom();
    return null;
  }
  removeBot(by, id) {
    if (this.state !== 'lobby' || by !== this.hostId) return;
    const p = this.players.get(id);
    if (!p || !p.bot) return;
    this.players.delete(id);
    this.sendRoom();
  }

  // ---------- membership ----------
  join(conn) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    const p = {
      id: conn.id, name: conn.name, color, conn, x: 0, y: 0, a: 0, hp: PLAYER_HP, weapon: 'pistol', bag: [],
      dead: false, cd: 0, shoot: false, kills: 0, seq: 0, budget: 0.3, lastIn: Date.now(), gsent: -1, deaths: 0,
      rs: 0, inv: 0, aimSet: false, ammo: AMMO_START, acc: (conn.acc | 0) % ACC_COUNT,
    };
    this.players.set(p.id, p);
    if (this.hostId == null) this.hostId = p.id;
    conn.player = p;
    conn.room = this;
    if (this.state === 'playing') {
      this.placePlayer(p);
      if (this.mode === 'pvp') p.inv = SPAWN_PROTECT;
      p.gsent = -1;
      p.conn.send(this.initMsg(p));
      this.say(p.name + ' joined the fight!');
    }
    p.conn.send({ t: 'chatlog', msgs: this.chatLog });
    this.sendRoom();
    return p;
  }
  leave(conn) {
    const p = this.players.get(conn.id);
    if (!p) return;
    this.players.delete(p.id);
    this.graves = this.graves.filter((g) => g.pid !== p.id);
    conn.player = null;
    conn.room = null;
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((q) => !q.bot);
      this.hostId = next ? next.id : null;
    }
    if (!this.humans()) { this.players.clear(); return; } // only bots left: the room is closed by the server
    this.say(p.name + ' left.');
    this.sendRoom();
    if (this.mode === 'coop' && this.state === 'playing' && !this.alivePlayers().length) this.end('defeat');
  }

  // ---------- game flow ----------
  resetWorld() {
    this.zombies = [];
    this.ground = [];
    this.graves = [];
    this.ev = [];
    this.wave = 0;
    this.phase = 'break';
    this.timer = 6;
    this.queue = 0;
    this.spawnT = 0;
    this.gver = 0;
    this.tickN = 0;
    this.overT = 0;
  }
  placePlayer(p) {
    const sp = this.mode === 'pvp' ? this.respawnSpot(p) : this.map.playerSpawns[Math.floor(rand() * this.map.playerSpawns.length)];
    p.x = sp.x + 0.5 + (rand() - 0.5) * 0.4;
    p.y = sp.y + 0.5 + (rand() - 0.5) * 0.4;
    p.hp = PLAYER_HP; p.dead = false; p.weapon = 'pistol'; p.bag = []; p.cd = 0; p.shoot = false; p.rs = 0; p.inv = 0; p.ammo = AMMO_START;
  }
  // pvp respawn: the spawn point farthest from every living enemy
  respawnSpot(p) {
    const enemies = this.alivePlayers().filter((q) => q.id !== p.id);
    let best = null, bd = -1;
    for (const sp of this.map.playerSpawns.concat(this.map.zombieSpawns)) {
      const cx = sp.x + 0.5, cy = sp.y + 0.5;
      let d = enemies.length ? Infinity : 1;
      for (const q of enemies) d = Math.min(d, (q.x - cx) ** 2 + (q.y - cy) ** 2);
      d += rand() * 4; // break ties / add variety
      if (d > bd) { bd = d; best = sp; }
    }
    return best || this.map.playerSpawns[0];
  }
  respawn(p) {
    const sp = this.respawnSpot(p);
    p.x = sp.x + 0.5 + (rand() - 0.5) * 0.4;
    p.y = sp.y + 0.5 + (rand() - 0.5) * 0.4;
    p.hp = PLAYER_HP; p.dead = false; p.weapon = 'pistol'; p.bag = []; p.cd = 0.3; p.shoot = false; p.rs = 0; p.inv = SPAWN_PROTECT; p.ammo = AMMO_START;
    this.ev.push(['r', p.id]);
  }
  startGame() {
    if (this.state !== 'lobby') return;
    this.resetWorld();
    this.state = 'playing';
    this.pvpT = PVP_ITEM_EVERY;
    if (this.mode === 'pvp') for (const p of this.players.values()) p.dead = true; // so spawns are spread out
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.gsent = -1; p.inv = 0; if (p.ai) { p.ai.path = []; p.ai.tgt = null; } this.placePlayer(p); if (this.mode === 'pvp') p.inv = SPAWN_PROTECT; }
    this.spawnMapItems(true);
    for (const p of this.players.values()) p.conn.send(this.initMsg(p));
    if (this.mode === 'pvp') {
      this.say(`Deathmatch! ${this.killLimit ? 'First to ' + this.killLimit + ' kills wins' : 'Endless'} on ${this.map.name}. You respawn ${RESPAWN_SECONDS}s after dying. Press Enter to chat.`);
    } else {
      this.say(`Game on! ${this.waves ? this.waves + ' waves' : 'Endless'} on ${this.map.name} (${this.difficulty}). Wave 1 in ${this.timer}s. Press Enter to chat.`);
    }
    this.sendRoom();
  }
  end(result, winner) {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.overT = 14;
    const stats = [...this.players.values()].map((p) => ({ name: p.name, color: p.color, kills: p.kills, deaths: p.deaths })).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.broadcast({ t: 'over', result, wave: this.wave, stats, winner: winner ? winner.name : '', winnerId: winner ? winner.id : 0, killLimit: this.killLimit });
    this.sendRoom();
  }
  backToLobby() {
    this.state = 'lobby';
    this.resetWorld();
    for (const p of this.players.values()) { p.dead = false; p.shoot = false; p.rs = 0; p.inv = 0; }
    this.sendRoom();
  }

  lootIds() { return Object.keys(this.itemDefs).filter((k) => k !== 'pistol' && this.itemDefs[k].type !== 'ammo'); }
  spawnMapItems(force) {
    const ids = this.lootIds();
    for (const s of this.map.itemSpawns) {
      const cx = s.x + 0.5, cy = s.y + 0.5;
      if (this.ground.some((g) => !g.ttl && Math.abs(g.x - cx) < 0.6 && Math.abs(g.y - cy) < 0.6)) continue;
      if (!force && rand() < 0.35) continue;
      let item = s.item;
      if (item === 'random' || !this.itemDefs[item]) item = this.itemDefs.ammo && rand() < 0.35 ? 'ammo' : ids[Math.floor(rand() * ids.length)];
      if (item) this.addGround(cx, cy, item, 0);
    }
  }
  addGround(x, y, item, ttl) {
    this.ground.push({ id: this.nextId++, x, y, item, ttl });
    if (this.ground.length > 90) this.ground.shift();
    this.gver++;
  }

  // ---------- input ----------
  onInput(p, m) {
    if (this.state !== 'playing') return;
    const now = Date.now();
    p.budget = Math.min(0.3, p.budget + (now - p.lastIn) / 1000);
    p.lastIn = now;
    p.seq = m.seq | 0;
    p.shoot = !!m.sh;
    if (p.dead) return;
    // the client sends its (already smoothed) aim angle; without one we fall back to the walking direction
    const aim = typeof m.aa === 'number' && Number.isFinite(m.aa) ? normAng(m.aa) : null;
    if (aim !== null) p.a = aim;
    let dx = Number(m.dx) || 0, dy = Number(m.dy) || 0;
    const len = Math.hypot(dx, dy);
    const dt = Math.min(Math.max(Number(m.dt) || 0, 0), 100) / 1000;
    const use = Math.min(dt, p.budget);
    p.budget -= use;
    if (len > 0.01 && use > 0) {
      dx /= len; dy /= len;
      if (aim === null) p.a = Math.atan2(dy, dx);
      this.move(p, dx * PLAYER_SPEED * use, dy * PLAYER_SPEED * use, PLAYER_R);
    }
  }
  act(p, k) {
    if (this.state !== 'playing' || p.dead) return;
    if (k === 'equip') {
      let best = null, bd = PICK_R * PICK_R;
      for (const g of this.ground) {
        const d = (g.x - p.x) ** 2 + (g.y - p.y) ** 2;
        if (d < bd) { bd = d; best = g; }
      }
      if (!best) return;
      const def = this.itemDefs[best.item];
      if (!def) return;
      if (def.type === 'ammo') {
        if (p.ammo >= AMMO_MAX) { p.conn.send({ t: 'toast', text: 'Ammo full' }); return; }
        p.ammo = Math.min(AMMO_MAX, p.ammo + (def.amount || 40));
      } else if (def.type === 'heal') {
        if (p.bag.length >= BAG_MAX) { p.conn.send({ t: 'toast', text: 'Bag full (max ' + BAG_MAX + ')' }); return; }
        p.bag.push(def.id);
      } else {
        if (p.weapon !== 'pistol') this.addGround(best.x, best.y, p.weapon, 0);
        p.weapon = def.id;
        p.cd = 0.25;
      }
      this.ground.splice(this.ground.indexOf(best), 1);
      this.gver++;
      this.ev.push(['u', p.id]);
    } else if (k === 'drop') {
      if (p.weapon === 'pistol') return;
      this.addGround(p.x + Math.cos(p.a) * 0.9, p.y + Math.sin(p.a) * 0.9, p.weapon, 0);
      p.weapon = 'pistol';
    } else if (k === 'dropheal') {
      if (!p.bag.length) return;
      this.addGround(p.x + Math.cos(p.a) * 0.9, p.y + Math.sin(p.a) * 0.9, p.bag.pop(), 0);
    } else if (k === 'heal') {
      if (!p.bag.length || p.hp >= PLAYER_HP) return;
      const def = this.itemDefs[p.bag.pop()];
      p.hp = Math.min(PLAYER_HP, p.hp + (def ? def.heal : 25));
      this.ev.push(['m', p.id]);
    }
  }

  // ---------- combat ----------
  fire(p) {
    if (p.ammo <= 0) { p.cd = 0.3; this.ev.push(['e', p.id]); return; }
    p.ammo--;
    const w = this.weapon(p.weapon);
    p.cd = 1 / w.rate;
    p.inv = 0; // shooting ends spawn protection
    const pvp = this.mode === 'pvp';
    // targets: other players that are alive and not spawn-protected (pvp) or zombies (co-op)
    const targets = pvp ? this.alivePlayers().filter((q) => q.id !== p.id && !(q.inv > 0)) : this.zombies;
    const tr = pvp ? PLAYER_R + 0.1 : 0;
    for (let i = 0; i < w.pellets; i++) {
      const ang = p.a + (rand() - 0.5) * 2 * w.spread;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const wallD = this.rayWall(p.x, p.y, dx, dy, w.range);
      const hits = [];
      for (const z of targets) {
        if (z.dead && !pvp) continue;
        const r = pvp ? tr : z.r;
        const ox = z.x - p.x, oy = z.y - p.y;
        const t = ox * dx + oy * dy;
        if (t < 0 || t > wallD + r) continue;
        const perp2 = ox * ox + oy * oy - t * t;
        if (perp2 > r * r) continue;
        hits.push({ z, t: Math.max(0, t - Math.sqrt(r * r - perp2)) });
      }
      hits.sort((a, b) => a.t - b.t);
      let len = wallD, hit = 0;
      const n = Math.min(hits.length, 1 + w.pierce);
      for (let k = 0; k < n; k++) {
        if (hits[k].t > wallD) break;
        if (pvp) this.damagePlayer(hits[k].z, w.damage, p); else this.damageZombie(hits[k].z, w.damage, p);
        len = hits[k].t; hit = 1;
      }
      this.ev.push(['s', r2(p.x), r2(p.y), r2(ang), r2(len), hit, w.id]);
    }
  }
  damagePlayer(v, dmg, killer) {
    if (v.dead) return;
    v.hp -= dmg;
    this.ev.push(['h', v.id]);
    if (v.hp <= 0) this.die(v, killer);
  }
  damageZombie(z, dmg, p) {
    if (z.dead) return;
    z.hp -= dmg;
    if (z.hp > 0) return;
    z.dead = true;
    p.kills++;
    this.ev.push(['k', r2(z.x), r2(z.y), z.type]);
    if (rand() < 0.1 * this.d.drop + (z.type === 2 ? 0.5 : 0)) {
      const ids = this.lootIds();
      if (ids.length) this.addGround(z.x, z.y, ids[Math.floor(rand() * ids.length)], 45);
    }
    if (this.itemDefs.ammo && rand() < 0.16 + (z.type === 2 ? 0.5 : 0)) this.addGround(z.x + 0.3, z.y + 0.3, 'ammo', 45);
  }
  die(p, killer) {
    if (this.mode === 'pvp') return this.diePvp(p, killer);
    p.dead = true; p.hp = 0; p.shoot = false; p.deaths++;
    this.graves.push({ pid: p.id, name: p.name, x: p.x, y: p.y, prog: 0 });
    if (p.weapon !== 'pistol') { this.addGround(p.x, p.y, p.weapon, 0); p.weapon = 'pistol'; }
    p.bag = [];
    this.ev.push(['d', p.id]);
    this.say(`${p.name} was eaten! Stand on the grave for ${this.reviveSeconds}s to revive them.`);
    if (!this.alivePlayers().length) this.end('defeat');
  }
  // pvp: no graves, you come back on your own after RESPAWN_SECONDS
  diePvp(p, killer) {
    p.dead = true; p.hp = 0; p.shoot = false; p.deaths++; p.rs = RESPAWN_SECONDS; p.inv = 0;
    if (p.weapon !== 'pistol') { this.addGround(p.x, p.y, p.weapon, 30); p.weapon = 'pistol'; }
    p.bag = [];
    if (this.itemDefs.ammo && p.ammo >= 20) this.addGround(p.x + 0.4, p.y, 'ammo', 30);
    this.ev.push(['d', p.id]);
    const k = killer && killer.id !== p.id ? killer : null;
    if (k) k.kills++;
    this.say(k ? `${k.name} eliminated ${p.name}` : `${p.name} died`);
    if (k && this.killLimit && k.kills >= this.killLimit) {
      this.say(`${k.name} wins the deathmatch!`);
      this.end('pvp', k);
    }
  }

  // ---------- bot brain (pvp) ----------
  clearLine(x0, y0, x1, y1, r) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 0.25);
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      if (this.blocked(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, r)) return false;
    }
    return true;
  }
  bfs(sx, sy, tx, ty) {
    const W = this.W, H = this.H, N = W * H;
    sx = Math.max(0, Math.min(W - 1, sx)); sy = Math.max(0, Math.min(H - 1, sy));
    tx = Math.max(0, Math.min(W - 1, tx)); ty = Math.max(0, Math.min(H - 1, ty));
    const s = sy * W + sx, g = ty * W + tx;
    if (this.solidArr[g] || s === g) return [];
    const prev = new Int32Array(N).fill(-1), q = new Int32Array(N);
    let h = 0, t = 0;
    prev[s] = s; q[t++] = s;
    while (h < t) {
      const c = q[h++];
      if (c === g) break;
      const cx = c % W, cy = (c / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (prev[n] !== -1 || this.solidArr[n]) continue;
        prev[n] = c; q[t++] = n;
      }
    }
    if (prev[g] === -1) return [];
    const out = [];
    for (let c = g; c !== s; c = prev[c]) out.push([(c % W) + 0.5, ((c / W) | 0) + 0.5]);
    return out.reverse();
  }
  botThink(p) {
    const ai = p.ai, sk = BOT_SKILL[this.difficulty] || BOT_SKILL.normal;
    ai.pathT -= DT; ai.strafeT -= DT; ai.errT -= DT; ai.healT = (ai.healT || 0) - DT;
    if (ai.errT <= 0) { ai.errT = 0.35 + rand() * 0.3; ai.aimErr = (rand() - 0.5) * 2 * sk.err; }
    // nearest living enemy + line of sight
    let tgt = null, bd = Infinity;
    for (const q of this.players.values()) {
      if (q === p || q.dead) continue;
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) { bd = d; tgt = q; }
    }
    const dist = Math.sqrt(bd);
    let los = false;
    if (tgt) {
      const a0 = Math.atan2(tgt.y - p.y, tgt.x - p.x);
      los = this.rayWall(p.x, p.y, Math.cos(a0), Math.sin(a0), dist) >= dist - 0.05;
    }
    ai.seeT = los ? ai.seeT + DT : 0;
    const w = this.weapon(p.weapon);
    const dps = (d) => d.damage * d.pellets * d.rate * (1 + (d.pierce || 0) * 0.15);
    if (p.hp < 50 && p.bag.length && ai.healT <= 0) { ai.healT = 1; this.act(p, 'heal'); }

    // loot worth walking to when no fight is on
    let item = null, nearest = null, nd = PICK_R * PICK_R;
    if (!(los && dist < 12) || p.ammo < 10) {
      const cur = dps(w);
      let bs = 18 * 18;
      for (const g of this.ground) {
        const def = this.itemDefs[g.item];
        if (!def) continue;
        const want = def.type === 'ammo' ? p.ammo < 45 : def.type === 'heal' ? p.hp < 80 && p.bag.length < BAG_MAX : dps(def) > cur * 1.15;
        if (!want) continue;
        const d = (g.x - p.x) ** 2 + (g.y - p.y) ** 2;
        if (d < bs) { bs = d; item = g; }
      }
      for (const g of this.ground) {
        const d = (g.x - p.x) ** 2 + (g.y - p.y) ** 2;
        if (d < nd) { nd = d; nearest = g; }
      }
      if (item && nearest === item) { this.act(p, 'equip'); item = null; }
    }

    let mx = 0, my = 0, want = null, shoot = false;
    const combat = tgt && los && dist < 13 && !item;
    if (combat) {
      const ideal = w.range <= 9 ? 3.5 : w.range >= 25 ? 12 : 6.5;
      const ux = (tgt.x - p.x) / dist, uy = (tgt.y - p.y) / dist;
      const radial = dist > ideal + 1.5 ? 1 : dist < ideal - 1.5 ? -1 : 0;
      if (ai.strafeT <= 0) { ai.strafeT = 0.8 + rand() * 1.4; if (rand() < 0.6) ai.strafe *= -1; }
      mx = ux * radial - uy * ai.strafe * 0.9;
      my = uy * radial + ux * ai.strafe * 0.9;
      want = Math.atan2(tgt.y - p.y, tgt.x - p.x) + ai.aimErr;
      const diff = Math.abs(normAng(want - p.a));
      shoot = p.ammo > 0 && ai.seeT >= sk.react && dist < w.range * 0.95 && diff < 0.2 && !(tgt.inv > 0);
    } else {
      let goal = null;
      if (item) goal = [item.x, item.y];
      else if (tgt) goal = [tgt.x, tgt.y];
      else {
        if (!ai.dest || Math.hypot(ai.dest[0] - p.x, ai.dest[1] - p.y) < 1.2) {
          const pool = this.map.playerSpawns.concat(this.map.zombieSpawns);
          const s = pool[Math.floor(rand() * pool.length)];
          ai.dest = [s.x + 0.5, s.y + 0.5];
        }
        goal = ai.dest;
      }
      if (ai.pathT <= 0 || !ai.path.length) {
        ai.path = this.bfs(Math.floor(p.x), Math.floor(p.y), Math.floor(goal[0]), Math.floor(goal[1]));
        ai.pathT = 0.6;
      }
      while (ai.path.length > 1 && Math.hypot(ai.path[0][0] - p.x, ai.path[0][1] - p.y) < 0.5) ai.path.shift();
      let wp = null;
      for (let i = Math.min(4, ai.path.length - 1); i >= 0; i--) {
        if (this.clearLine(p.x, p.y, ai.path[i][0], ai.path[i][1], PLAYER_R * 0.95)) { wp = ai.path[i]; break; }
      }
      if (!wp && ai.path.length) wp = ai.path[0];
      if (!wp && Math.hypot(goal[0] - p.x, goal[1] - p.y) > 0.6) wp = goal;
      if (wp) { mx = wp[0] - p.x; my = wp[1] - p.y; }
      if (mx || my) want = Math.atan2(my, mx);
      // while walking toward an enemy we can almost see, keep the gun pointed at them
      if (tgt && los) { want = Math.atan2(tgt.y - p.y, tgt.x - p.x) + ai.aimErr; }
    }
    p.shoot = shoot;
    if (want !== null) {
      const step = sk.turn * DT;
      p.a = normAng(p.a + Math.max(-step, Math.min(step, normAng(want - p.a))));
    }
    const len = Math.hypot(mx, my);
    if (len > 0.01) {
      const sp = PLAYER_SPEED * 0.9 * DT;
      const sx = p.x, sy = p.y;
      this.move(p, (mx / len) * sp, (my / len) * sp, PLAYER_R);
      if (combat && Math.hypot(p.x - sx, p.y - sy) < sp * 0.3) ai.strafe *= -1; // bumped a wall
    }
  }

  // ---------- simulation ----------
  tick() {
    if (this.state === 'over') {
      this.overT -= DT;
      if (this.overT <= 0) this.backToLobby();
      return;
    }
    if (this.state !== 'playing') return;
    this.tickN++;
    const pvp = this.mode === 'pvp';
    for (const p of [...this.players.values()]) {
      if (p.dead) {
        if (pvp && (p.rs -= DT) <= 0) this.respawn(p);
        continue;
      }
      if (p.inv > 0) p.inv -= DT;
      if (p.ammo < AMMO_MAX) this.autoPickAmmo(p);
      if (p.bot) this.botThink(p);
      p.cd -= DT;
      if (p.shoot && p.cd <= 0 && this.state === 'playing') this.fire(p);
    }
    if (this.state !== 'playing') { this.ev = []; return; }
    if (pvp) {
      if ((this.pvpT -= DT) <= 0) { this.pvpT = PVP_ITEM_EVERY; this.spawnMapItems(false); }
    } else {
      this.updateWave();
      this.updateZombies();
      this.updateGraves();
    }
    for (let i = this.ground.length - 1; i >= 0; i--) {
      const g = this.ground[i];
      if (g.ttl && (g.ttl -= DT) <= 0) { this.ground.splice(i, 1); this.gver++; }
    }
    if (this.state === 'playing') this.sendSnapshot();
    this.ev = [];
  }

  autoPickAmmo(p) {
    for (let i = 0; i < this.ground.length; i++) {
      const g = this.ground[i];
      if ((g.x - p.x) ** 2 + (g.y - p.y) ** 2 > AMMO_PICK_R * AMMO_PICK_R) continue;
      const def = this.itemDefs[g.item];
      if (!def || def.type !== 'ammo') continue;
      p.ammo = Math.min(AMMO_MAX, p.ammo + (def.amount || 40));
      this.ground.splice(i, 1);
      this.gver++;
      this.ev.push(['u', p.id]);
      return;
    }
  }

  updateWave() {
    if (this.phase === 'break') {
      this.timer -= DT;
      if (this.timer <= 0) this.startWave();
      return;
    }
    this.spawnT -= DT;
    if (this.queue > 0 && this.spawnT <= 0 && this.zombies.length < MAX_ALIVE) {
      this.spawnZombie();
      this.queue--;
      this.spawnT = Math.max(0.15, 0.9 / this.d.cnt - this.wave * 0.02);
    }
    if (this.queue === 0 && this.zombies.length === 0) {
      if (this.waves > 0 && this.wave >= this.waves) {
        this.say('All waves cleared. You survived!');
        this.end('victory');
        return;
      }
      this.phase = 'break';
      this.timer = BREAK_SECONDS;
      for (const p of this.alivePlayers()) { p.hp = Math.min(PLAYER_HP, p.hp + 30); p.ammo = Math.min(AMMO_MAX, p.ammo + WAVE_AMMO); }
      this.spawnMapItems(false);
      this.say(`Wave ${this.wave} cleared! Next wave in ${BREAK_SECONDS}s. Revive your friends!`);
    }
  }
  startWave() {
    this.wave++;
    const alive = Math.max(1, this.alivePlayers().length);
    this.queue = Math.min(150, Math.round((6 + this.wave * 3) * this.d.cnt * (1 + 0.4 * (alive - 1))));
    this.spawnT = 0;
    this.phase = 'wave';
    this.bossDone = false;
    this.say(`Wave ${this.wave}${this.waves ? '/' + this.waves : ''} - ${this.queue} zombies incoming!`);
  }
  spawnZombie() {
    const alive = this.alivePlayers();
    let spots = this.map.zombieSpawns.filter((s) => alive.every((p) => (p.x - s.x) ** 2 + (p.y - s.y) ** 2 > 64));
    if (!spots.length) spots = this.map.zombieSpawns;
    const s = spots[Math.floor(rand() * spots.length)];
    let type = 0;
    const roll = rand();
    const tankC = this.wave >= 3 ? Math.min(0.16, (this.wave - 2) * 0.03) : 0;
    const runC = this.wave >= 2 ? Math.min(0.4, (this.wave - 1) * 0.07) : 0;
    if (this.wave % 5 === 0 && !this.bossDone) { type = 2; this.bossDone = true; }
    else if (roll < tankC) type = 2;
    else if (roll < tankC + runC) type = 1;
    const t = ZTYPES[type];
    const hp = t.hp * this.d.hp * (1 + this.wave * 0.06);
    this.zombies.push({
      id: this.nextId++, type, x: s.x + 0.5 + (rand() - 0.5) * 0.6, y: s.y + 0.5 + (rand() - 0.5) * 0.6,
      hp, maxHp: hp, spd: t.spd * this.d.spd * (0.9 + rand() * 0.2), dmg: t.dmg, r: t.r, cd: 0, side: rand() < 0.5 ? 1 : -1, dead: false,
    });
  }
  updateZombies() {
    const alive = this.alivePlayers();
    const zs = this.zombies;
    for (const z of zs) {
      if (z.dead) continue;
      z.cd -= DT;
      let tgt = null, bd = Infinity;
      for (const p of alive) {
        const d = (p.x - z.x) ** 2 + (p.y - z.y) ** 2;
        if (d < bd) { bd = d; tgt = p; }
      }
      if (!tgt) continue;
      const dist = Math.sqrt(bd);
      if (dist > z.r + PLAYER_R + 0.05) {
        const ang0 = Math.atan2(tgt.y - z.y, tgt.x - z.x);
        const step = z.spd * DT;
        const offs = [0, z.side * 0.9, -z.side * 0.9, z.side * 1.7, -z.side * 1.7];
        let done = false;
        for (let i = 0; i < offs.length && !done; i++) {
          const a = ang0 + offs[i];
          const sx = z.x, sy = z.y;
          this.move(z, Math.cos(a) * step, Math.sin(a) * step, z.r);
          if (Math.hypot(z.x - sx, z.y - sy) > step * 0.55 || i === offs.length - 1) {
            if (i > 0 && i < offs.length - 1) z.side = offs[i] > 0 ? 1 : -1;
            done = true;
          } else { z.x = sx; z.y = sy; }
        }
      }
      if (dist <= z.r + PLAYER_R + 0.2 && z.cd <= 0 && !tgt.dead) {
        z.cd = 0.8;
        tgt.hp -= z.dmg * this.d.dmg;
        this.ev.push(['h', tgt.id]);
        if (tgt.hp <= 0) this.die(tgt);
      }
    }
    // soft separation
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i];
      if (a.dead) continue;
      for (let j = i + 1; j < zs.length; j++) {
        const b = zs[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y, min = (a.r + b.r) * 0.9;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = ((min - d) / d) * 0.25;
          const ax = a.x - dx * push, ay = a.y - dy * push, bx = b.x + dx * push, by = b.y + dy * push;
          if (!this.blocked(ax, ay, a.r)) { a.x = ax; a.y = ay; }
          if (!this.blocked(bx, by, b.r)) { b.x = bx; b.y = by; }
        }
      }
    }
    this.zombies = zs.filter((z) => !z.dead);
  }
  updateGraves() {
    for (let i = this.graves.length - 1; i >= 0; i--) {
      const g = this.graves[i];
      let rescuer = null;
      for (const p of this.players.values()) {
        if (p.dead || p.id === g.pid) continue;
        if ((p.x - g.x) ** 2 + (p.y - g.y) ** 2 <= GRAVE_R * GRAVE_R) { rescuer = p; break; }
      }
      if (rescuer) g.prog += DT; else g.prog = Math.max(0, g.prog - DT * 0.5);
      if (g.prog >= this.reviveSeconds) {
        const p = this.players.get(g.pid);
        this.graves.splice(i, 1);
        if (!p) continue;
        p.dead = false; p.hp = PLAYER_HP / 2; p.x = g.x; p.y = g.y; p.weapon = 'pistol'; p.bag = []; p.cd = 0.5; p.ammo = AMMO_START;
        this.ev.push(['r', p.id]);
        this.say(`${rescuer.name} revived ${p.name}!`);
      }
    }
  }

  sendSnapshot() {
    const base = {
      w: { n: this.wave, of: this.waves, ph: this.phase === 'wave' ? 1 : 0, tm: Math.ceil(Math.max(0, this.timer)), left: this.queue + this.zombies.length },
      p: [...this.players.values()].map((p) => [p.id, r2(p.x), r2(p.y), r2(p.a), Math.max(0, Math.round(p.hp)), p.weapon, p.dead ? 1 : 0, p.bag.length, p.kills, Math.ceil(Math.max(0, p.rs)), p.inv > 0 ? 1 : 0, p.deaths, p.ammo]),
      z: this.zombies.map((z) => [z.id, r2(z.x), r2(z.y), z.type, Math.max(1, Math.round((z.hp / z.maxHp) * 100))]),
      gr: this.graves.map((g) => [g.pid, r2(g.x), r2(g.y), Math.round(g.prog * 10) / 10, g.name]),
      ev: this.ev,
    };
    const baseStr = JSON.stringify(base).slice(1);
    const gStr = JSON.stringify(this.ground.map((g) => [g.id, r2(g.x), r2(g.y), g.item]));
    for (const p of this.players.values()) {
      if (p.bot) continue;
      let head = '{"a":' + p.seq;
      if (p.gsent !== this.gver) { head += ',"g":' + gStr; p.gsent = this.gver; }
      p.conn.raw(head + ',"t":"s",' + baseStr);
    }
  }
}

module.exports = { ACC_COUNT, AMMO_START, AMMO_MAX, Room, TICK_HZ, DT, DIFF, REVIVE_SECONDS, RESPAWN_SECONDS };
