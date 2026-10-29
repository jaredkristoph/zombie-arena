// Three.js scene: map, characters, items, graves, effects. Everything is built from one shared box geometry.
import * as THREE from 'three';
import { lerpAngle } from './util.js';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const RING_GEO = new THREE.RingGeometry(0.42, 0.56, 24).rotateX(-Math.PI / 2);
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
const tracers = [], slashes = [];
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
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.5, 1, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
    m.visible = false; m.frustumCulled = false;
    scene.add(m);
    slashes.push({ mesh: m, life: 0 });
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
// Head accessories. Keep ACC_NAMES in the same order/length as ACC_COUNT in server/game.js.
export const ACC_NAMES = ['None', 'Cap', 'Cowboy Hat', 'Top Hat', 'Crown', 'Headband', 'Bunny Ears', 'Devil Horns', 'Halo', 'Army Helmet', 'Mohawk', 'Antenna', 'Pirate Hat', 'Wizard Hat', 'Beanie', 'Chef Hat', 'Viking Helmet', 'Cat Ears', 'Sombrero', 'Police Cap', 'Flower Crown', 'Jester Hat', 'Headphones', 'Unicorn', 'Pumpkin'];
function accessoryParts(i, color) {
  const b = box;
  switch (i) {
    case 1: return [b(0.52, 0.16, 0.52, color, 0, 1.68, 0), b(0.5, 0.04, 0.24, darken(color, 0.75), 0, 1.62, 0.36)];
    case 2: return [b(0.95, 0.05, 0.95, '#8b5a2b', 0, 1.66, 0), b(0.5, 0.24, 0.5, '#a0693a', 0, 1.79, 0), b(0.52, 0.06, 0.52, '#4a2c12', 0, 1.71, 0)];
    case 3: return [b(0.72, 0.05, 0.72, '#151515', 0, 1.66, 0), b(0.44, 0.48, 0.44, '#151515', 0, 1.92, 0), b(0.46, 0.08, 0.46, '#c0392b', 0, 1.74, 0)];
    case 4: return [b(0.5, 0.1, 0.5, '#ffd23f', 0, 1.68, 0), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => b(0.1, 0.17, 0.1, '#ffd23f', x * 0.2, 1.8, z * 0.2)), b(0.09, 0.09, 0.05, '#e63946', 0, 1.69, 0.26)];
    case 5: return [b(0.5, 0.08, 0.5, '#ff4d6d', 0, 1.47, 0), b(0.1, 0.14, 0.1, '#ff4d6d', 0.27, 1.45, -0.12), b(0.1, 0.14, 0.1, '#ff4d6d', 0.27, 1.45, 0.02)];
    case 6: return [-1, 1].flatMap((x) => [b(0.13, 0.55, 0.1, '#f8f9fa', x * 0.14, 1.98, 0), b(0.06, 0.4, 0.11, '#ffb3c6', x * 0.14, 1.96, 0.01)]);
    case 7: return [-1, 1].flatMap((x) => [b(0.1, 0.22, 0.1, '#d00000', x * 0.17, 1.76, 0), b(0.07, 0.14, 0.07, '#ff4d4d', x * 0.21, 1.92, 0)]);
    case 8: return [b(0.56, 0.05, 0.07, '#ffe066', 0, 2.0, 0.25), b(0.56, 0.05, 0.07, '#ffe066', 0, 2.0, -0.25), b(0.07, 0.05, 0.56, '#ffe066', 0.25, 2.0, 0), b(0.07, 0.05, 0.56, '#ffe066', -0.25, 2.0, 0)];
    case 9: return [b(0.56, 0.22, 0.56, '#4b5d3a', 0, 1.7, 0), b(0.62, 0.05, 0.62, '#3b4a2e', 0, 1.6, 0), b(0.2, 0.08, 0.04, '#6b7f52', 0, 1.74, 0.29)];
    case 10: return [b(0.1, 0.24, 0.52, '#f72585', 0, 1.77, 0), b(0.1, 0.14, 0.3, '#ff7aa8', 0, 1.9, -0.05)];
    case 11: return [b(0.04, 0.32, 0.04, '#aaaaaa', 0, 1.82, 0), b(0.13, 0.13, 0.13, '#3ae374', 0, 2.03, 0)];
    case 12: return [b(0.74, 0.14, 0.36, '#151515', 0, 1.7, 0), b(0.48, 0.12, 0.3, '#151515', 0, 1.8, 0), b(0.1, 0.1, 0.04, '#ffffff', 0, 1.7, 0.19)];
    case 13: return [b(0.72, 0.05, 0.72, '#5b2a86', 0, 1.65, 0), b(0.46, 0.2, 0.46, '#6c34a0', 0, 1.77, 0), b(0.32, 0.2, 0.32, '#6c34a0', 0, 1.97, 0), b(0.18, 0.2, 0.18, '#7d44b5', 0, 2.17, 0), b(0.48, 0.05, 0.48, '#ffd23f', 0, 1.69, 0)];
    case 14: return [b(0.5, 0.2, 0.5, '#e63946', 0, 1.7, 0), b(0.54, 0.08, 0.54, '#b02a37', 0, 1.6, 0), b(0.13, 0.13, 0.13, '#ffffff', 0, 1.86, 0)];
    case 15: return [b(0.5, 0.1, 0.5, '#f8f9fa', 0, 1.65, 0), b(0.58, 0.32, 0.58, '#ffffff', 0, 1.86, 0)];
    case 16: return [b(0.54, 0.2, 0.54, '#9aa5b1', 0, 1.7, 0), b(0.58, 0.05, 0.58, '#6c757d', 0, 1.61, 0), ...[-1, 1].flatMap((x) => [b(0.1, 0.26, 0.1, '#f1e4c3', x * 0.31, 1.8, 0), b(0.1, 0.12, 0.1, '#f1e4c3', x * 0.37, 1.97, 0)])];
    case 17: return [-1, 1].flatMap((x) => [b(0.15, 0.22, 0.1, '#2b2b2b', x * 0.15, 1.78, 0), b(0.07, 0.13, 0.11, '#ffb3c6', x * 0.15, 1.76, 0.01)]);
    case 18: return [b(1.1, 0.05, 1.1, '#d4a017', 0, 1.65, 0), b(0.4, 0.3, 0.4, '#e0b030', 0, 1.82, 0), b(0.42, 0.06, 0.42, '#d62828', 0, 1.7, 0)];
    case 19: return [b(0.54, 0.17, 0.54, '#1d3557', 0, 1.68, 0), b(0.5, 0.04, 0.24, '#111111', 0, 1.62, 0.36), b(0.09, 0.09, 0.04, '#ffd23f', 0, 1.7, 0.28)];
    case 20: return [b(0.52, 0.05, 0.52, '#2d6a4f', 0, 1.62, 0), ...[[-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25], [-0.18, 0.18], [0.18, -0.18]].map(([x, z], k) => b(0.11, 0.11, 0.11, ['#ff70a6', '#ffd23f', '#ffffff'][k % 3], x, 1.67, z))];
    case 21: return [b(0.2, 0.32, 0.2, '#e63946', -0.18, 1.8, 0), b(0.2, 0.32, 0.2, '#3a86ff', 0.18, 1.8, 0), b(0.5, 0.06, 0.5, '#ffd23f', 0, 1.62, 0), b(0.09, 0.09, 0.09, '#ffd23f', -0.18, 2.02, 0), b(0.09, 0.09, 0.09, '#ffd23f', 0.18, 2.02, 0)];
    case 22: return [b(0.62, 0.06, 0.08, '#222222', 0, 1.67, 0), ...[-1, 1].flatMap((x) => [b(0.05, 0.34, 0.08, '#222222', x * 0.3, 1.5, 0), b(0.12, 0.24, 0.24, '#e63946', x * 0.33, 1.3, 0)])];
    case 23: return [b(0.5, 0.1, 0.5, '#f8f9fa', 0, 1.66, 0), b(0.08, 0.32, 0.08, '#ffd23f', 0, 1.9, 0.1), b(0.1, 0.22, 0.3, '#ff70a6', 0, 1.76, -0.12), b(0.1, 0.16, 0.2, '#4cc9f0', 0, 1.72, -0.28)];
    case 24: return [b(0.56, 0.34, 0.56, '#f97316', 0, 1.74, 0), b(0.09, 0.14, 0.09, '#2d6a4f', 0, 1.98, 0), b(0.1, 0.1, 0.04, '#2a1a05', -0.13, 1.76, 0.29), b(0.1, 0.1, 0.04, '#2a1a05', 0.13, 1.76, 0.29)];
    default: return [];
  }
}

// ---- outfits (shirt / pants / extras). 0 = your team colour. Keep FIT_NAMES.length == FIT_COUNT in server/game.js
export const FIT_NAMES = ['Team Colour', 'Hoodie', 'Red Jacket', 'Camo', 'Striped Tee', 'Punk', 'Lab Coat', 'Knight', 'Overalls', 'Ninja'];
function outfit(i, team) {
  const b = box;
  switch (i) {
    case 1: return { shirt: '#2d6cdf', pants: '#2b2b44', parts: [b(0.5, 0.2, 0.12, '#2556b5', 0, 1.12, -0.22), b(0.3, 0.12, 0.04, '#2556b5', 0, 0.6, 0.21)] };
    case 2: return { shirt: '#c0392b', pants: '#34495e', parts: [b(0.05, 0.7, 0.04, '#f1c40f', 0, 0.74, 0.21), b(0.5, 0.08, 0.42, '#962d22', 0, 1.1, 0)] };
    case 3: return { shirt: '#5a6b3a', pants: '#4b5d3a', parts: [b(0.16, 0.14, 0.04, '#3b4a2e', -0.15, 0.9, 0.21), b(0.12, 0.16, 0.04, '#7d8f55', 0.12, 0.6, 0.21), b(0.14, 0.1, 0.04, '#3b4a2e', 0.05, 0.8, 0.21), b(0.18, 0.14, 0.24, '#3b4a2e', -0.14, 0.2, 0.0)] };
    case 4: return { shirt: '#f8f9fa', pants: '#3a506b', parts: [0.58, 0.78, 0.96].map((y) => b(0.58, 0.07, 0.42, '#e63946', 0, y - 0.08, 0)) };
    case 5: return { shirt: '#1b1b1b', pants: '#2d2d2d', parts: [b(0.1, 0.7, 0.04, '#ffd23f', 0.12, 0.74, 0.21), b(0.58, 0.07, 0.42, '#c0392b', 0, 0.42, 0), b(0.06, 0.06, 0.06, '#cccccc', -0.2, 1.02, 0.21), b(0.06, 0.06, 0.06, '#cccccc', -0.1, 1.02, 0.21)] };
    case 6: return { shirt: '#f1f5f9', pants: '#cbd5e1', parts: [b(0.6, 0.42, 0.42, '#f1f5f9', 0, 0.3, 0), b(0.14, 0.1, 0.04, '#38bdf8', 0.15, 0.62, 0.21)] };
    case 7: return { shirt: '#8d99ae', pants: '#4a4e69', parts: [b(0.2, 0.14, 0.3, '#adb5bd', -0.35, 1.06, 0), b(0.2, 0.14, 0.3, '#adb5bd', 0.35, 1.06, 0), b(0.5, 0.42, 0.04, '#ced4da', 0, 0.82, 0.21)] };
    case 8: return { shirt: '#f4d35e', pants: '#2a6fdb', parts: [b(0.38, 0.36, 0.04, '#2a6fdb', 0, 0.62, 0.21), b(0.07, 0.42, 0.04, '#2a6fdb', -0.14, 0.95, 0.21), b(0.07, 0.42, 0.04, '#2a6fdb', 0.14, 0.95, 0.21)] };
    case 9: return { shirt: '#15151f', pants: '#15151f', parts: [b(0.5, 0.1, 0.46, '#e63946', 0, 1.1, 0), b(0.1, 0.32, 0.06, '#e63946', 0.2, 0.9, -0.22), b(0.46, 0.2, 0.04, '#15151f', 0, 1.2, 0.23)] };
    default: return { shirt: team, pants: '#2b2b44', parts: [] };
  }
}
// builds one player model; `accGroup` holds the head accessory so it can be swapped later
function buildPlayerModel(color, acc, fit = 0) {
  const root = new THREE.Group(), model = new THREE.Group(), accGroup = new THREE.Group();
  const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })); // team-colour ring so players stay identifiable
  ring.position.y = 0.03;
  root.add(shadow(0.5), ring, model);
  const skin = '#ffd9b3';
  const o = outfit(fit, color);
  const legL = box(0.2, 0.42, 0.22, o.pants, -0.14, 0.21, 0), legR = box(0.2, 0.42, 0.22, o.pants, 0.14, 0.21, 0);
  const gun = box(0.1, 0.14, 0.62, '#444444', 0.3, 0.86, 0.66);
  model.add(
    legL, legR, box(0.56, 0.7, 0.4, o.shirt, 0, 0.74, 0), box(0.44, 0.44, 0.44, skin, 0, 1.3, 0),
    box(0.48, 0.14, 0.48, darken(color, 0.6), 0, 1.57, 0), box(0.15, 0.15, 0.5, skin, 0.3, 0.86, 0.3), gun,
    box(0.06, 0.06, 0.04, '#222222', -0.1, 1.32, 0.23), box(0.06, 0.06, 0.04, '#222222', 0.1, 1.32, 0.23), accGroup, ...o.parts,
  );
  const v = { root, model, legL, legR, gun, accGroup, gunColor: '', phase: 0, acc: -1, color, fit };
  setAccessory(v, acc, color);
  return v;
}
export function setAccessory(v, acc, color) {
  acc = ((acc | 0) % ACC_NAMES.length + ACC_NAMES.length) % ACC_NAMES.length;
  if (v.acc === acc && v.accColor === color) return;
  v.acc = acc; v.accColor = color;
  for (const c of [...v.accGroup.children]) v.accGroup.remove(c);
  for (const part of accessoryParts(acc, color)) v.accGroup.add(part);
}
export function ensurePlayer(id, color, acc = 0, fit = 0) {
  let v = players.get(id);
  if (v) return v;
  v = buildPlayerModel(color, acc, fit);
  entGroup.add(v.root);
  players.set(id, v);
  return v;
}

// A little turntable model for the menu / room lobby, drawn on its own small canvas.
export function createPreview(canvas, color, acc, fit = 0) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.setSize(canvas.width, canvas.height, false);
  const sc = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 0.1, 50);
  cam.position.set(0, 1.5, 6.4);
  cam.lookAt(0, 1.05, 0);
  sc.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a2f5c, 1.15));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.1);
  sun.position.set(-3, 6, 5);
  sc.add(sun);
  const v = buildPlayerModel(color, acc, fit);
  v.gun.material = mat('#ffd166');
  sc.add(v.root);
  let t = 0, tm = 0;
  return {
    set(c, a, f = 0) {
      if (c !== v.color || f !== v.fit) { // new colour or outfit: rebuild the model
        sc.remove(v.root);
        const nv = buildPlayerModel(c, a, f); nv.gun.material = mat('#ffd166');
        Object.assign(v, nv); sc.add(v.root);
      } else setAccessory(v, a, c);
    },
    render(dt) {
      t += dt; tm += dt;
      v.model.rotation.y = Math.sin(t * 0.9) * 0.9 + 0.35; // gentle swing so every side is visible
      v.model.position.y = Math.abs(Math.sin(tm * 2.2)) * 0.03;
      r.render(sc, cam);
    },
  };
}
// turn > 0 eases the visible facing toward `a` (exponential, shortest way round); 0 = use `a` as is
export function updatePlayer(v, x, y, a, dead, gunColor, dt, moving, turn = 0, protectedNow = false, melee = false) {
  v.root.position.set(x, 0, y);
  if (turn > 0 && v.ang !== undefined && !v.wasDead) v.ang = lerpAngle(v.ang, a, 1 - Math.exp(-dt * turn));
  else v.ang = a;
  v.wasDead = dead;
  v.blink = (v.blink || 0) + dt;
  v.model.rotation.y = Math.PI / 2 - v.ang;
  v.model.visible = !dead && (!protectedNow || Math.floor(v.blink * 9) % 2 === 0); // spawn protection: blink
  if (gunColor !== v.gunColor) { v.gunColor = gunColor; v.gun.material = mat(gunColor); }
  v.swing = Math.max(0, (v.swing || 0) - dt * 5.5);
  if (melee !== v.melee) { // swap between a gun and a sword model
    v.melee = melee;
    if (melee) v.gun.scale.set(0.07, 0.1, 1.05); else { v.gun.scale.set(0.1, 0.14, 0.62); v.gun.position.set(0.3, 0.86, 0.66); v.gun.rotation.y = 0; }
  }
  if (melee) { // blade pivots around the hand; swings across when attacking
    const th = v.swing > 0 ? (v.swing - 0.5) * 2.6 : 0.3;
    v.gun.position.set(0.3 + 0.62 * Math.sin(th), 0.9, 0.3 + 0.62 * Math.cos(th));
    v.gun.rotation.y = th;
  }
  if (moving) v.phase += dt * 14;
  const s = moving ? Math.sin(v.phase) : 0;
  v.legL.rotation.x = s * 0.8; v.legR.rotation.x = -s * 0.8;
  v.model.position.y = moving ? Math.abs(s) * 0.07 : 0;
}
export function removePlayer(id) { removeView(players, id); }
export function swingPlayer(id) { const v = players.get(id); if (v) v.swing = 1; }
// sword slash effect: a flat arc on the ground that fades quickly
export function slash(x, y, a, range, arc, color) {
  const q = slashes.find((t) => t.life <= 0) || slashes[0];
  q.mesh.geometry.dispose();
  q.mesh.geometry = new THREE.RingGeometry(range * 0.3, range, 20, 1, -arc / 2, arc).rotateX(-Math.PI / 2);
  q.mesh.position.set(x, 0.9, y);
  q.mesh.rotation.y = -a;
  q.mesh.material.color.set(color);
  q.mesh.material.opacity = 0.7;
  q.mesh.visible = true;
  q.life = 0.16;
}

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
  if (def && def.type === 'ammo') {
    g.add(box(0.56, 0.3, 0.4, '#5a4a2a', 0, 0.4, 0), box(0.6, 0.06, 0.44, '#3d3220', 0, 0.58, 0));
    for (const x of [-0.17, 0, 0.17]) g.add(box(0.1, 0.24, 0.1, color, x, 0.74, 0), box(0.1, 0.07, 0.1, '#c98a2b', x, 0.89, 0));
  } else if (def && def.type === 'armor') {
    g.add(box(0.56, 0.5, 0.3, color, 0, 0.5, 0), box(0.14, 0.2, 0.3, darken(color, 0.7), -0.2, 0.82, 0), box(0.14, 0.2, 0.3, darken(color, 0.7), 0.2, 0.82, 0), box(0.3, 0.1, 0.32, '#ffffff', 0, 0.55, 0));
  } else if (def && def.melee) {
    g.add(box(0.95, 0.05, 0.13, color, 0.08, 0.5, 0), box(0.07, 0.07, 0.34, '#8d6e3f', -0.36, 0.5, 0), box(0.24, 0.09, 0.1, '#5a3d1f', -0.52, 0.5, 0));
  } else if (def && def.type === 'heal') {
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
  for (const t of slashes) { t.life = 0; t.mesh.visible = false; }
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
// where does the screen point (px, py) hit the world at gun height? -> {x, y} in map tiles, or null
const rayCast = new THREE.Raycaster(), aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.86), ndcV = new THREE.Vector2(), hitV = new THREE.Vector3();
export function screenToGround(px, py) {
  if (!camera) return null;
  camera.updateMatrixWorld();
  ndcV.set((px / W) * 2 - 1, -(py / H) * 2 + 1);
  rayCast.setFromCamera(ndcV, camera);
  return rayCast.ray.intersectPlane(aimPlane, hitV) ? { x: hitV.x, y: hitV.z } : null;
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
  for (const q of slashes) {
    if (q.life <= 0) continue;
    q.life -= dt;
    if (q.life <= 0) q.mesh.visible = false; else q.mesh.material.opacity = Math.min(0.7, (q.life / 0.16) * 0.7);
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
