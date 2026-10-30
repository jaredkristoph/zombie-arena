'use strict';
// Authoritative game room: players, zombies, waves, items, graves, chat.
const { buildTerrain, canStep } = require('./terrain');

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const PLAYER_R = 0.38, PLAYER_SPEED = 5.2, PLAYER_HP = 100, BAG_MAX = 4;
const PICK_R = 1.6, GRAVE_R = 1.5, REVIVE_SECONDS = 15, BREAK_SECONDS = 8, MAX_ALIVE = 80, PREP_SECONDS = 30;
// zombie-defense gear (co-op): turrets shoot zombies on their own, barricades block walking but not bullets, mines blow up zombies
const TURRET_AMMO = 160, TURRET_MAX = 6, WALL_R = 0.35, CARRY = { turret: 3, barricade: 12, mine: 8 }, MINE_ARM = 1.2;
const AMMO_START = 90, AMMO_MAX = 240, WAVE_AMMO = 25, AMMO_PICK_R = 0.95, ACC_COUNT = 35, FIT_COUNT = 20;
// headshots: only the shot that KILLS can be one, and only HS_CHANCE of the time
const HS_CHANCE = 0.05;
// grenades (F): thrown along your aim, bounce off walls, explode after a fuse
// heavier weapons slow you down: 2% per kg (min 60%); an explicit `move` (katana = 2) overrides it
const weaponSpeed = (d) => d.move || Math.max(0.6, 1 - (d.weight || 0) * 0.02);
const NADE_MAX = 4, NADE_START = 1, NADE_FUSE = 1.7, NADE_SPEED = 11;
const TEAM_COLORS = ['#ff595e', '#3a86ff'], TEAM_NAMES = ['Red', 'Blue'];
// all weapon damage is scaled down so fights last longer; armor soaks part of every hit until it is used up
const DMG_SCALE = 0.7, ARMOR_MAX = 100, ARMOR_ABSORB = 0.6;
// dash (Shift): a quick forward roll, invincible for 1 second, then a cooldown. `stam` doubles as the dash charge (0..100).
const STAM_MAX = 100, DASH_TIME = 0.55, DASH_MULT = 2.4, KILL_BOOST = 1.2, KILL_BOOST_TIME = 10, DASH_INV = 1, DASH_CD = 3;
const RESPAWN_SECONDS = 10, SPAWN_PROTECT = 2, PVP_ITEM_EVERY = 25, MAX_BOTS = 7;
const BOT_NAMES = ['Rex', 'Nova', 'Blitz', 'Vex', 'Ghost', 'Rogue', 'Viper', 'Echo'];
// bot skill per difficulty: aim error (rad), turn speed (rad/s), reaction delay (s)
// (bots were too strong even on easy: more aim error, slower to notice and turn, and slower on their feet)
const BOT_SKILL = {
  easy: { err: 0.5, turn: 3.2, react: 1.2, spd: 0.62 },
  normal: { err: 0.3, turn: 5.5, react: 0.8, spd: 0.75 },
  hard: { err: 0.15, turn: 8.5, react: 0.45, spd: 0.85 },
  nightmare: { err: 0.06, turn: 14, react: 0.22, spd: 0.95 },
};
const normAng = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
const COLORS = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a', '#6a4c93', '#ff924c', '#4dd0e1', '#f06292', '#b5e48c', '#e76f51', '#9d4edd', '#2a9d8f', '#f4a261', '#90e0ef', '#c77dff', '#d00000', '#70e000', '#ffd60a', '#00b4d8', '#ff70a6'];

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
  { hp: 1100, spd: 1.3, dmg: 34, r: 0.85 }, // boss (waves 5, 10, ...)
];

const r2 = (v) => Math.round(v * 100) / 100;
const rand = Math.random;

class Room {
  constructor(id, cfg) {
    this.id = id;
    this.name = cfg.name;
    this.map = cfg.map;
    this.itemDefs = cfg.items; // id -> def
    // which weapons exist in this room, and what everybody starts with
    const weaponIds = Object.keys(this.itemDefs).filter((k) => this.itemDefs[k].type === 'weapon');
    let allowed = Array.isArray(cfg.allowed) ? cfg.allowed.filter((id) => weaponIds.includes(id)) : weaponIds;
    if (!allowed.length) allowed = weaponIds.includes('pistol') ? ['pistol'] : weaponIds.slice(0, 1);
    this.allowed = new Set(allowed);
    this.startWeapon = this.allowed.has(cfg.start) ? cfg.start : (this.allowed.has('pistol') ? 'pistol' : allowed[0]);
    this.deathDrop = cfg.deathDrop !== false; // pvp: a random item falls where a player dies
    this.waves = cfg.waves; // 0 = endless
    this.difficulty = DIFF[cfg.difficulty] ? cfg.difficulty : 'normal';
    this.d = DIFF[this.difficulty];
    this.maxPlayers = cfg.maxPlayers;
    this.mode = cfg.mode === 'pvp' ? 'pvp' : 'coop';
    this.killLimit = Math.max(0, Math.min(200, Math.round(Number(cfg.killLimit)) || 0)); // pvp only, 0 = endless
    this.teams = this.mode === 'pvp' && cfg.teams === true; // team deathmatch: Red vs Blue, no friendly fire
    this.botSeq = 0;
    this.reviveSeconds = cfg.reviveSeconds || REVIVE_SECONDS;
    this.W = this.map.w;
    this.H = this.map.h;
    const ter = buildTerrain(this.map.tiles, this.W, this.H);
    this.hAt = ter.heightAt;
    this.baseSolid = ter.solid; this.baseSight = ter.sight; this.bushArr = ter.bush; this.doorIdx = ter.doors;
    this.solidArr = new Uint8Array(ter.solid); this.sightArr = new Uint8Array(ter.sight); this.doorOpen = new Set();
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
  sight(tx, ty) {
    return tx < 0 || ty < 0 || tx >= this.W || ty >= this.H || this.sightArr[ty * this.W + tx] === 1;
  }
  inBush(e) { return this.bushArr[Math.floor(e.y) * this.W + Math.floor(e.x)]; } // 0 = not in a bush, else the id of that patch of bushes
  // can viewer v see q? players inside a bush are hidden from everyone outside the bushes (pvp)
  canSee(v, q) {
    if (v === q || this.mode !== 'pvp' || q.dead || v.dead) return true;
    const bq = this.inBush(q);
    if (!bq || this.inBush(v) === bq) return true; // only people in the SAME patch of bushes see each other
    return this.teams && v.team === q.team;
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
    if (this.blocked(nx, e.y, r) || !canStep(this.hAt, e.x, e.y, nx, e.y)) nx = e.x;
    let ny = e.y + dy;
    if (this.blocked(nx, ny, r) || !canStep(this.hAt, nx, e.y, nx, ny)) ny = e.y;
    e.x = nx; e.y = ny;
  }
  rayWall(ox, oy, dx, dy, max) {
    for (let d = 0.2; d <= max; d += 0.2) if (this.sight(Math.floor(ox + dx * d), Math.floor(oy + dy * d))) return d;
    return max;
  }
  weapon(id) {
    const w = this.itemDefs[id];
    return w && w.type === 'weapon' ? w : (this.itemDefs[this.startWeapon] || this.itemDefs.pistol);
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
      mode: this.mode, teams: this.teams, killLimit: this.killLimit, bots: this.botCount(), drops: this.deathDrop, start: this.startWeapon, weapons: [...this.allowed],
    };
  }
  sendRoom() {
    this.broadcast({
      t: 'room', room: this.info(),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot ? 1 : 0, acc: p.acc, fit: p.fit, team: this.teams ? p.team : -1 })),
    });
  }
  initMsg(p) {
    return { t: 'start', doors: [...this.doorOpen], walls: [...this.walls.keys()], you: p.id, map: this.map, items: this.itemDefs, room: this.info(), revive: this.reviveSeconds, pickR: PICK_R, graveR: GRAVE_R, respawn: RESPAWN_SECONDS };
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
    p.fit = Math.floor(rand() * FIT_COUNT);
    p.ai = { path: [], pathT: 0, tgt: null, seeT: 0, strafe: rand() < 0.5 ? 1 : -1, strafeT: 1, dest: null, aimErr: 0, errT: 0 };
    this.sendRoom();
    return null;
  }
  foe(p, q) { return q.id !== p.id && (!this.teams || q.team !== p.team); }
  setTeam(p, team) {
    if (!this.teams || this.state !== 'lobby') return;
    team = team === 1 ? 1 : 0;
    if (p.team === team) return;
    p.team = team; p.color = TEAM_COLORS[team];
    this.sendRoom();
  }
  teamScore(t) { let n = 0; for (const q of this.players.values()) if (q.team === t) n += q.kills; return n; }
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
    let color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length];
    let team = 0;
    if (this.teams) { // join the smaller team
      const n = [0, 0];
      for (const q of this.players.values()) n[q.team]++;
      team = n[1] < n[0] ? 1 : 0;
      color = TEAM_COLORS[team];
    }
    const p = {
      team,
      id: conn.id, name: conn.name, color, conn, x: 0, y: 0, a: 0, hp: PLAYER_HP, weapon: this.startWeapon, bag: [],
      dead: false, cd: 0, shoot: false, kills: 0, seq: 0, budget: 0.3, lastIn: Date.now(), gsent: -1, deaths: 0,
      rs: 0, inv: 0, aimSet: false, ammo: AMMO_START, stam: STAM_MAX, exh: false, sprinting: false, sDelay: 0, dashT: 0, dashLeft: 0, boostT: 0, dinv: 0, acc: (conn.acc | 0) % ACC_COUNT, fit: (conn.fit | 0) % FIT_COUNT, armor: 0,
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

  // a player whose connection came back (see server.js): resend whatever they need to pick up where they left off
  resume(p) {
    p.gsent = -1; p.lastIn = Date.now(); p.budget = 0.3;
    if (this.state === 'playing') p.conn.send(this.initMsg(p));
    else if (this.state === 'over' && this.lastOver) p.conn.send(this.lastOver);
    p.conn.send({ t: 'chatlog', msgs: this.chatLog });
    this.say(p.name + ' reconnected.');
    this.sendRoom();
  }
  // host pressed "End game"
  endByHost() {
    if (this.state !== 'playing') return;
    const h = this.players.get(this.hostId);
    this.say((h ? h.name : 'The host') + ' ended the game.');
    this.end('ended');
  }

  // ---------- game flow ----------
  resetWorld() {
    this.zombies = [];
    this.ground = [];
    this.graves = [];
    this.ev = [];
    this.wave = 0;
    this.phase = 'break';
    this.timer = this.mode === 'coop' ? PREP_SECONDS : 6; // co-op: 30 seconds to prepare before wave 1
    this.queue = 0;
    this.spawnT = 0;
    this.gver = 0;
    this.nades = [];
    this.turrets = []; this.mines = []; this.walls = new Map();
    this.resetDoors();
    this.tickN = 0;
    this.overT = 0;
  }
  resetDoors() {
    this.solidArr.set(this.baseSolid); this.sightArr.set(this.baseSight);
    for (const i of this.doorIdx) { this.solidArr[i] = 1; this.sightArr[i] = 1; }
    this.doorOpen.clear();
  }
  // E: open / close the nearest door (and the doors touching it, so a double door moves together)
  toggleDoor(p, quiet) {
    let best = -1, bd = 1.9 * 1.9;
    for (const i of this.doorIdx) {
      const d = (((i % this.W) + 0.5) - p.x) ** 2 + (((i / this.W | 0) + 0.5) - p.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    return this.setDoorGroup(p, best, !this.doorOpen.has(best), quiet);
  }
  setDoorGroup(p, start, open, quiet) {
    const grp = [start], seen = new Set([start]);
    for (let k = 0; k < grp.length && grp.length < 12; k++) {
      const x = grp[k] % this.W, y = (grp[k] / this.W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * this.W + nx;
        if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H || seen.has(n) || !this.doorIdx.includes(n)) continue;
        seen.add(n); grp.push(n);
      }
    }
    if (!open) { // something standing in the doorway keeps it open
      const blockers = [...this.players.values()].filter((q) => !q.dead).concat(this.zombies);
      for (const i of grp) {
        const cx = (i % this.W), cy = (i / this.W) | 0;
        for (const q of blockers) {
          const nx = Math.max(cx, Math.min(q.x, cx + 1)), ny = Math.max(cy, Math.min(q.y, cy + 1));
          if ((q.x - nx) ** 2 + (q.y - ny) ** 2 < (PLAYER_R + 0.05) ** 2) { if (!quiet && p && p.conn) p.conn.send({ t: 'toast', text: 'Something is in the way' }); return true; }
        }
      }
    }
    for (const i of grp) {
      if (open) this.doorOpen.add(i); else this.doorOpen.delete(i);
      this.solidArr[i] = open ? 0 : 1; this.sightArr[i] = open ? 0 : 1;
    }
    this.ev.push(['o', open ? 1 : 0, grp]);
    return true;
  }
  placePlayer(p) {
    const sp = this.mode === 'pvp' ? this.respawnSpot(p) : this.map.playerSpawns[Math.floor(rand() * this.map.playerSpawns.length)];
    p.x = sp.x + 0.5 + (rand() - 0.5) * 0.4;
    p.y = sp.y + 0.5 + (rand() - 0.5) * 0.4;
    p.hp = PLAYER_HP; p.dead = false; p.weapon = this.startWeapon; p.bag = []; p.cd = 0; p.shoot = false; p.rs = 0; p.inv = 0; p.ammo = AMMO_START; p.stam = STAM_MAX; p.exh = false; p.sprinting = false; p.dashT = 0; p.dashLeft = 0; p.boostT = 0; p.dinv = 0; p.armor = 0; p.nades = NADE_START; p.nadeCd = 0; p.heat = 0; p.lock = 0; p.turrets = 0; p.walls = 0; p.mines = 0;
  }
  // pvp respawn: the spawn point farthest from every living enemy
  respawnSpot(p) {
    const enemies = this.alivePlayers().filter((q) => this.foe(p, q));
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
    p.hp = PLAYER_HP; p.dead = false; p.weapon = this.startWeapon; p.bag = []; p.cd = 0.3; p.shoot = false; p.rs = 0; p.inv = SPAWN_PROTECT; p.ammo = AMMO_START; p.stam = STAM_MAX; p.exh = false; p.sprinting = false; p.dashT = 0; p.dashLeft = 0; p.boostT = 0; p.dinv = 0; p.armor = 0; p.nades = NADE_START; p.nadeCd = 0; p.heat = 0; p.lock = 0; p.turrets = 0; p.walls = 0; p.mines = 0;
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
    if (this.mode === 'coop') this.spawnSupplies();
    for (const p of this.players.values()) p.conn.send(this.initMsg(p));
    if (this.mode === 'pvp') {
      this.say(`${this.teams ? 'Team deathmatch (Red vs Blue)!' : 'Deathmatch!'} ${this.killLimit ? 'First to ' + this.killLimit + ' kills wins' : 'Endless'} on ${this.map.name}. You respawn ${RESPAWN_SECONDS}s after dying. Press Enter to chat.`);
    } else {
      this.say(`Game on! ${this.waves ? this.waves + ' waves' : 'Endless'} on ${this.map.name} (${this.difficulty}). Wave 1 in ${this.timer}s - build your base!`);
      this.broadcast({ t: 'toast', text: 'Prepare! Open supply crates, then build: T turret, B barricade, N mine, X remove' });
    }
    this.sendRoom();
  }
  end(result, winner, winTeam = -1) {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.overT = 14;
    const stats = [...this.players.values()].map((p) => ({ name: p.name, color: p.color, kills: p.kills, deaths: p.deaths, team: this.teams ? p.team : -1 })).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.lastOver = { t: 'over', result, wave: this.wave, stats, winner: winner ? winner.name : '', winnerId: winner ? winner.id : 0, killLimit: this.killLimit, teams: this.teams, winTeam, teamScore: this.teams ? [this.teamScore(0), this.teamScore(1)] : null };
    this.broadcast(this.lastOver);
    this.sendRoom();
  }
  backToLobby() {
    this.state = 'lobby';
    this.resetWorld();
    for (const p of this.players.values()) { p.dead = false; p.shoot = false; p.rs = 0; p.inv = 0; }
    this.sendRoom();
  }

  // things that may lie around / drop: allowed weapons (except the one you already start with) and heal items
  lootIds() {
    return Object.keys(this.itemDefs).filter((k) => {
      const d = this.itemDefs[k];
      return d.type === 'heal' || d.type === 'armor' || d.type === 'grenade' || (d.type === 'weapon' && this.allowed.has(k) && k !== this.startWeapon);
    });
  }
  itemOk(id) {
    const d = this.itemDefs[id];
    return !!d && (d.type !== 'weapon' || this.allowed.has(id));
  }
  spawnMapItems(force) {
    const ids = this.lootIds();
    for (const s of this.map.itemSpawns) {
      const cx = s.x + 0.5, cy = s.y + 0.5;
      if (this.ground.some((g) => !g.ttl && Math.abs(g.x - cx) < 0.6 && Math.abs(g.y - cy) < 0.6)) continue;
      if (!force && rand() < 0.35) continue;
      let item = s.item;
      if (item === 'random' || !this.itemOk(item)) item = this.itemDefs.ammo && rand() < 0.35 ? 'ammo' : ids[Math.floor(rand() * ids.length)];
      if (item) this.addGround(cx, cy, item, 0);
    }
  }
  addGround(x, y, item, ttl) {
    this.ground.push({ id: this.nextId++, x, y, item, ttl });
    if (this.ground.length > 90) this.ground.shift();
    this.gver++;
  }

  // ---------- input ----------
  // A dash press: its own message (like chat / a shot) that is relayed to everyone at once; every browser then plays the roll itself.
  // It is also sent inside the normal input message (dh), so whichever arrives first starts it and the other is ignored.
  dash(p, dx, dy) {
    if (p.dashT > 0 && p.dashStart && Date.now() - p.dashStart < 700) return; // (duplicate of the same press)
    const why = this.state !== 'playing' ? 'room is ' + this.state : p.dead ? 'dead' : p.dashT > 0 ? 'already dashing' : p.stam < STAM_MAX * 0.85 ? 'charge ' + Math.round(p.stam) : '';
    if (why) { p.conn.send({ t: 'dx', why }); return; }
    const len = Math.hypot(dx, dy);
    const ddx = len > 0.01 ? dx / len : Math.cos(p.a), ddy = len > 0.01 ? dy / len : Math.sin(p.a);
    p.dashT = DASH_TIME; p.dashLeft = DASH_TIME; p.dinv = DASH_INV; p.stam = 0; p.dashStart = Date.now();
    this.ev.push(['D', p.id]);
    this.broadcast({ t: 'dd', id: p.id, x: r2(p.x), y: r2(p.y), dx: r2(ddx), dy: r2(ddy), b: p.boostT > 0 ? 1 : 0 });
  }
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
    if (len > 0.01) { dx /= len; dy /= len; }
    // dash (Shift): needs a full charge. It is just a short burst of fast running (DASH_MULT x speed for DASH_TIME seconds of
    // movement) plus DASH_INV seconds of invincibility; the client draws it as a roll.
    if ((m.dh === 1 || m.dh === true) && p.dashT <= 0) this.dash(p, dx, dy);
    if (len > 0.01 && use > 0) {
      if (aim === null) p.a = Math.atan2(dy, dx);
      let boost = 0;
      if ((m.sp === 1 || m.sp === true) && p.dashLeft > 0) { boost = Math.min(use, p.dashLeft); p.dashLeft -= boost; }
      const dist = PLAYER_SPEED * weaponSpeed(this.weapon(p.weapon)) * (p.boostT > 0 ? KILL_BOOST : 1) * (boost * DASH_MULT + (use - boost));
      this.move(p, dx * dist, dy * dist, PLAYER_R);
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
      if (!best) { this.toggleDoor(p); return; }
      const def = this.itemDefs[best.item];
      if (!def) return;
      if (def.type === 'ammo') {
        if (p.ammo >= AMMO_MAX) { p.conn.send({ t: 'toast', text: 'Ammo full' }); return; }
        p.ammo = Math.min(AMMO_MAX, p.ammo + (def.amount || 40));
      } else if (def.type === 'grenade') {
        if (p.nades >= NADE_MAX) { p.conn.send({ t: 'toast', text: 'Grenades full' }); return; }
        p.nades = Math.min(NADE_MAX, p.nades + (def.amount || 1));
      } else if (def.type === 'armor') {
        if (p.armor >= ARMOR_MAX) { p.conn.send({ t: 'toast', text: 'Armor full' }); return; }
        p.armor = Math.min(ARMOR_MAX, p.armor + (def.amount || 40));
      } else if (def.type === 'heal') {
        if (p.bag.length >= BAG_MAX) { p.conn.send({ t: 'toast', text: 'Bag full (max ' + BAG_MAX + ')' }); return; }
        p.bag.push(def.id);
      } else {
        if (p.weapon !== this.startWeapon) this.addGround(best.x, best.y, p.weapon, 0);
        p.weapon = def.id;
        p.cd = 0.25;
      }
      this.ground.splice(this.ground.indexOf(best), 1);
      this.gver++;
      this.ev.push(['u', p.id]);
    } else if (k === 'drop') {
      if (p.weapon === this.startWeapon) return;
      this.addGround(p.x + Math.cos(p.a) * 0.9, p.y + Math.sin(p.a) * 0.9, p.weapon, 0);
      p.weapon = this.startWeapon;
    } else if (k === 'turret') {
      this.plantTurret(p);
    } else if (k === 'wall') {
      this.plantWall(p);
    } else if (k === 'mine') {
      this.plantMine(p);
    } else if (k === 'remove') {
      this.removeGear(p);
    } else if (k === 'nade') {
      this.throwNade(p);
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
  // swords: a wide arc in front of you, no bullets used
  swing(p, w) {
    p.cd = 1 / w.rate;
    p.inv = 0;
    const pvp = this.mode === 'pvp';
    const targets = pvp ? this.alivePlayers().filter((q) => this.foe(p, q) && !(q.inv > 0 || q.dinv > 0)) : this.zombies.slice();
    const arc = w.arc || 1.7, half = arc / 2;
    let hit = 0;
    for (const z of targets) {
      if (this.state !== 'playing') break;
      if (z.dead) continue;
      const r = pvp ? PLAYER_R + 0.1 : z.r;
      const ox = z.x - p.x, oy = z.y - p.y, d = Math.hypot(ox, oy);
      if (d > w.range + r) continue;
      if (d > 0.45 && Math.abs(normAng(Math.atan2(oy, ox) - p.a)) > half + Math.atan2(r, d)) continue;
      if (d > r + 0.1 && this.rayWall(p.x, p.y, ox / d, oy / d, d) < d - 0.3) continue; // not through walls
      hit = 1;
      if (pvp) this.damagePlayer(z, w.damage, p); else this.damageZombie(z, w.damage, p);
    }
    this.ev.push(['w', p.id, r2(p.x), r2(p.y), r2(p.a), w.range, arc, hit, w.id]);
  }
  fire(p) {
    const w = this.weapon(p.weapon);
    if (w.melee) return this.swing(p, w);
    // flamethrower: a stream of fire, 1 ammo per 4 puffs
    const cost = w.flame ? (((p.fl = ((p.fl | 0) + 1) % 4) === 1) ? 1 : 0) : (w.ammoCost || 1);
    if (p.ammo < Math.max(cost, w.flame ? 1 : 0)) { p.cd = 0.3; this.ev.push(['e', p.id]); return; }
    p.ammo -= cost;
    p.cd = 1 / w.rate;
    if (w.heat) { // gatling: firing builds heat; at 100% it jams and you wait out the cooldown
      p.heat += w.heat;
      if (p.heat >= 1) { p.heat = 1; p.lock = w.lock || 2.8; this.ev.push(['j', p.id]); }
    }
    if (w.launcher) { p.inv = 0; return this.launch(p, w); }
    if (w.flame) { p.inv = 0; return this.flame(p, w); }
    p.inv = 0; // shooting ends spawn protection
    const pvp = this.mode === 'pvp';
    // targets: other players that are alive and not spawn-protected (pvp) or zombies (co-op)
    const targets = pvp ? this.alivePlayers().filter((q) => this.foe(p, q) && !(q.inv > 0 || q.dinv > 0)) : this.zombies;
    const tr = pvp ? PLAYER_R + 0.1 : 0;
    p.sentHs = 0;
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
      let len = wallD, hit = 0, head = 0;
      const n = Math.min(hits.length, 1 + w.pierce);
      for (let k = 0; k < n; k++) {
        if (hits[k].t > wallD) break;
        const dmg = w.damage, z = hits[k].z;
        const real = dmg * DMG_SCALE, soak = pvp ? Math.min(z.armor, real * ARMOR_ABSORB) : 0;
        const hs = !z.dead && z.hp - (real - soak) <= 0 && rand() < HS_CHANCE; // the killing shot, 1 in 20
        if (pvp) this.damagePlayer(hits[k].z, dmg, p); else this.damageZombie(hits[k].z, dmg, p);
        len = hits[k].t; hit = 1;
        if (hs) { head = 1; if (p.conn && !p.ai && !p.sentHs) { p.sentHs = 1; p.conn.send({ t: 'hs' }); } }
      }
      this.ev.push(['s', r2(p.x), r2(p.y), r2(ang), r2(len), hit, w.id, head]);
    }
  }
  // flamethrower: hits everything in a short cone. 3 seconds of unbroken fire sets the target alight (burn damage for a few seconds)
  flame(p, w) {
    const pvp = this.mode === 'pvp';
    const targets = pvp ? this.alivePlayers().filter((q) => this.foe(p, q) && !(q.inv > 0 || q.dinv > 0)) : this.zombies;
    let hit = 0, len = w.range;
    for (const z of targets) {
      if (z.dead || z === p) continue;
      const r = pvp ? PLAYER_R : z.r, ox = z.x - p.x, oy = z.y - p.y, d = Math.hypot(ox, oy);
      if (d > w.range + r) continue;
      const da = Math.abs(Math.atan2(Math.sin(Math.atan2(oy, ox) - p.a), Math.cos(Math.atan2(oy, ox) - p.a)));
      if (d > 0.01 && da > w.spread + Math.asin(Math.min(1, r / d))) continue;
      const wd = this.rayWall(p.x, p.y, ox / (d || 1), oy / (d || 1), d);
      if (wd < d - r - 0.05) continue;
      hit = 1;
      if (pvp) this.damagePlayer(z, w.damage, p); else this.damageZombie(z, w.damage, p);
      z.fGap = 0; z.fAcc = (z.fAcc || 0) + DT * Math.ceil(1 / w.rate / DT - 1e-6); // real time between puffs (ticks)
      if (z.fAcc >= 3 && !z.dead) { if (!(z.burn > 0)) this.ev.push(['b', r2(z.x), r2(z.y)]); z.burn = 4; z.burner = p; }
    }
    this.ev.push(['s', r2(p.x), r2(p.y), r2(p.a), r2(w.range), hit, w.id, 0]);
  }
  // fire that keeps burning: called every tick for zombies and players
  updateBurn() {
    const all = this.zombies.concat([...this.players.values()]);
    for (const z of all) {
      if (z.fAcc > 0 && (z.fGap = (z.fGap || 0) + DT) > 0.5) z.fAcc = 0; // the stream was broken
      if (!(z.burn > 0)) continue;
      if (z.dead) { z.burn = 0; continue; }
      z.burn -= DT;
      z.bt = (z.bt || 0) + DT;
      if (z.bt >= 0.5) {
        z.bt = 0;
        this.ev.push(['b', r2(z.x), r2(z.y)]);
        const src = z.burner || { kills: 0 };
        if (z.name !== undefined) this.damagePlayer(z, 5, src); else this.damageZombie(z, 7, src);
      }
    }
  }
  // damage to a player: armor soaks ARMOR_ABSORB of it until it is gone
  hurt(v, dmg) {
    const soak = Math.min(v.armor, dmg * ARMOR_ABSORB);
    v.armor -= soak;
    v.hp -= dmg - soak;
  }
  damagePlayer(v, dmg, killer) {
    if (v.dead) return;
    this.hurt(v, dmg * DMG_SCALE);
    this.ev.push(['h', v.id]);
    if (v.hp <= 0) this.die(v, killer);
  }
  damageZombie(z, dmg, p) {
    if (z.dead) return;
    z.hp -= dmg * DMG_SCALE;
    if (z.hp > 0) return;
    z.dead = true;
    p.kills++; p.boostT = KILL_BOOST_TIME;
    this.ev.push(['k', r2(z.x), r2(z.y), z.type]);
    const big = z.type === 3 ? 1 : z.type === 2 ? 0.25 : 0;
    if (this.mode === 'coop') { // base-building gear is rare: turrets rarest
      const gear = (id, base) => { if (this.itemDefs[id] && rand() < base + big * 0.35) this.addGround(z.x - 0.3, z.y - 0.2, id, 45); };
      if (rand() < 0.5) gear('turret', 0.02); else if (rand() < 0.5) gear('barricade', 0.08); else gear('mine', 0.08);
    }
    if (rand() < 0.1 * this.d.drop + (z.type >= 2 ? 0.5 : 0)) {
      const ids = this.lootIds();
      if (ids.length) this.addGround(z.x, z.y, ids[Math.floor(rand() * ids.length)], 45);
    }
    if (this.itemDefs.ammo && rand() < 0.16 + (z.type >= 2 ? 0.5 : 0)) this.addGround(z.x + 0.3, z.y + 0.3, 'ammo', 45);
  }
  die(p, killer) {
    if (this.mode === 'pvp') return this.diePvp(p, killer);
    p.dead = true; p.hp = 0; p.shoot = false; p.deaths++; p.burn = 0; p.fAcc = 0;
    this.graves.push({ pid: p.id, name: p.name, x: p.x, y: p.y, prog: 0 });
    if (p.weapon !== this.startWeapon) { this.addGround(p.x, p.y, p.weapon, 0); p.weapon = this.startWeapon; }
    p.bag = [];
    this.ev.push(['d', p.id]);
    this.say(`${p.name} was eaten! Stand on the grave for ${this.reviveSeconds}s to revive them.`);
    if (!this.alivePlayers().length) this.end('defeat');
  }
  // pvp: no graves, you come back on your own after RESPAWN_SECONDS
  diePvp(p, killer) {
    p.dead = true; p.hp = 0; p.shoot = false; p.deaths++; p.rs = RESPAWN_SECONDS; p.inv = 0; p.dashT = 0; p.boostT = 0; p.dinv = 0;
    if (this.deathDrop) {
      // room option: whatever you carried, plus one random gun / heal item and some ammo, falls where you died
      if (p.weapon !== this.startWeapon) this.addGround(p.x, p.y, p.weapon, 30);
      const ids = this.lootIds();
      if (ids.length) this.addGround(p.x + (rand() - 0.5) * 0.9, p.y + (rand() - 0.5) * 0.9, ids[Math.floor(rand() * ids.length)], 30);
      if (this.itemDefs.ammo && p.ammo >= 20) this.addGround(p.x + 0.4, p.y, 'ammo', 30);
    }
    p.weapon = this.startWeapon;
    p.bag = [];
    this.ev.push(['d', p.id]);
    const k = killer && killer.id !== p.id ? killer : null;
    if (k) { k.kills++; k.boostT = KILL_BOOST_TIME; }
    this.say(k ? `${k.name} eliminated ${p.name}` : `${p.name} died`);
    if (this.teams) {
      if (k && this.killLimit && this.teamScore(k.team) >= this.killLimit) {
        this.say(`${TEAM_NAMES[k.team]} team wins the deathmatch!`);
        this.end('pvp', k, k.team);
      }
    } else if (k && this.killLimit && k.kills >= this.killLimit) {
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
      const cx = x0 + (x1 - x0) * f, cy = y0 + (y1 - y0) * f;
      if (this.blocked(cx, cy, r) || !canStep(this.hAt, x0 + (x1 - x0) * (i - 1) / n, y0 + (y1 - y0) * (i - 1) / n, cx, cy)) return false;
    }
    return true;
  }
  bfs(sx, sy, tx, ty) {
    const W = this.W, H = this.H, N = W * H;
    sx = Math.max(0, Math.min(W - 1, sx)); sy = Math.max(0, Math.min(H - 1, sy));
    tx = Math.max(0, Math.min(W - 1, tx)); ty = Math.max(0, Math.min(H - 1, ty));
    const s = sy * W + sx, g = ty * W + tx;
    if (this.baseSolid[g] || s === g) return [];
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
        if (prev[n] !== -1 || this.baseSolid[n]) continue;
        if (!canStep(this.hAt, cx + 0.5, cy + 0.5, nx + 0.5, ny + 0.5)) continue;
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
      if (q === p || q.dead || !this.foe(p, q) || !this.canSee(p, q)) continue;
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
    if (!(los && dist < 12) || (p.ammo < 10 && !w.melee)) {
      const cur = dps(w);
      let bs = 18 * 18;
      for (const g of this.ground) {
        const def = this.itemDefs[g.item];
        if (!def) continue;
        const want = def.type === 'armor' ? p.armor < 40 : def.type === 'ammo' ? p.ammo < 45 && !w.melee : def.type === 'heal' ? p.hp < 80 && p.bag.length < BAG_MAX : dps(def) > cur * 1.15;
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
      const ideal = w.melee ? Math.max(0.8, w.range * 0.55) : w.range <= 9 ? 3.5 : w.range >= 25 ? 12 : 6.5;
      const ux = (tgt.x - p.x) / dist, uy = (tgt.y - p.y) / dist;
      const radial = dist > ideal + 1.5 ? 1 : dist < ideal - 1.5 ? -1 : 0;
      if (ai.strafeT <= 0) { ai.strafeT = 0.8 + rand() * 1.4; if (rand() < 0.6) ai.strafe *= -1; }
      mx = ux * radial - uy * ai.strafe * 0.9;
      my = uy * radial + ux * ai.strafe * 0.9;
      want = Math.atan2(tgt.y - p.y, tgt.x - p.x) + ai.aimErr;
      const diff = Math.abs(normAng(want - p.a));
      shoot = (w.melee || p.ammo > 0) && ai.seeT >= sk.react && dist < w.range * 0.95 && diff < 0.2 && !(tgt.inv > 0 || tgt.dinv > 0);
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
      const sp = PLAYER_SPEED * sk.spd * DT;
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
      if (p.dinv > 0) p.dinv -= DT;
      if (p.boostT > 0) p.boostT -= DT;
      if (p.dashT > 0) p.dashT -= DT; // (rolling: no shooting)
      else p.stam = Math.min(STAM_MAX, p.stam + (STAM_MAX / DASH_CD) * DT);
      this.autoPickup(p);
      if (p.nadeCd > 0) p.nadeCd -= DT;
      if (p.lock > 0) { p.lock -= DT; if (p.lock <= 0) { p.lock = 0; p.heat = 0; } } else if (p.heat > 0 && !(p.shoot && this.weapon(p.weapon).heat)) p.heat = Math.max(0, p.heat - 0.3 * DT);
      if (p.bot && this.tickN % 6 === 0) for (const i of this.doorIdx) if (!this.doorOpen.has(i) && (((i % this.W) + 0.5) - p.x) ** 2 + (((i / this.W | 0) + 0.5) - p.y) ** 2 < 2.6) { this.setDoorGroup(p, i, true, true); break; }
      if (p.bot) this.botThink(p);
      p.cd -= DT;
      if (p.shoot && p.cd <= 0 && !(p.dashT > 0) && !(p.lock > 0) && this.state === 'playing') this.fire(p);
    }
    if (this.state !== 'playing') { this.ev = []; return; }
    if (pvp) {
      if ((this.pvpT -= DT) <= 0) { this.pvpT = PVP_ITEM_EVERY; this.spawnMapItems(false); }
    } else {
      this.updateWave();
      this.updateZombies();
      this.updateGraves();
      this.updateGear();
    }
    if (this.state === 'playing') this.updateBurn();
    if (this.state === 'playing') this.updateNades();
    for (let i = this.ground.length - 1; i >= 0; i--) {
      const g = this.ground[i];
      if (g.ttl && (g.ttl -= DT) <= 0) { this.ground.splice(i, 1); this.gver++; }
    }
    if (this.state === 'playing') this.sendSnapshot();
    this.ev = [];
  }

  // walking over things picks them up: ammo, grenades, armor that is better than yours (swap), and heals in pvp when hurt
  autoPickup(p) {
    for (let i = 0; i < this.ground.length; i++) {
      const g = this.ground[i];
      if ((g.x - p.x) ** 2 + (g.y - p.y) ** 2 > AMMO_PICK_R * AMMO_PICK_R) continue;
      const def = this.itemDefs[g.item];
      if (!def) continue;
      if (def.type === 'ammo' && p.ammo < AMMO_MAX) p.ammo = Math.min(AMMO_MAX, p.ammo + (def.amount || 40));
      else if (def.type === 'grenade' && p.nades < NADE_MAX) p.nades = Math.min(NADE_MAX, p.nades + (def.amount || 1));
      else if (def.type === 'turret' && p.turrets < CARRY.turret) p.turrets = Math.min(CARRY.turret, p.turrets + (def.amount || 1));
      else if (def.type === 'barricade' && p.walls < CARRY.barricade) p.walls = Math.min(CARRY.barricade, p.walls + (def.amount || 3));
      else if (def.type === 'mine' && p.mines < CARRY.mine) p.mines = Math.min(CARRY.mine, p.mines + (def.amount || 2));
      else if (def.type === 'crate') this.openCrate(p);
      else if (def.type === 'armor' && (def.amount || 40) > p.armor) p.armor = Math.min(ARMOR_MAX, def.amount || 40);
      else if (def.type === 'heal' && this.mode === 'pvp' && p.hp < PLAYER_HP) { p.hp = Math.min(PLAYER_HP, p.hp + (def.heal || 25)); this.ev.push(['m', p.id]); }
      else continue;
      this.ground.splice(i, 1);
      this.gver++;
      this.ev.push(['u', p.id]);
      return;
    }
  }

  // ---------- zombie-defense gear (co-op) ----------
  toast(p, text) { if (p && p.conn && !p.bot) p.conn.send({ t: 'toast', text }); }
  spawnSupplies(n = 4) {
    if (!this.itemDefs.crate) return;
    // random spots all over the map (inside the fort or out in the open), spread apart and away from the zombie spawns
    const spots = [];
    for (let placed = 0, tries = 0; placed < n && tries < 1500; tries++) {
      const x = 1 + Math.floor(rand() * (this.W - 2)), y = 1 + Math.floor(rand() * (this.H - 2));
      const gap = Math.max(2, 9 - tries / 150); // relax the spacing if the map is crowded
      if (this.solidArr[y * this.W + x] || this.walls.has(y * this.W + x)) continue;
      if (this.map.zombieSpawns.some((q) => Math.hypot(q.x - x, q.y - y) < 7)) continue;
      if (spots.some((q) => Math.hypot(q.x - x, q.y - y) < gap)) continue;
      if (this.ground.some((g) => Math.abs(g.x - x - 0.5) < 1.5 && Math.abs(g.y - y - 0.5) < 1.5)) continue;
      spots.push({ x, y });
      this.addGround(x + 0.5, y + 0.5, 'crate', 0); placed++;
    }
  }
  openCrate(p) {
    if (rand() < 0.5) { p.turrets = Math.min(CARRY.turret, p.turrets + 1); this.toast(p, 'Crate: Auto Turret [T]'); }
    else { p.walls = Math.min(CARRY.barricade, p.walls + 5); this.toast(p, 'Crate: 5 Barricades [B]'); }
  }
  plantTurret(p) {
    if (this.mode !== 'coop' || p.turrets <= 0) return;
    if (this.turrets.length >= TURRET_MAX) return this.toast(p, 'Too many turrets (max ' + TURRET_MAX + ')');
    const x = p.x + Math.cos(p.a) * 1.1, y = p.y + Math.sin(p.a) * 1.1;
    if (this.blocked(x, y, 0.35) || this.turrets.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < 0.8)) return this.toast(p, 'No room here');
    const def = this.itemDefs.turret || {};
    this.turrets.push({ id: this.nextId++, turret: true, owner: p.id, x, y, hp: def.hp || 140, maxHp: def.hp || 140, ammo: TURRET_AMMO, cd: 0.6, a: p.a, dead: false, r: 0.35 });
    p.turrets--;
    this.ev.push(['P', r2(x), r2(y)]);
  }
  plantWall(p) {
    if (this.mode !== 'coop' || p.walls <= 0) return;
    const tx = Math.floor(p.x + Math.cos(p.a) * 1.3), ty = Math.floor(p.y + Math.sin(p.a) * 1.3), idx = ty * this.W + tx;
    if (tx < 1 || ty < 1 || tx >= this.W - 1 || ty >= this.H - 1 || this.solidArr[idx] || this.doorIdx.includes(idx)) return this.toast(p, 'Cannot build here');
    const blockers = [...this.players.values()].filter((q) => !q.dead).concat(this.zombies, this.turrets);
    for (const q of blockers) {
      const nx = Math.max(tx, Math.min(q.x, tx + 1)), ny = Math.max(ty, Math.min(q.y, ty + 1));
      if ((q.x - nx) ** 2 + (q.y - ny) ** 2 < (PLAYER_R + 0.08) ** 2) return this.toast(p, 'Something is in the way');
    }
    const hp = (this.itemDefs.barricade && this.itemDefs.barricade.hp) || 160;
    this.walls.set(idx, { hp, maxHp: hp });
    this.solidArr[idx] = 1; // (bullets pass: sightArr is untouched)
    p.walls--;
    this.ev.push(['W', idx, 1]);
  }
  plantMine(p) {
    if (this.mode !== 'coop' || p.mines <= 0) return;
    if (this.mines.some((m) => (m.x - p.x) ** 2 + (m.y - p.y) ** 2 < 0.6)) return this.toast(p, 'A mine is already here');
    this.mines.push({ id: this.nextId++, owner: p.id, x: p.x, y: p.y, arm: MINE_ARM });
    p.mines--;
    this.ev.push(['P', r2(p.x), r2(p.y)]);
  }
  // X: take back the nearest barricade or turret within reach (mines can't be picked up once planted)
  removeGear(p) {
    if (this.mode !== 'coop') return;
    let best = null, bd = 2.2 * 2.2;
    for (const idx of this.walls.keys()) { const d = ((idx % this.W) + 0.5 - p.x) ** 2 + (((idx / this.W) | 0) + 0.5 - p.y) ** 2; if (d < bd) { bd = d; best = { wall: idx }; } }
    for (const t of this.turrets) { const d = (t.x - p.x) ** 2 + (t.y - p.y) ** 2; if (d < bd) { bd = d; best = { turret: t }; } }
    if (!best) return this.toast(p, 'Nothing to remove nearby');
    if (best.turret) { this.turrets.splice(this.turrets.indexOf(best.turret), 1); p.turrets = Math.min(CARRY.turret, p.turrets + 1); }
    else { this.dropWall(best.wall); p.walls = Math.min(CARRY.barricade, p.walls + 1); }
  }
  dropWall(idx) {
    this.walls.delete(idx);
    this.solidArr[idx] = this.baseSolid[idx];
    this.ev.push(['W', idx, 0]);
  }
  damageWall(idx, dmg) {
    const w = this.walls.get(idx);
    if (!w) return;
    w.hp -= dmg;
    this.ev.push(['wh', idx]);
    if (w.hp <= 0) { this.dropWall(idx); this.ev.push(['X', (idx % this.W) + 0.5, ((idx / this.W) | 0) + 0.5]); }
  }
  updateGear() {
    const def = this.itemDefs.turret || {}, dmg = def.damage || 9, rate = def.rate || 4, range = def.range || 10;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      if (t.hp <= 0) { this.turrets.splice(i, 1); this.ev.push(['X', r2(t.x), r2(t.y)]); continue; }
      t.cd -= DT;
      let tgt = null, bd = range * range;
      for (const z of this.zombies) {
        if (z.dead) continue;
        const d = (z.x - t.x) ** 2 + (z.y - t.y) ** 2;
        if (d >= bd) continue;
        const dist = Math.sqrt(d);
        if (this.rayWall(t.x, t.y, (z.x - t.x) / dist, (z.y - t.y) / dist, dist) < dist - 0.3) continue; // (barricades do not block: bullets pass over)
        bd = d; tgt = z;
      }
      if (!tgt) continue;
      const dist = Math.sqrt(bd);
      t.a = Math.atan2(tgt.y - t.y, tgt.x - t.x);
      if (t.cd > 0 || t.ammo <= 0) continue;
      t.cd = 1 / rate; t.ammo--;
      const owner = this.players.get(t.owner) || { kills: 0 };
      this.damageZombie(tgt, dmg, owner);
      this.ev.push(['q', t.id, r2(t.x), r2(t.y), r2(t.a), r2(dist)]);
    }
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (m.arm > 0) { m.arm -= DT; continue; }
      if (!this.zombies.some((z) => !z.dead && (z.x - m.x) ** 2 + (z.y - m.y) ** 2 < (z.r + 0.3) ** 2)) continue;
      this.mines.splice(i, 1);
      const md = this.itemDefs.mine || {};
      this.explode({ x: m.x, y: m.y, owner: m.owner }, { damage: md.damage || 110, radius: md.radius || 2.4 });
    }
  }

  // ---------- grenades ----------
  throwNade(p) {
    if (p.nades <= 0 || p.nadeCd > 0 || p.dead || this.state !== 'playing') return;
    p.nades--; p.nadeCd = 0.6; p.inv = 0;
    const dx = Math.cos(p.a), dy = Math.sin(p.a);
    // start a little ahead of you, but never inside a wall
    let sx = p.x, sy = p.y;
    for (const d of [0.7, 0.5, 0.3]) if (!this.sight(Math.floor(p.x + dx * d), Math.floor(p.y + dy * d))) { sx = p.x + dx * d; sy = p.y + dy * d; break; }
    this.nades.push({ id: this.nextId++, owner: p.id, x: sx, y: sy, vx: dx * NADE_SPEED, vy: dy * NADE_SPEED, t: NADE_FUSE });
    this.ev.push(['t', p.id]);
  }
  // grenade launcher: the shell flies straight, explodes on the first wall / enemy it touches (or when its fuse ends)
  launch(p, w) {
    const dx = Math.cos(p.a), dy = Math.sin(p.a);
    let sx = p.x, sy = p.y;
    for (const d of [0.7, 0.5, 0.3]) if (!this.sight(Math.floor(p.x + dx * d), Math.floor(p.y + dy * d))) { sx = p.x + dx * d; sy = p.y + dy * d; break; }
    this.nades.push({ id: this.nextId++, owner: p.id, x: sx, y: sy, vx: dx * 15, vy: dy * 15, t: Math.max(0.4, w.range / 15), shell: w });
    this.ev.push(['t', p.id]);
  }
  updateNades() {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      n.t -= DT;
      const nx = n.x + n.vx * DT, ny = n.y + n.vy * DT;
      if (n.shell) {
        let boom = n.t <= 0 || this.sight(Math.floor(nx), Math.floor(ny));
        if (!boom) {
          if (this.mode === 'pvp') { for (const q of this.alivePlayers()) if (q.id !== n.owner && !(q.inv > 0 || q.dinv > 0) && this.foe(this.players.get(n.owner) || q, q) && (q.x - nx) ** 2 + (q.y - ny) ** 2 < (PLAYER_R + 0.15) ** 2) { boom = true; break; } }
          else for (const z of this.zombies) if (!z.dead && (z.x - nx) ** 2 + (z.y - ny) ** 2 < (z.r + 0.15) ** 2) { boom = true; break; }
        }
        if (boom) { this.nades.splice(i, 1); this.explode(n, n.shell); if (this.state !== 'playing') return; } else { n.x = nx; n.y = ny; }
        continue;
      }
      if (this.sight(Math.floor(nx), Math.floor(n.y))) n.vx = -n.vx * 0.5; else n.x = nx;
      if (this.sight(Math.floor(n.x), Math.floor(ny))) n.vy = -n.vy * 0.5; else n.y = ny;
      n.vx *= 0.93; n.vy *= 0.93;
      if (n.t <= 0) { this.nades.splice(i, 1); this.explode(n); if (this.state !== 'playing') return; }
    }
  }
  explode(n, shellDef) {
    const def = shellDef || this.itemDefs.grenade || { damage: 80, radius: 3.2 };
    const R = def.radius || 3.2, owner = this.players.get(n.owner);
    this.ev.push(['g', r2(n.x), r2(n.y), R]);
    const pvp = this.mode === 'pvp';
    const hit = (e, rad, isPlayer) => {
      const d = Math.hypot(e.x - n.x, e.y - n.y);
      if (d > R + rad) return;
      if (d > 0.4 && this.rayWall(n.x, n.y, (e.x - n.x) / d, (e.y - n.y) / d, d) < d - 0.3) return; // walls shield you
      let dmg = def.damage * (1 - 0.7 * Math.min(1, d / R));
      if (isPlayer) {
        if (e.inv > 0 || e.dinv > 0) return;
        if (owner && e.id === owner.id) dmg *= 0.5;
        this.damagePlayer(e, dmg, owner);
      } else this.damageZombie(e, dmg, owner || { kills: 0 });
    };
    if (pvp) for (const q of this.alivePlayers()) { if (this.state !== 'playing') break; if (!owner || q.id === owner.id || this.foe(owner, q)) hit(q, PLAYER_R, true); }
    else for (const z of this.zombies.slice()) { if (!z.dead) hit(z, z.r, false); }
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
      if (this.mode === 'coop') { this.spawnSupplies(4); this.broadcast({ t: 'toast', text: '4 new supply crates dropped near the base!' }); }
      this.say(`Wave ${this.wave} cleared! Next wave in ${BREAK_SECONDS}s. Revive your friends!`);
    }
  }
  startWave() {
    this.wave++;
    const alive = Math.max(1, this.alivePlayers().length);
    // twice as many zombies as before; every 5th wave brings bosses (wave 5: one, wave 10: two)
    this.queue = Math.min(300, Math.round(2 * (6 + this.wave * 3) * this.d.cnt * (1 + 0.4 * (alive - 1))));
    this.bosses = this.wave % 5 === 0 ? Math.min(4, this.wave / 5) : 0;
    this.queue += this.bosses;
    this.spawnT = 0;
    this.phase = 'wave';
    this.say(`Wave ${this.wave}${this.waves ? '/' + this.waves : ''} - ${this.queue} zombies incoming!` + (this.bosses ? ` BOSS WAVE: ${this.bosses} boss${this.bosses > 1 ? 'es' : ''}!` : ''));
    if (this.bosses) this.broadcast({ t: 'toast', text: `BOSS WAVE! ${this.bosses} boss${this.bosses > 1 ? 'es' : ''} incoming` });
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
    if (this.bosses > 0) { type = 3; this.bosses--; }
    else if (roll < tankC) type = 2;
    else if (roll < tankC + runC) type = 1;
    const t = ZTYPES[type];
    const hp = t.hp * this.d.hp * (1 + this.wave * 0.06);
    this.zombies.push({
      id: this.nextId++, type, x: s.x + 0.5 + (rand() - 0.5) * 0.6, y: s.y + 0.5 + (rand() - 0.5) * 0.6,
      hp, maxHp: hp, spd: t.spd * this.d.spd * (0.9 + rand() * 0.2), dmg: t.dmg, r: t.r, cd: 0, side: rand() < 0.5 ? 1 : -1, dead: false,
    });
  }
  // distance field (in tiles) from a target over walkable tiles; thru = barricades count as walkable (the way a zombie would have to chew through).
  // Only used while barricades exist. Cached for a few ticks.
  fieldFor(tgt, thru) {
    if (!this.fieldCache || this.fieldCache.size > 60) this.fieldCache = new Map();
    const key = (tgt.turret ? 't' : 'p') + tgt.id + (thru ? 'w' : '');
    const c = this.fieldCache.get(key);
    if (c && this.tickN - c.n < 6) return c.d;
    const W = this.W, H = this.H, d = new Int16Array(W * H).fill(-1), q = new Int32Array(W * H);
    const ok = (i) => !this.solidArr[i] || (thru && this.walls.has(i));
    const s = Math.floor(tgt.y) * W + Math.floor(tgt.x);
    let qh = 0, qt = 0;
    d[s] = 0; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++], x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (d[j] >= 0 || !ok(j)) continue;
        if (dx && dy && (!ok(y * W + nx) || !ok(ny * W + x))) continue; // no corner cutting
        d[j] = d[i] + 1; q[qt++] = j;
      }
    }
    this.fieldCache.set(key, { n: this.tickN, d });
    return d;
  }
  // the neighbouring tile (centre x,y and index) that is closest to the target, or null
  flowStep(d, z) {
    const W = this.W, cx = Math.floor(z.x), cy = Math.floor(z.y), cur = d[cy * W + cx];
    if (cur <= 0) return null;
    let best = null, bv = cur;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
      const v = d[ny * W + nx];
      if (v >= 0 && v < bv) { bv = v; best = { x: nx + 0.5, y: ny + 0.5, idx: ny * W + nx }; }
    }
    return best;
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
      for (const t of this.turrets) { // turrets draw zombies too
        const d = (t.x - z.x) ** 2 + (t.y - z.y) ** 2;
        if (d < bd) { bd = d; tgt = t; }
      }
      if (!tgt) continue;
      const dist = Math.sqrt(bd), tr = tgt.turret ? 0.35 : PLAYER_R;
      if (dist > z.r + tr + 0.05) {
        const ang0 = Math.atan2(tgt.y - z.y, tgt.x - z.x);
        const step = z.spd * DT;
        // barricades: zombies walk around them if there is a way to you, and only chew through when every way is blocked
        let walled = false;
        if (this.walls.size && dist > 1.2 && this.fieldFor(tgt, false)[Math.floor(z.y) * this.W + Math.floor(z.x)] < 0) {
          const nxt = this.flowStep(this.fieldFor(tgt, true), z);
          if (nxt) {
            walled = true;
            const a2 = Math.atan2(nxt.y - z.y, nxt.x - z.x);
            if (this.walls.has(nxt.idx)) { // the next tile is a barricade: chew it when we are up against it
              const bx = Math.max(nxt.idx % this.W, Math.min(z.x, (nxt.idx % this.W) + 1)), by = Math.max((nxt.idx / this.W) | 0, Math.min(z.y, ((nxt.idx / this.W) | 0) + 1));
              if ((z.x - bx) ** 2 + (z.y - by) ** 2 < (z.r + 0.45) ** 2) { if (z.cd <= 0) { z.cd = 0.8; this.damageWall(nxt.idx, z.dmg * this.d.dmg * 1.2); } }
              else this.move(z, Math.cos(a2) * step, Math.sin(a2) * step, z.r);
            } else this.move(z, Math.cos(a2) * step, Math.sin(a2) * step, z.r);
          }
        }
        if (!walled && this.walls.size && dist > 1.2) { // a way round exists: near a barricade follow the path field instead of feeling along it
          let near = false;
          const zx = Math.floor(z.x), zy = Math.floor(z.y);
          for (let yy = zy - 2; yy <= zy + 2 && !near; yy++) for (let xx = zx - 2; xx <= zx + 2; xx++) if (this.walls.has(yy * this.W + xx)) { near = true; break; }
          const nxt = near ? this.flowStep(this.fieldFor(tgt, false), z) : null;
          if (nxt) { walled = true; const a2 = Math.atan2(nxt.y - z.y, nxt.x - z.x); this.move(z, Math.cos(a2) * step, Math.sin(a2) * step, z.r); }
        }
        const offs = [0, z.side * 0.9, -z.side * 0.9, z.side * 1.7, -z.side * 1.7];
        let done = walled;
        const x00 = z.x, y00 = z.y;
        for (let i = 0; i < offs.length && !done; i++) {
          const a = ang0 + offs[i];
          const sx = z.x, sy = z.y;
          this.move(z, Math.cos(a) * step, Math.sin(a) * step, z.r);
          if (Math.hypot(z.x - sx, z.y - sy) > step * 0.55 || i === offs.length - 1) {
            if (i > 0 && i < offs.length - 1) z.side = offs[i] > 0 ? 1 : -1;
            done = true;
          } else { z.x = sx; z.y = sy; }
        }
        if (!walled && this.walls.size && Math.hypot(z.x - x00, z.y - y00) < step * 0.4) { // bumping a barricade while a way round exists: use the path field to slide round it
          const nxt = this.flowStep(this.fieldFor(tgt, false), z);
          if (nxt) { const a2 = Math.atan2(nxt.y - z.y, nxt.x - z.x); this.move(z, Math.cos(a2) * step, Math.sin(a2) * step, z.r); }
        }
      }
      if (dist <= z.r + tr + 0.2 && z.cd <= 0 && !tgt.dead && !(tgt.dinv > 0)) {
        z.cd = 0.8;
        if (tgt.turret) { tgt.hp -= z.dmg * this.d.dmg; this.ev.push(['th', tgt.id]); if (tgt.hp <= 0) tgt.dead = true; }
        else {
          this.hurt(tgt, z.dmg * this.d.dmg);
          this.ev.push(['h', tgt.id]);
          if (tgt.hp <= 0) this.die(tgt);
        }
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
        p.dead = false; p.hp = PLAYER_HP / 2; p.x = g.x; p.y = g.y; p.weapon = 'pistol'; p.bag = []; p.cd = 0.5; p.ammo = AMMO_START; p.stam = STAM_MAX; p.exh = false; p.armor = 0;
        this.ev.push(['r', p.id]);
        this.say(`${rescuer.name} revived ${p.name}!`);
      }
    }
  }

  sendSnapshot() {
    const rest = {
      z: this.zombies.map((z) => [z.id, r2(z.x), r2(z.y), z.type, Math.max(1, Math.round((z.hp / z.maxHp) * 100))]),
      gr: this.graves.map((g) => [g.pid, r2(g.x), r2(g.y), Math.round(g.prog * 10) / 10, g.name]),
      gn: this.nades.map((n) => [n.id, r2(n.x), r2(n.y)]),
      tu: this.turrets.map((t) => [t.id, r2(t.x), r2(t.y), r2(t.a), Math.max(1, Math.round((t.hp / t.maxHp) * 100)), Math.round((t.ammo / TURRET_AMMO) * 100)]),
      mn: this.mines.map((m) => [m.id, r2(m.x), r2(m.y), m.arm > 0 ? 0 : 1]),
      wl: [...this.walls].filter(([, w]) => w.hp < w.maxHp).map(([i, w]) => [i, Math.max(1, Math.round((w.hp / w.maxHp) * 100))]),
      ev: this.ev,
    };
    const wStr = JSON.stringify({ n: this.wave, of: this.waves, ph: this.phase === 'wave' ? 1 : 0, tm: Math.ceil(Math.max(0, this.timer)), left: this.queue + this.zombies.length });
    const restStr = JSON.stringify(rest).slice(1);
    const all = [...this.players.values()];
    const tup = all.map((p) => JSON.stringify([p.id, r2(p.x), r2(p.y), r2(p.a), Math.max(0, Math.round(p.hp)), p.weapon, p.dead ? 1 : 0, p.bag.length, p.kills, Math.ceil(Math.max(0, p.rs)), p.inv > 0 || p.dinv > 0 ? 1 : 0, p.deaths, p.ammo, Math.round(p.stam), p.exh ? 1 : 0, Math.round(p.armor), p.dashT > 0 ? 1 : 0, p.boostT > 0 ? 1 : 0, p.nades, 0, Math.round((p.heat || 0) * 100), p.lock > 0 ? 1 : 0, p.turrets, p.walls, p.mines]));
    const hid = all.map((p) => JSON.stringify([p.id, 0, 0, 0, Math.max(0, Math.round(p.hp)), p.weapon, 0, 0, p.kills, 0, 0, p.deaths, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]));
    const gStr = JSON.stringify(this.ground.map((g) => [g.id, r2(g.x), r2(g.y), g.item]));
    const open = this.mode === 'pvp' ? all.some((q) => !q.dead && this.inBush(q)) : false;
    const everyone = '[' + tup.join(',') + ']';
    for (const p of all) {
      if (p.bot) continue;
      let head = '{"a":' + p.seq;
      if (p.gsent !== this.gver) { head += ',"g":' + gStr; p.gsent = this.gver; }
      // hidden players stay in the list (name, score) but get no position: flag 19 = hidden
      const pl = open ? '[' + all.map((q, i) => (this.canSee(p, q) ? tup[i] : hid[i])).join(',') + ']' : everyone;
      p.conn.raw(head + ',"t":"s","w":' + wStr + ',"p":' + pl + ',' + restStr);
    }
  }
}

module.exports = { FIT_COUNT, DMG_SCALE, STAM_MAX, DASH_TIME, DASH_MULT, KILL_BOOST, KILL_BOOST_TIME, DASH_INV, DASH_CD, ACC_COUNT, AMMO_START, AMMO_MAX, Room, TICK_HZ, DT, DIFF, REVIVE_SECONDS, RESPAWN_SECONDS };
