'use strict';
// Default items + maps and validators for admin-supplied content.

const DEFAULT_ITEMS = [
  { id: 'pistol', name: 'Pistol', type: 'weapon', weight: 1, builtin: true, damage: 20, rate: 3.5, range: 14, pellets: 1, spread: 0.03, pierce: 0, color: '#ffd166' },
  { id: 'smg', name: 'SMG', type: 'weapon', weight: 2.5, builtin: true, damage: 11, rate: 11, range: 12, pellets: 1, spread: 0.09, pierce: 0, color: '#06d6a0' },
  { id: 'shotgun', name: 'Shotgun', type: 'weapon', weight: 3.5, builtin: true, damage: 11, rate: 1.3, range: 8, pellets: 7, spread: 0.3, pierce: 0, color: '#ef476f' },
  { id: 'rifle', name: 'Rifle', type: 'weapon', weight: 4, builtin: true, damage: 34, rate: 4.5, range: 18, pellets: 1, spread: 0.015, pierce: 1, color: '#118ab2' },
  { id: 'sniper', name: 'Sniper', type: 'weapon', weight: 6, builtin: true, damage: 130, rate: 0.8, range: 32, pellets: 1, spread: 0, pierce: 3, color: '#9b5de5' },
  { id: 'bandage', name: 'Bandage', type: 'heal', builtin: true, heal: 25, color: '#f1f1f1' },
  { id: 'medkit', name: 'Medkit', type: 'heal', builtin: true, heal: 60, color: '#ff4d4d' },
  { id: 'gatling', name: 'Gatling Gun', type: 'weapon', weight: 9, builtin: true, damage: 6, rate: 16, range: 13, pellets: 1, spread: 0.13, pierce: 0, heat: 0.02, lock: 2.8, color: '#e76f51' },
  { id: 'launcher', name: 'Grenade Launcher', type: 'weapon', weight: 7, builtin: true, launcher: true, damage: 65, radius: 2.6, rate: 0.55, range: 14, pellets: 1, spread: 0, pierce: 0, ammoCost: 6, color: '#8ab17d' },
  { id: 'sword', name: 'Sword', type: 'weapon', weight: 2.5, melee: true, builtin: true, damage: 40, rate: 2.3, range: 2.2, arc: 1.8, pellets: 1, spread: 0, pierce: 0, color: '#c9d6df' },
  { id: 'katana', name: 'Katana', type: 'weapon', weight: 1.2, melee: true, builtin: true, move: 1.5, damage: 13, rate: 4, range: 2.5, arc: 1.4, pellets: 1, spread: 0, pierce: 0, color: '#e0e7ff' },
  { id: 'greatsword', name: 'Greatsword', type: 'weapon', weight: 6, melee: true, builtin: true, damage: 90, rate: 1.1, range: 2.9, arc: 2.3, pellets: 1, spread: 0, pierce: 0, color: '#f4a261' },
  { id: 'vest', name: 'Light Vest', type: 'armor', builtin: true, amount: 40, color: '#4cc9f0' },
  { id: 'plate', name: 'Heavy Armor', type: 'armor', builtin: true, amount: 80, color: '#9d4edd' },
  { id: 'grenade', name: 'Grenade', type: 'grenade', builtin: true, damage: 85, radius: 3.4, amount: 1, color: '#7cb518' },
  { id: 'ammo', name: 'Ammo Pack', type: 'ammo', builtin: true, amount: 40, color: '#ffd23f' },
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makeGrid = (w, h) => Array.from({ length: h }, () => new Array(w).fill('.'));
function fill(g, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g[y] && g[y][x] !== undefined) g[y][x] = ch;
}
function frame(g, x0, y0, x1, y1) {
  fill(g, x0, y0, x1, y0, '#'); fill(g, x0, y1, x1, y1, '#');
  fill(g, x0, y0, x0, y1, '#'); fill(g, x1, y0, x1, y1, '#');
}
const pt = (x, y, item) => (item ? { x, y, item } : { x, y });

function scatterCrates(g, rng, count, avoid) {
  const h = g.length, w = g[0].length;
  let placed = 0, tries = 0;
  while (placed < count && tries++ < 2000) {
    const x = 2 + Math.floor(rng() * (w - 4)), y = 2 + Math.floor(rng() * (h - 4));
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (g[y + dy][x + dx] !== '.') { ok = false; break; }
    if (!ok) continue;
    if (avoid.some((a) => Math.abs(a.x - x) < 4 && Math.abs(a.y - y) < 4)) continue;
    g[y][x] = 'c'; placed++;
  }
}

// Dead Town: an asymmetric "dust"-style map. T spawn bottom-left, CT spawn top, A site on a plateau (north-east) reached by ramps,
// long lane down the east side, mid with double doors, B site in the south-west with bushes, a pond and tunnels.
function buildDeadTown() {
  const w = 48, h = 48, g = makeGrid(w, h);
  frame(g, 0, 0, w - 1, h - 1);
  // --- CT spawn (top middle): a room with three exits
  frame(g, 15, 2, 28, 9); fill(g, 21, 9, 23, 9, '.'); fill(g, 15, 5, 15, 6, '.'); fill(g, 28, 5, 28, 6, '.');
  fill(g, 18, 4, 19, 4, 'c'); fill(g, 24, 7, 24, 7, 'c');
  // --- A site: plateau (north-east) with two ramps (west and south), grass behind it
  fill(g, 35, 3, 44, 10, 'H');
  fill(g, 32, 6, 34, 7, '>');            // ramp from the CT side
  fill(g, 39, 11, 40, 13, '^');          // ramp from the south ("catwalk" side)
  fill(g, 45, 3, 46, 10, 'b');           // bush strip behind the plateau
  fill(g, 31, 3, 31, 5, '#'); fill(g, 31, 8, 31, 9, '#'); // little walls around the west ramp
  fill(g, 36, 12, 37, 12, 'c'); fill(g, 42, 12, 43, 13, 'c');
  // --- hall from CT spawn east side to the catwalk and A-long
  fill(g, 29, 11, 29, 20, '#'); fill(g, 30, 14, 41, 14, '#'); fill(g, 30, 11, 33, 11, '#');
  fill(g, 34, 14, 41, 14, '.'); // (opening onto the ramp plaza)
  fill(g, 35, 15, 36, 16, 'c');
  // --- long A: a lane down the east side, sand floor, doors half way
  fill(g, 40, 17, 40, 31, '#'); fill(g, 40, 24, 40, 25, 'D');
  fill(g, 41, 15, 46, 36, 's');
  fill(g, 43, 20, 44, 21, 'c'); fill(g, 42, 30, 42, 30, 'c'); fill(g, 45, 27, 46, 28, 'w');
  fill(g, 41, 15, 46, 16, '.'); fill(g, 41, 35, 46, 36, '.');
  // --- mid: a corridor with doors at the T end and a window-door to B
  fill(g, 20, 12, 20, 32, '#'); fill(g, 27, 12, 27, 32, '#');
  fill(g, 20, 16, 20, 17, '.'); fill(g, 27, 18, 27, 19, '.'); // gaps: toward B, toward the hall
  fill(g, 21, 33, 26, 33, '#'); fill(g, 23, 33, 24, 33, 'D');
  fill(g, 22, 24, 25, 25, 'c');
  // --- B site (south-west): sand, pond, bushes, a ledge with a ramp
  fill(g, 2, 12, 17, 27, 's');
  fill(g, 16, 12, 16, 27, '#'); fill(g, 16, 18, 16, 19, 'D'); fill(g, 16, 22, 16, 23, '.');
  fill(g, 17, 12, 19, 27, '.');
  fill(g, 2, 12, 15, 12, '#'); // north wall of B
  fill(g, 3, 14, 7, 18, 'H'); fill(g, 8, 15, 10, 16, '<');
  fill(g, 10, 22, 13, 25, 'b'); fill(g, 3, 22, 4, 24, 'b');
  fill(g, 7, 21, 9, 23, 'w'); fill(g, 14, 15, 15, 16, 'c'); fill(g, 12, 19, 12, 19, 'c');
  // --- B tunnels (west): walls with a long corridor from T spawn up into B
  fill(g, 2, 28, 2, 42, '#'); fill(g, 9, 28, 9, 38, '#'); fill(g, 3, 28, 3, 28, '#'); fill(g, 8, 28, 8, 28, '#');
  fill(g, 3, 28, 8, 28, '#'); fill(g, 5, 28, 6, 28, '.');
  fill(g, 4, 31, 5, 31, 'c'); fill(g, 6, 35, 7, 35, 'c');
  fill(g, 3, 36, 4, 37, 'b');
  // --- T spawn (bottom): wide yard with cover
  fill(g, 10, 39, 10, 45, '#'); fill(g, 10, 39, 18, 39, '#'); fill(g, 13, 39, 14, 39, '.');
  fill(g, 28, 40, 28, 45, '#'); fill(g, 28, 40, 37, 40, '#'); fill(g, 32, 40, 33, 40, '.');
  fill(g, 14, 42, 15, 43, 'c'); fill(g, 22, 36, 23, 37, 'c'); fill(g, 25, 42, 26, 42, 'c');
  fill(g, 30, 44, 31, 44, 'c'); fill(g, 34, 44, 35, 45, 'b');
  // --- scattered cover
  fill(g, 12, 31, 13, 32, '#'); fill(g, 16, 30, 16, 33, '#'); fill(g, 31, 28, 33, 29, '#'); fill(g, 36, 22, 36, 24, '#');
  fill(g, 32, 33, 34, 34, 'c'); fill(g, 12, 7, 13, 9, '#'); fill(g, 5, 4, 8, 5, 'c'); fill(g, 3, 8, 3, 9, 'b');
  const playerSpawns = [
    pt(12, 42), pt(13, 43), pt(14, 41), pt(16, 44), pt(18, 42), pt(20, 43), pt(22, 41), pt(24, 44), // T
    pt(18, 6), pt(20, 7), pt(23, 6), pt(25, 5), pt(26, 7), pt(22, 3), // CT
  ];
  const zombieSpawns = [pt(2, 2), pt(45, 44), pt(11, 3), pt(33, 3), pt(3, 40), pt(44, 40), pt(45, 12), pt(31, 18)].filter((q, i) => i < 8);
  scatterCrates(g, mulberry32(11), 6, playerSpawns.concat(zombieSpawns));
  const itemSpawns = [
    pt(23, 5, 'rifle'), pt(18, 8, 'medkit'), pt(40, 5, 'sniper'), pt(38, 8, 'plate'),
    pt(5, 16, 'plate'), pt(11, 14, 'grenade'), pt(5, 33, 'shotgun'), pt(7, 40, 'random'),
    pt(24, 20, 'grenade'), pt(23, 28, 'smg'), pt(25, 14, 'gatling'), pt(43, 25, 'grenade'),
    pt(44, 18, 'random'), pt(44, 33, 'medkit'), pt(20, 41, 'vest'), pt(15, 41, 'ammo'),
    pt(33, 42, 'random'), pt(13, 24, 'random'), pt(36, 18, 'launcher'), pt(30, 34, 'bandage'),
  ];
  return { id: 'dead-town', name: 'Dead Town', w, h, tiles: g.map((r) => r.join('')), playerSpawns, zombieSpawns, itemSpawns, builtin: true };
}

function buildBunker() {
  const w = 32, h = 32, g = makeGrid(w, h);
  frame(g, 0, 0, w - 1, h - 1);
  frame(g, 5, 5, 26, 26);
  fill(g, 15, 5, 16, 5, '.'); fill(g, 15, 26, 16, 26, '.'); fill(g, 5, 15, 5, 16, '.'); fill(g, 26, 15, 26, 16, '.');
  frame(g, 11, 11, 20, 20);
  fill(g, 15, 11, 16, 11, '.'); fill(g, 15, 20, 16, 20, '.'); fill(g, 11, 15, 11, 16, '.'); fill(g, 20, 15, 20, 16, '.');
  fill(g, 1, 8, 3, 8, '#'); fill(g, 28, 23, 30, 23, '#'); fill(g, 8, 1, 8, 3, '#'); fill(g, 23, 28, 23, 30, '#');
  fill(g, 7, 7, 8, 8, '#'); fill(g, 23, 7, 24, 8, '#'); fill(g, 7, 23, 8, 24, '#'); fill(g, 23, 23, 24, 24, '#');
  const playerSpawns = [pt(14, 14), pt(17, 14), pt(14, 17), pt(17, 17), pt(15, 15), pt(16, 16), pt(15, 17), pt(16, 14)];
  const zombieSpawns = [pt(2, 2), pt(29, 2), pt(2, 29), pt(29, 29), pt(15, 2), pt(16, 29), pt(2, 15), pt(29, 16)];
  scatterCrates(g, mulberry32(21), 10, playerSpawns.concat(zombieSpawns));
  const itemSpawns = [
    pt(13, 13, 'medkit'), pt(18, 18, 'smg'), pt(13, 18, 'random'), pt(18, 13, 'random'),
    pt(3, 3, 'random'), pt(28, 28, 'random'), pt(3, 28, 'random'), pt(28, 3, 'random'),
    pt(15, 7, 'shotgun'), pt(16, 24, 'rifle'),
  ];
  return { id: 'bunker-yard', name: 'Bunker Yard', w, h, tiles: g.map((r) => r.join('')), playerSpawns, zombieSpawns, itemSpawns, builtin: true };
}

const buildDefaultMaps = () => [buildDeadTown(), buildBunker()];

// ---------- validators ----------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const validId = (s) => typeof s === 'string' && /^[a-z0-9_-]{1,32}$/.test(s);
const num = (v, lo, hi, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
const cleanName = (s, max) => String(s == null ? '' : s).replace(/[^\w \-'.!]/g, '').trim().slice(0, max);

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Bad item');
  const name = cleanName(raw.name, 20);
  if (!name) throw new Error('Item needs a name');
  const type = raw.type === 'heal' ? 'heal' : raw.type === 'ammo' ? 'ammo' : raw.type === 'armor' ? 'armor' : raw.type === 'grenade' ? 'grenade' : 'weapon';
  const id = validId(raw.id) ? raw.id : (slug(name) || 'item') + '-' + Math.random().toString(36).slice(2, 6);
  const color = /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#ffffff';
  if (type === 'grenade') return { id, name, type, damage: Math.round(num(raw.damage, 1, 500, 85)), radius: num(raw.radius, 1, 8, 3.4), amount: Math.round(num(raw.amount, 1, 4, 1)), color };
  if (type === 'armor') return { id, name, type, amount: Math.round(num(raw.amount, 1, 100, 40)), color };
  if (type === 'ammo') return { id, name, type, amount: Math.round(num(raw.amount, 1, 240, 40)), color };
  if (type === 'heal') return { id, name, type, heal: Math.round(num(raw.heal, 1, 200, 30)), color };
  const melee = !!raw.melee;
  const out = {
    id, name, type, color,
    damage: num(raw.damage, 1, 500, 20), rate: num(raw.rate, 0.2, 20, 3),
    range: num(raw.range, melee ? 1 : 3, 40, melee ? 2.2 : 14), pellets: Math.round(num(raw.pellets, 1, 16, 1)),
    spread: num(raw.spread, 0, 0.8, 0.05), pierce: Math.round(num(raw.pierce, 0, 5, 0)),
  };
  if (raw.launcher) { out.launcher = true; out.radius = num(raw.radius, 1, 8, 2.6); out.ammoCost = Math.round(num(raw.ammoCost, 1, 30, 6)); out.range = Math.min(out.range, 30); }
  if (raw.heat) { out.heat = num(raw.heat, 0.002, 0.5, 0.02); out.lock = num(raw.lock, 0.5, 8, 2.8); }
  if (raw.weight) out.weight = num(raw.weight, 0, 20, 0);
  if (raw.move) out.move = num(raw.move, 0.4, 3, 1);
  if (melee) { out.melee = true; out.arc = num(raw.arc, 0.5, 3.2, 1.8); out.range = Math.min(out.range, 4); }
  return out;
}

function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Bad map');
  const name = cleanName(raw.name, 24);
  if (!name) throw new Error('Map needs a name');
  const w = raw.w | 0, h = raw.h | 0;
  if (w < 16 || w > 64 || h < 16 || h > 64) throw new Error('Map size must be 16-64');
  if (!Array.isArray(raw.tiles) || raw.tiles.length !== h) throw new Error('Bad tiles');
  const tiles = raw.tiles.map((row) => {
    if (typeof row !== 'string' || row.length !== w) throw new Error('Bad tile row');
    return row.replace(/[^.#cH^v<>Dbws]/g, '.');
  });
  for (let y = 0; y < h; y++) {
    if (y === 0 || y === h - 1) tiles[y] = '#'.repeat(w);
    else tiles[y] = '#' + tiles[y].slice(1, w - 1) + '#';
  }
  const open = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x > 0 && p.y > 0 && p.x < w - 1 && p.y < h - 1 && '.Hs'.includes(tiles[p.y][p.x]);
  const uniq = (arr, max, withItem) => {
    const seen = new Set(), out = [];
    for (const p of Array.isArray(arr) ? arr : []) {
      if (!open(p)) continue;
      const k = p.x + ',' + p.y;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(withItem ? { x: p.x, y: p.y, item: String(p.item || 'random').slice(0, 32) } : { x: p.x, y: p.y });
      if (out.length >= max) break;
    }
    return out;
  };
  const playerSpawns = uniq(raw.playerSpawns, 16), zombieSpawns = uniq(raw.zombieSpawns, 64), itemSpawns = uniq(raw.itemSpawns, 100, true);
  if (!playerSpawns.length) throw new Error('Place at least one player spawn');
  if (!zombieSpawns.length) throw new Error('Place at least one zombie spawn');
  const id = validId(raw.id) ? raw.id : (slug(name) || 'map') + '-' + Math.random().toString(36).slice(2, 6);
  return { id, name, w, h, tiles, playerSpawns, zombieSpawns, itemSpawns };
}

module.exports = { DEFAULT_ITEMS, buildDefaultMaps, sanitizeMap, sanitizeItem, cleanName };
