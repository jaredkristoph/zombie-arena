// Extra tiles: 'D' door (E toggles), 'b' bush (hides you from players outside bushes), 'w' water (can't walk, can shoot over), 's' sand (looks only).
// Terrain: 'H' = high ground (1 unit up), '^' 'v' '<' '>' = ramps that climb toward -y / +y / -x / +x.
// A run of the same ramp character is one slope (so a 3-tile ramp rises 1/3 per tile).
// Keep the maths identical to makeGrid/heightAt in client/util.js.
const RAMP_DIR = { '^': [0, -1], v: [0, 1], '<': [-1, 0], '>': [1, 0] };
const STEP_MAX = 0.45; // the most height you can GAIN in one move: ramps are fine, cliffs are not (drops are always allowed)

function buildTerrain(tiles, W, H) {
  const kind = new Uint8Array(W * H), lo = new Float32Array(W * H), hi = new Float32Array(W * H), solid = new Uint8Array(W * H);
  const sight = new Uint8Array(W * H), bush = new Uint16Array(W * H), doors = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '#' : tiles[y][x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = tiles[y][x], i = y * W + x;
    // solid = blocks walking ('w' water too); sight = blocks bullets/line of sight; 'D' doors are handled by the room (closed = both)
    solid[i] = c === '#' || c === 'c' || c === 'w' ? 1 : 0;
    sight[i] = c === '#' || c === 'c' ? 1 : 0;
    if (c === 'b') bush[i] = 1; // (relabelled below: one id per connected patch of bushes)
    if (c === 'D') doors.push(i);
    if (c === 'H') { kind[i] = 1; lo[i] = hi[i] = 1; continue; }
    const d = RAMP_DIR[c];
    if (!d) continue;
    let a = 0, b = 0;
    while (at(x - d[0] * (a + 1), y - d[1] * (a + 1)) === c) a++;
    while (at(x + d[0] * (b + 1), y + d[1] * (b + 1)) === c) b++;
    const L = a + b + 1;
    kind[i] = 2 + '^v<>'.indexOf(c); lo[i] = a / L; hi[i] = (a + 1) / L;
  }
  // each connected patch of bushes (diagonals count) gets its own id: you only see into the patch you are standing in
  let next = 0;
  for (let i = 0; i < W * H; i++) {
    if (bush[i] !== 1) continue;
    next++; bush[i] = next + 1; // (ids start at 2 so unlabelled tiles stay distinguishable from 1)
    const stack = [i];
    while (stack.length) {
      const c = stack.pop(), cx = c % W, cy = (c / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (bush[n] === 1) { bush[n] = next + 1; stack.push(n); }
      }
    }
  }
  const heightAt = (x, y) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return 0;
    const i = ty * W + tx, k = kind[i];
    if (k === 0) return 0;
    if (k === 1) return 1;
    const fx = x - tx, fy = y - ty;
    const t = k === 2 ? 1 - fy : k === 3 ? fy : k === 4 ? 1 - fx : fx;
    return lo[i] + (hi[i] - lo[i]) * t;
  };
  return { solid, sight, bush, doors, heightAt };
}
// climbing a cliff is blocked, but stepping off an edge (any drop) is allowed: you fall
const canStep = (heightAt, ox, oy, nx, ny) => heightAt(nx, ny) - heightAt(ox, oy) <= STEP_MAX;

module.exports = { buildTerrain, canStep, STEP_MAX, RAMP_DIR };
