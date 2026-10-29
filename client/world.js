// Three.js scene: map, characters, items, graves, effects. Everything is built from one shared box geometry.
import * as THREE from 'three';
import { lerpAngle } from './util.js';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const SHADOW_GEO = new THREE.CircleGeometry(0.5, 16).rotateX(-Math.PI / 2);
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
const matCache = new Map();
const mat = (c) => { let m = matCache.get(c); if (!m) { m = new THREE.MeshLambertMaterial({ color: c }); matCache.set(c, m); } return m; };
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(BOX, mat(color));
  m.scale.set(w, h, d); m.position.set(x, y, z);
  return m;
}
function shadow(r) {
  const s = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT);
  s.scale.set(r * 2, 1, r * 2); s.position.y = 0.02;
  return s;
}
function darken(hex, f) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return '#' + c.getHexString();
}

let renderer, scene, camera, worldGroup, entGroup, particles, W = 1, H = 1;
const players = new Map(), zombies = new Map(), groundViews = new Map(), graveViews = new Map();
const tracers = [];
const cam = { x: 0, y: 0, shake: 0 };
const P = { n: 260, i: 0, pos: null, vel: null, life: null, max: null, size: null };
const dummy = new THREE.Object3D();
const projV = new THREE.Vector3();

export function init(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1538);
  scene.fog = new THREE.Fog(0x1a1538, 24, 52);
  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a2f5c, 1.05));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.15);
  sun.position.set(-6, 14, 5);
  scene.add(sun);
  entGroup = new THREE.Group();
  scene.add(entGroup);
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    m.visible = false; m.frustumCulled = false;
    scene.add(m);
    tracers.push({ mesh: m, life: 0 });
  }
  particles = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial({ color: 0xffffff }), P.n);
  particles.frustumCulled = false;
  P.pos = new Float32Array(P.n * 3); P.vel = new Float32Array(P.n * 3);
  P.life = new Float32Array(P.n); P.max = new Float32Array(P.n); P.size = new Float32Array(P.n);
  dummy.scale.set(0, 0, 0); dummy.updateMatrix();
  for (let i = 0; i < P.n; i++) { particles.setMatrixAt(i, dummy.matrix); particles.setColorAt(i, new THREE.Color(0xffffff)); }
  scene.add(particles);
  resize();
  window.addEventListener('resize', resize);
}
export function resize() {
  if (!renderer) return;
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  // keep the playfield readable on tall/narrow screens
  camera.fov = W / H < 1 ? 62 : 46;
  camera.updateProjectionMatrix();
}

// ---------- map ----------
function floorTexture(w, h) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const cols = ['#5c7a4a', '#527044', '#557347', '#5f7e4d'];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { g.fillStyle = cols[(i + j * 2) % 4]; g.fillRect(i * 64, j * 64, 64, 64); }
  for (let k = 0; k < 90; k++) { g.fillStyle = Math.random() < 0.5 ? '#6f9159' : '#486239'; g.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 3, 2); }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 2, h / 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function buildMap(map) {
  clearMap();
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h), new THREE.MeshLambertMaterial({ map: floorTexture(map.w, map.h) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w / 2, 0, map.h / 2);
  worldGroup.add(floor);
  const walls = [], crates = [];
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    const c = map.tiles[y][x];
    if (c === '#') walls.push([x, y]); else if (c === 'c') crates.push([x, y]);
  }
  const wallCols = ['#8b7aa8', '#7d6c9a', '#9484b0'];
  const wm = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, walls.length));
  const cap = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, walls.length));
  walls.forEach(([x, y], i) => {
    dummy.position.set(x + 0.5, 0.85, y + 0.5); dummy.scale.set(1, 1.7, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    wm.setMatrixAt(i, dummy.matrix); wm.setColorAt(i, new THREE.Color(wallCols[(x * 7 + y * 13) % 3]));
    dummy.position.y = 1.77; dummy.scale.set(1.05, 0.16, 1.05); dummy.updateMatrix();
    cap.setMatrixAt(i, dummy.matrix); cap.setColorAt(i, new THREE.Color('#d6c9f0'));
  });
  wm.count = cap.count = walls.length;
  worldGroup.add(wm, cap);
  const cm = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, crates.length));
  const lid = new THREE.InstancedMesh(BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, crates.length));
  crates.forEach(([x, y], i) => {
    const rot = ((x * 31 + y * 17) % 7) * 0.12 - 0.3;
    dummy.position.set(x + 0.5, 0.43, y + 0.5); dummy.scale.set(0.86, 0.86, 0.86); dummy.rotation.set(0, rot, 0); dummy.updateMatrix();
    cm.setMatrixAt(i, dummy.matrix); cm.setColorAt(i, new THREE.Color('#b9854a'));
    dummy.position.y = 0.9; dummy.scale.set(0.94, 0.1, 0.94); dummy.updateMatrix();
    lid.setMatrixAt(i, dummy.matrix); lid.setColorAt(i, new THREE.Color('#e0aa6a'));
  });
  cm.count = lid.count = crates.length;
  worldGroup.add(cm, lid);
  const ringGeo = new THREE.RingGeometry(0.55, 0.9, 24).rotateX(-Math.PI / 2);
  for (const s of map.zombieSpawns) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xc0203a, transparent: true, opacity: 0.55 }));
    m.position.set(s.x + 0.5, 0.03, s.y + 0.5);
    worldGroup.add(m);
  }
  for (const s of map.playerSpawns) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.3 }));
    m.position.set(s.x + 0.5, 0.03, s.y + 0.5);
    m.scale.set(0.6, 1, 0.6);
    worldGroup.add(m);
  }
}
function clearMap() {
  if (!worldGroup) return;
  worldGroup.traverse((o) => { if (o.geometry && o.geometry !== BOX) o.geometry.dispose(); if (o.material && o.material.map) o.material.map.dispose(); });
  scene.remove(worldGroup);
  worldGroup = null;
}

// ---------- characters ----------
export function ensurePlayer(id, color) {
  let v = players.get(id);
  if (v) return v;
  const root = new THREE.Group(), model = new THREE.Group();
  root.add(shadow(0.5), model);
  const skin = '#ffd9b3';
  const legL = box(0.2, 0.42, 0.22, '#2b2b44', -0.14, 0.21, 0), legR = box(0.2, 0.42, 0.22, '#2b2b44', 0.14, 0.21, 0);
  const gun = box(0.1, 0.14, 0.62, '#444444', 0.3, 0.86, 0.66);
  model.add(
    legL, legR, box(0.56, 0.7, 0.4, color, 0, 0.74, 0), box(0.44, 0.44, 0.44, skin, 0, 1.3, 0),
    box(0.48, 0.14, 0.48, darken(color, 0.6), 0, 1.57, 0), box(0.15, 0.15, 0.5, skin, 0.3, 0.86, 0.3), gun,
    box(0.06, 0.06, 0.04, '#222222', -0.1, 1.32, 0.23), box(0.06, 0.06, 0.04, '#222222', 0.1, 1.32, 0.23),
  );
  entGroup.add(root);
  v = { root, model, legL, legR, gun, gunColor: '', phase: 0 };
  players.set(id, v);
  return v;
}
export function updatePlayer(v, x, y, a, dead, gunColor, dt, moving) {
  v.root.position.set(x, 0, y);
  v.model.rotation.y = Math.PI / 2 - a;
  v.model.visible = !dead;
  if (gunColor !== v.gunColor) { v.gunColor = gunColor; v.gun.material = mat(gunColor); }
  if (moving) v.phase += dt * 14;
  const s = moving ? Math.sin(v.phase) : 0;
  v.legL.rotation.x = s * 0.8; v.legR.rotation.x = -s * 0.8;
  v.model.position.y = moving ? Math.abs(s) * 0.07 : 0;
}
export function removePlayer(id) { removeView(players, id); }

const ZCFG = [
  { sc: 1, head: '#9bd16a', shirts: ['#7b5ea7', '#c0392b', '#2c7da0', '#b08968'] },
  { sc: 0.88, head: '#d4e857', shirts: ['#e67e22', '#f1c40f', '#e84393'] },
  { sc: 1.6, head: '#79a35a', shirts: ['#5c3b2e', '#3d3d5c'] },
];
export function ensureZombie(id, type) {
  let v = zombies.get(id);
  if (v) return v;
  const cfg = ZCFG[type] || ZCFG[0];
  const shirt = cfg.shirts[id % cfg.shirts.length];
  const root = new THREE.Group(), model = new THREE.Group(), inner = new THREE.Group();
  inner.scale.setScalar(cfg.sc);
  model.add(inner);
  root.add(shadow(0.5 * cfg.sc), model);
  const armL = box(0.17, 0.17, 0.62, cfg.head, -0.36, 0.98, 0.36), armR = box(0.17, 0.17, 0.62, cfg.head, 0.36, 0.98, 0.36);
  inner.add(
    box(0.2, 0.46, 0.22, '#3a3a52', -0.15, 0.23, 0), box(0.2, 0.46, 0.22, '#3a3a52', 0.15, 0.23, 0),
    box(0.6, 0.72, 0.4, shirt, 0, 0.8, 0), box(0.48, 0.46, 0.46, cfg.head, 0, 1.4, 0),
    box(0.1, 0.1, 0.05, '#ff2a2a', -0.12, 1.45, 0.24), box(0.1, 0.1, 0.05, '#ff2a2a', 0.12, 1.45, 0.24),
    box(0.22, 0.06, 0.05, '#2a0a0a', 0, 1.28, 0.24), armL, armR,
  );
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0x000000 })), fill = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xff4d6d }));
  bg.scale.set(1.0, 0.13, 0.01); fill.scale.set(0.94, 0.08, 0.01); fill.position.z = 0.01;
  bar.add(bg, fill);
  bar.position.y = 2.0 * cfg.sc + 0.2;
  bar.visible = false;
  root.add(bar);
  entGroup.add(root);
  v = { root, model, inner, armL, armR, bar, fill, sc: cfg.sc, phase: Math.random() * 6, ang: 0, px: null, py: 0, hp: 100, pop: 0, type };
  zombies.set(id, v);
  return v;
}
export function updateZombie(v, x, y, hpPct, dt) {
  if (v.px === null) { v.px = x; v.py = y; }
  const dx = x - v.px, dy = y - v.py;
  const moved = Math.hypot(dx, dy);
  if (moved > 0.003) { v.ang = lerpAngle(v.ang, Math.atan2(dy, dx), Math.min(1, dt * 12)); v.phase += dt * (6 + moved / Math.max(dt, 0.001) * 2.2); }
  v.px = x; v.py = y;
  v.root.position.set(x, 0, y);
  v.model.rotation.y = Math.PI / 2 - v.ang;
  v.model.rotation.z = Math.sin(v.phase) * 0.09;
  v.armL.position.y = 0.98 + Math.sin(v.phase) * 0.07; v.armR.position.y = 0.98 - Math.sin(v.phase) * 0.07;
  if (hpPct < v.hp) v.pop = 1;
  v.hp = hpPct;
  v.pop = Math.max(0, v.pop - dt * 6);
  v.model.scale.setScalar(1 + v.pop * 0.18);
  v.bar.visible = hpPct < 100;
  if (v.bar.visible) { v.fill.scale.x = 0.94 * (hpPct / 100); v.fill.position.x = -0.47 * (1 - hpPct / 100); v.bar.quaternion.copy(camera.quaternion); }
}
export function removeZombie(id) { removeView(zombies, id); }

function removeView(map, id) {
  const v = map.get(id);
  if (!v) return;
  entGroup.remove(v.root);
  map.delete(id);
}
export function syncIds(kind, liveIds) {
  const map = kind === 'p' ? players : zombies;
  for (const id of [...map.keys()]) if (!liveIds.has(id)) removeView(map, id);
}

// ---------- ground items & graves ----------
function itemMesh(def) {
  const g = new THREE.Group();
  const color = def ? def.color : '#ffffff';
  if (def && def.type === 'heal') {
    g.add(box(0.46, 0.34, 0.46, '#ffffff', 0, 0.45, 0), box(0.32, 0.06, 0.1, '#e63946', 0, 0.64, 0), box(0.1, 0.06, 0.32, '#e63946', 0, 0.64, 0));
  } else {
    g.add(box(0.8, 0.14, 0.2, color, 0, 0.5, 0), box(0.2, 0.3, 0.17, darken(color, 0.65), -0.22, 0.34, 0), box(0.3, 0.1, 0.12, '#303030', 0.28, 0.5, 0));
  }
  return g;
}
export function setGround(list, items) {
  const live = new Set();
  for (const [id, x, y, item] of list) {
    live.add(id);
    if (groundViews.has(id)) continue;
    const def = items[item];
    const root = new THREE.Group();
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: def ? def.color : '#ffffff', transparent: true, opacity: 0.38, depthWrite: false }));
    glow.position.y = 0.03;
    const body = itemMesh(def);
    root.add(glow, body);
    root.position.set(x, 0, y);
    entGroup.add(root);
    groundViews.set(id, { root, body, glow, t: Math.random() * 6 });
  }
  for (const id of [...groundViews.keys()]) if (!live.has(id)) {
    const v = groundViews.get(id);
    v.glow.geometry.dispose();
    removeView(groundViews, id);
  }
}
const arcGeo = (frac, r0, r1) => new THREE.RingGeometry(r0, r1, 48, 1, 0, Math.max(0.001, frac * Math.PI * 2)).rotateX(-Math.PI / 2);
export function setGraves(list, reviveSeconds, graveR) {
  const live = new Set();
  for (const [pid, x, y, prog] of list) {
    live.add(pid);
    let v = graveViews.get(pid);
    if (!v) {
      const root = new THREE.Group();
      root.add(
        box(0.95, 0.12, 1.4, '#6b4a2f', 0, 0.06, 0.1), box(0.8, 0.95, 0.22, '#9a9ab0', 0, 0.55, -0.35),
        box(0.56, 0.2, 0.22, '#9a9ab0', 0, 1.12, -0.35), box(0.12, 0.5, 0.06, '#d9d9ea', 0, 0.62, -0.22), box(0.4, 0.12, 0.06, '#d9d9ea', 0, 0.78, -0.22),
      );
      const outline = new THREE.Mesh(new THREE.RingGeometry(graveR - 0.07, graveR, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5, depthWrite: false }));
      outline.position.y = 0.04;
      const arc = new THREE.Mesh(arcGeo(0, graveR - 0.4, graveR - 0.1), new THREE.MeshBasicMaterial({ color: 0x9be564, side: THREE.DoubleSide, depthWrite: false }));
      arc.position.y = 0.05;
      root.add(outline, arc);
      root.position.set(x, 0, y);
      entGroup.add(root);
      v = { root, arc, outline, q: -1 };
      graveViews.set(pid, v);
    }
    const q = Math.round((prog / reviveSeconds) * 100);
    if (q !== v.q) { v.q = q; v.arc.geometry.dispose(); v.arc.geometry = arcGeo(prog / reviveSeconds, graveR - 0.4, graveR - 0.1); }
  }
  for (const id of [...graveViews.keys()]) if (!live.has(id)) {
    const v = graveViews.get(id);
    v.arc.geometry.dispose(); v.outline.geometry.dispose();
    removeView(graveViews, id);
  }
}

export function clearEntities() {
  for (const m of [players, zombies, groundViews, graveViews]) for (const id of [...m.keys()]) removeView(m, id);
  for (const t of tracers) { t.life = 0; t.mesh.visible = false; }
  for (let i = 0; i < P.n; i++) P.life[i] = 0;
}
export function clearAll() { clearEntities(); clearMap(); }

// ---------- effects ----------
export function tracer(x1, y1, x2, y2, color) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 0.05) return;
  let t = tracers.find((q) => q.life <= 0) || tracers[0];
  t.life = 0.07;
  t.mesh.visible = true;
  t.mesh.position.set((x1 + x2) / 2, 0.86, (y1 + y2) / 2);
  t.mesh.scale.set(len, 0.07, 0.07);
  t.mesh.rotation.set(0, -Math.atan2(dy, dx), 0);
  t.mesh.material.color.set(color);
  t.mesh.material.opacity = 1;
}
export function burst(x, y, z, color, count, speed, size, life) {
  const c = new THREE.Color(color);
  for (let k = 0; k < count; k++) {
    const i = P.i; P.i = (P.i + 1) % P.n;
    const a = Math.random() * Math.PI * 2, s = speed * (0.35 + Math.random() * 0.65);
    P.pos[i * 3] = x; P.pos[i * 3 + 1] = z; P.pos[i * 3 + 2] = y;
    P.vel[i * 3] = Math.cos(a) * s; P.vel[i * 3 + 1] = 2 + Math.random() * speed * 0.8; P.vel[i * 3 + 2] = Math.sin(a) * s;
    P.life[i] = P.max[i] = life * (0.6 + Math.random() * 0.6);
    P.size[i] = size * (0.6 + Math.random() * 0.8);
    particles.setColorAt(i, c);
  }
  particles.instanceColor.needsUpdate = true;
}
export function shake(a) { cam.shake = Math.max(cam.shake, a); }

// ---------- camera / frame ----------
export function snapCamera(x, y) { cam.x = x; cam.y = y; }
export function followCamera(x, y, dt) {
  const f = Math.min(1, dt * 9);
  cam.x += (x - cam.x) * f; cam.y += (y - cam.y) * f;
  const sx = (Math.random() - 0.5) * cam.shake, sz = (Math.random() - 0.5) * cam.shake;
  cam.shake = Math.max(0, cam.shake - dt * 2.4);
  camera.position.set(cam.x + sx, 15.5, cam.y + 10 + sz);
  camera.lookAt(cam.x + sx * 0.5, 0, cam.y - 0.5);
}
export function project(x, y, h) {
  projV.set(x, h, y).project(camera);
  return { x: (projV.x * 0.5 + 0.5) * W, y: (-projV.y * 0.5 + 0.5) * H, ok: projV.z < 1 && projV.z > -1 };
}
export function draw(dt, time) {
  for (const t of tracers) {
    if (t.life <= 0) continue;
    t.life -= dt;
    if (t.life <= 0) t.mesh.visible = false; else t.mesh.material.opacity = Math.min(1, t.life / 0.05);
  }
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) continue;
    P.life[i] -= dt;
    const b = i * 3;
    P.vel[b + 1] -= 16 * dt;
    P.pos[b] += P.vel[b] * dt; P.pos[b + 1] += P.vel[b + 1] * dt; P.pos[b + 2] += P.vel[b + 2] * dt;
    if (P.pos[b + 1] < 0.05) { P.pos[b + 1] = 0.05; P.vel[b + 1] = 0; P.vel[b] *= 0.6; P.vel[b + 2] *= 0.6; }
    const s = P.life[i] > 0 ? P.size[i] * (P.life[i] / P.max[i]) : 0;
    dummy.position.set(P.pos[b], P.pos[b + 1], P.pos[b + 2]); dummy.scale.set(s, s, s); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  for (const v of groundViews.values()) {
    v.t += dt;
    v.body.position.y = 0.12 + Math.sin(v.t * 3) * 0.08;
    v.body.rotation.y = v.t * 1.4;
    v.glow.material.opacity = 0.3 + Math.sin(v.t * 4) * 0.1;
  }
  for (const v of graveViews.values()) v.outline.material.opacity = 0.35 + Math.sin(time * 4) * 0.15;
  renderer.render(scene, camera);
}
