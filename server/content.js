'use strict';
// Default items + maps and validators for admin-supplied content.

const DEFAULT_ITEMS = [
  { id: 'pistol', name: 'Pistol', type: 'weapon', builtin: true, damage: 20, rate: 3.5, range: 14, pellets: 1, spread: 0.03, pierce: 0, color: '#ffd166' },
  { id: 'smg', name: 'SMG', type: 'weapon', builtin: true, damage: 11, rate: 11, range: 12, pellets: 1, spread: 0.09, pierce: 0, color: '#06d6a0' },
  { id: 'shotgun', name: 'Shotgun', type: 'weapon', builtin: true, damage: 11, rate: 1.3, range: 8, pellets: 7, spread: 0.3, pierce: 0, color: '#ef476f' },
  { id: 'rifle', name: 'Rifle', type: 'weapon', builtin: true, damage: 34, rate: 4.5, range: 18, pellets: 1, spread: 0.015, pierce: 1, color: '#118ab2' },
  { id: 'sniper', name: 'Sniper', type: 'weapon', builtin: true, damage: 130, rate: 0.8, range: 32, pellets: 1, spread: 0, pierce: 3, color: '#9b5de5' },
  { id: 'bandage', name: 'Bandage', type: 'heal', builtin: true, heal: 25, color: '#f1f1f1' },
  { id: 'medkit', name: 'Medkit', type: 'heal', builtin: true, heal: 60, color: '#ff4d4d' },
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

function buildDeadTown() {
  const w = 40, h = 40, g = makeGrid(w, h);
  frame(g, 0, 0, w - 1, h - 1);
  frame(g, 6, 6, 15, 13); fill(g, 10, 13, 11, 13, '.'); fill(g, 15, 9, 15, 10, '.');
  frame(g, 24, 6, 33, 13); fill(g, 28, 13, 29, 13, '.'); fill(g, 24, 9, 24, 10, '.');
  frame(g, 6, 26, 15, 33); fill(g, 10, 26, 11, 26, '.'); fill(g, 15, 29, 15, 30, '.');
  frame(g, 24, 26, 33, 33); fill(g, 28, 26, 29, 26, '.'); fill(g, 24, 29, 24, 30, '.');
  fill(g, 17, 17, 17, 17, '#'); fill(g, 22, 17, 22, 17, '#'); fill(g, 17, 22, 17, 22, '#'); fill(g, 22, 22, 22, 22, '#');
  const playerSpawns = [pt(19, 19), pt(20, 19), pt(19, 20), pt(20, 20), pt(18, 19), pt(21, 20), pt(18, 20), pt(21, 19)];
  const zombieSpawns = [pt(2, 2), pt(37, 2), pt(2, 37), pt(37, 37), pt(19, 2), pt(20, 37), pt(2, 20), pt(37, 20)];
  scatterCrates(g, mulberry32(7), 26, playerSpawns.concat(zombieSpawns));
  const itemSpawns = [
    pt(9, 8, 'shotgun'), pt(30, 9, 'smg'), pt(9, 30, 'medkit'), pt(30, 30, 'rifle'),
    pt(12, 10, 'random'), pt(26, 11, 'random'), pt(8, 29, 'random'), pt(31, 29, 'random'),
    pt(19, 15, 'random'), pt(20, 24, 'random'), pt(15, 20, 'random'), pt(24, 19, 'random'),
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
  const type = raw.type === 'heal' ? 'heal' : raw.type === 'ammo' ? 'ammo' : 'weapon';
  const id = validId(raw.id) ? raw.id : (slug(name) || 'item') + '-' + Math.random().toString(36).slice(2, 6);
  const color = /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#ffffff';
  if (type === 'ammo') return { id, name, type, amount: Math.round(num(raw.amount, 1, 240, 40)), color };
  if (type === 'heal') return { id, name, type, heal: Math.round(num(raw.heal, 1, 200, 30)), color };
  return {
    id, name, type, color,
    damage: num(raw.damage, 1, 500, 20), rate: num(raw.rate, 0.2, 20, 3),
    range: num(raw.range, 3, 40, 14), pellets: Math.round(num(raw.pellets, 1, 16, 1)),
    spread: num(raw.spread, 0, 0.8, 0.05), pierce: Math.round(num(raw.pierce, 0, 5, 0)),
  };
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
    return row.replace(/[^.#c]/g, '.');
  });
  for (let y = 0; y < h; y++) {
    if (y === 0 || y === h - 1) tiles[y] = '#'.repeat(w);
    else tiles[y] = '#' + tiles[y].slice(1, w - 1) + '#';
  }
  const open = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x > 0 && p.y > 0 && p.x < w - 1 && p.y < h - 1 && tiles[p.y][p.x] === '.';
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
