'use strict';
// Authoritative game room: players, zombies, waves, items, graves, chat.

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const PLAYER_R = 0.38, PLAYER_SPEED = 5.2, PLAYER_HP = 100, BAG_MAX = 4;
const PICK_R = 1.6, GRAVE_R = 1.5, REVIVE_SECONDS = 30, BREAK_SECONDS = 8, MAX_ALIVE = 45;
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
    };
  }
  sendRoom() {
    this.broadcast({
      t: 'room', room: this.info(),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })),
    });
  }
  initMsg(p) {
    return { t: 'start', you: p.id, map: this.map, items: this.itemDefs, room: this.info(), revive: this.reviveSeconds, pickR: PICK_R, graveR: GRAVE_R };
  }

  // ---------- membership ----------
  join(conn) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    const p = {
      id: conn.id, name: conn.name, color, conn, x: 0, y: 0, a: 0, hp: PLAYER_HP, weapon: 'pistol', bag: [],
      dead: false, cd: 0, shoot: false, kills: 0, seq: 0, budget: 0.3, lastIn: Date.now(), gsent: -1, deaths: 0,
    };
    this.players.set(p.id, p);
    if (this.hostId == null) this.hostId = p.id;
    conn.player = p;
    conn.room = this;
    if (this.state === 'playing') {
      this.placePlayer(p);
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
    if (this.hostId === p.id) this.hostId = this.players.size ? this.players.keys().next().value : null;
    if (this.players.size) {
      this.say(p.name + ' left.');
      this.sendRoom();
      if (this.state === 'playing' && !this.alivePlayers().length) this.end('defeat');
    }
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
    const sp = this.map.playerSpawns[Math.floor(rand() * this.map.playerSpawns.length)];
    p.x = sp.x + 0.5 + (rand() - 0.5) * 0.4;
    p.y = sp.y + 0.5 + (rand() - 0.5) * 0.4;
    p.hp = PLAYER_HP; p.dead = false; p.weapon = 'pistol'; p.bag = []; p.cd = 0; p.shoot = false;
  }
  startGame() {
    if (this.state !== 'lobby') return;
    this.resetWorld();
    this.state = 'playing';
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.gsent = -1; this.placePlayer(p); }
    this.spawnMapItems(true);
    for (const p of this.players.values()) p.conn.send(this.initMsg(p));
    this.say(`Game on! ${this.waves ? this.waves + ' waves' : 'Endless'} on ${this.map.name} (${this.difficulty}). Wave 1 in ${this.timer}s. Press Enter to chat.`);
    this.sendRoom();
  }
  end(result) {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.overT = 14;
    const stats = [...this.players.values()].map((p) => ({ name: p.name, color: p.color, kills: p.kills, deaths: p.deaths })).sort((a, b) => b.kills - a.kills);
    this.broadcast({ t: 'over', result, wave: this.wave, stats });
    this.sendRoom();
  }
  backToLobby() {
    this.state = 'lobby';
    this.resetWorld();
    for (const p of this.players.values()) { p.dead = false; p.shoot = false; }
    this.sendRoom();
  }

  spawnMapItems(force) {
    const ids = Object.keys(this.itemDefs).filter((k) => k !== 'pistol');
    for (const s of this.map.itemSpawns) {
      const cx = s.x + 0.5, cy = s.y + 0.5;
      if (this.ground.some((g) => !g.ttl && Math.abs(g.x - cx) < 0.6 && Math.abs(g.y - cy) < 0.6)) continue;
      if (!force && rand() < 0.35) continue;
      let item = s.item;
      if (item === 'random' || !this.itemDefs[item]) item = ids[Math.floor(rand() * ids.length)];
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
    let dx = Number(m.dx) || 0, dy = Number(m.dy) || 0;
    const len = Math.hypot(dx, dy);
    const dt = Math.min(Math.max(Number(m.dt) || 0, 0), 100) / 1000;
    const use = Math.min(dt, p.budget);
    p.budget -= use;
    if (len > 0.01 && use > 0) {
      dx /= len; dy /= len;
      p.a = Math.atan2(dy, dx);
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
      if (def.type === 'heal') {
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
    const w = this.weapon(p.weapon);
    p.cd = 1 / w.rate;
    for (let i = 0; i < w.pellets; i++) {
      const ang = p.a + (rand() - 0.5) * 2 * w.spread;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const wallD = this.rayWall(p.x, p.y, dx, dy, w.range);
      const hits = [];
      for (const z of this.zombies) {
        if (z.dead) continue;
        const ox = z.x - p.x, oy = z.y - p.y;
        const t = ox * dx + oy * dy;
        if (t < 0 || t > wallD + z.r) continue;
        const perp2 = ox * ox + oy * oy - t * t;
        if (perp2 > z.r * z.r) continue;
        hits.push({ z, t: Math.max(0, t - Math.sqrt(z.r * z.r - perp2)) });
      }
      hits.sort((a, b) => a.t - b.t);
      let len = wallD, hit = 0;
      const n = Math.min(hits.length, 1 + w.pierce);
      for (let k = 0; k < n; k++) {
        if (hits[k].t > wallD) break;
        this.damageZombie(hits[k].z, w.damage, p);
        len = hits[k].t; hit = 1;
      }
      this.ev.push(['s', r2(p.x), r2(p.y), r2(ang), r2(len), hit, w.id]);
    }
  }
  damageZombie(z, dmg, p) {
    if (z.dead) return;
    z.hp -= dmg;
    if (z.hp > 0) return;
    z.dead = true;
    p.kills++;
    this.ev.push(['k', r2(z.x), r2(z.y), z.type]);
    if (rand() < 0.1 * this.d.drop + (z.type === 2 ? 0.5 : 0)) {
      const ids = Object.keys(this.itemDefs).filter((k) => k !== 'pistol');
      if (ids.length) this.addGround(z.x, z.y, ids[Math.floor(rand() * ids.length)], 45);
    }
  }
  die(p) {
    p.dead = true; p.hp = 0; p.shoot = false; p.deaths++;
    this.graves.push({ pid: p.id, name: p.name, x: p.x, y: p.y, prog: 0 });
    if (p.weapon !== 'pistol') { this.addGround(p.x, p.y, p.weapon, 0); p.weapon = 'pistol'; }
    p.bag = [];
    this.ev.push(['d', p.id]);
    this.say(`${p.name} was eaten! Stand on the grave for ${this.reviveSeconds}s to revive them.`);
    if (!this.alivePlayers().length) this.end('defeat');
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
    for (const p of this.players.values()) {
      if (p.dead) continue;
      p.cd -= DT;
      if (p.shoot && p.cd <= 0) this.fire(p);
    }
    this.updateWave();
    this.updateZombies();
    this.updateGraves();
    for (let i = this.ground.length - 1; i >= 0; i--) {
      const g = this.ground[i];
      if (g.ttl && (g.ttl -= DT) <= 0) { this.ground.splice(i, 1); this.gver++; }
    }
    if (this.state === 'playing') this.sendSnapshot();
    this.ev = [];
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
      for (const p of this.alivePlayers()) p.hp = Math.min(PLAYER_HP, p.hp + 30);
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
        p.dead = false; p.hp = PLAYER_HP / 2; p.x = g.x; p.y = g.y; p.weapon = 'pistol'; p.bag = []; p.cd = 0.5;
        this.ev.push(['r', p.id]);
        this.say(`${rescuer.name} revived ${p.name}!`);
      }
    }
  }

  sendSnapshot() {
    const base = {
      w: { n: this.wave, of: this.waves, ph: this.phase === 'wave' ? 1 : 0, tm: Math.ceil(Math.max(0, this.timer)), left: this.queue + this.zombies.length },
      p: [...this.players.values()].map((p) => [p.id, r2(p.x), r2(p.y), r2(p.a), Math.max(0, Math.round(p.hp)), p.weapon, p.dead ? 1 : 0, p.bag.length, p.kills]),
      z: this.zombies.map((z) => [z.id, r2(z.x), r2(z.y), z.type, Math.max(1, Math.round((z.hp / z.maxHp) * 100))]),
      gr: this.graves.map((g) => [g.pid, r2(g.x), r2(g.y), Math.round(g.prog * 10) / 10, g.name]),
      ev: this.ev,
    };
    const baseStr = JSON.stringify(base).slice(1);
    const gStr = JSON.stringify(this.ground.map((g) => [g.id, r2(g.x), r2(g.y), g.item]));
    for (const p of this.players.values()) {
      let head = '{"a":' + p.seq;
      if (p.gsent !== this.gver) { head += ',"g":' + gStr; p.gsent = this.gver; }
      p.conn.raw(head + ',"t":"s",' + baseStr);
    }
  }
}

module.exports = { Room, TICK_HZ, DT, DIFF, REVIVE_SECONDS };
