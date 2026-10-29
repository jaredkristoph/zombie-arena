// Shared helpers: math, tile collision (mirrors the server), tiny synthesized sound effects.

export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, f) => a + (b - a) * f;
export function lerpAngle(a, b, f) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

export const PLAYER_R = 0.38;
export const PLAYER_SPEED = 5.2;
// dash (keep in sync with server/game.js)
export const STAM_MAX = 100, DASH_TIME = 0.55, DASH_MULT = 2.4, KILL_BOOST = 1.2, DASH_CD = 3;

export function makeGrid(map) {
  const g = { w: map.w, h: map.h, solid: new Uint8Array(map.w * map.h) };
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) g.solid[y * map.w + x] = map.tiles[y][x] === '.' ? 0 : 1;
  return g;
}
const isSolid = (g, tx, ty) => tx < 0 || ty < 0 || tx >= g.w || ty >= g.h || g.solid[ty * g.w + tx] === 1;
export function blocked(g, x, y, r) {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!isSolid(g, tx, ty)) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1)), cy = Math.max(ty, Math.min(y, ty + 1));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}
export function moveCircle(g, e, dx, dy, r) {
  let nx = e.x + dx;
  if (blocked(g, nx, e.y, r)) nx = e.x;
  let ny = e.y + dy;
  if (blocked(g, nx, ny, r)) ny = e.y;
  e.x = nx; e.y = ny;
}

// ---------- sound ----------
let actx = null;
let muted = false;
let master = 0.8;
export function unlockAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
}
export function setVolume(v) { master = clamp(v, 0, 1); }
export function setMuted(m) { muted = !!m; }
export function toggleMute() { muted = !muted; return muted; }
function tone(f0, f1, dur, type, vol) {
  if (!actx || muted) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol * master, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, freq) {
  if (!actx || muted) return;
  const t = actx.currentTime, n = Math.floor(actx.sampleRate * dur);
  const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  s.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = vol * master;
  s.connect(f); f.connect(g); g.connect(actx.destination); s.start(t);
}
export function sfx(kind, vol = 1) {
  if (!actx || muted || vol <= 0.02) return;
  switch (kind) {
    case 'shoot': noise(0.09, 0.22 * vol, 2600); tone(320, 90, 0.08, 'square', 0.08 * vol); break;
    case 'hit': tone(180, 70, 0.07, 'sawtooth', 0.06 * vol); break;
    case 'kill': tone(140, 40, 0.18, 'sawtooth', 0.1 * vol); noise(0.12, 0.12 * vol, 900); break;
    case 'hurt': tone(220, 80, 0.22, 'triangle', 0.2 * vol); break;
    case 'death': tone(300, 40, 0.7, 'sawtooth', 0.18 * vol); break;
    case 'pick': tone(500, 900, 0.1, 'triangle', 0.12 * vol); break;
    case 'heal': tone(520, 1040, 0.25, 'sine', 0.16 * vol); break;
    case 'dash': noise(0.18, 0.18 * vol); tone(500, 200, 0.15, 'triangle', 0.1 * vol); break;
    case 'revive': tone(400, 1200, 0.45, 'sine', 0.2 * vol); tone(600, 1500, 0.5, 'triangle', 0.1 * vol); break;
    case 'wave': tone(110, 80, 0.6, 'sawtooth', 0.14 * vol); break;
    case 'empty': tone(160, 110, 0.05, 'square', 0.07 * vol); break;
    case 'chat': tone(900, 1200, 0.05, 'square', 0.04 * vol); break;
    default:
  }
}
