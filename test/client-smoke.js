'use strict';
// Smoke-tests the real client modules (util/world/game) in Node with a fake DOM and a stubbed Three.js,
// talking to the real server. Catches runtime errors in lobby, netcode, prediction, HUD and chat code.
// It cannot judge how the game LOOKS - open it in a browser for that.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const CLIENT = path.join(__dirname, '..', 'client');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'za-smoke-'));

// ---- three.js stub (just enough surface for world.js) ----
fs.writeFileSync(path.join(tmp, 'three-stub.mjs'), `
const vec = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, setScalar(s) { this.x = this.y = this.z = s; return this; }, copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; } });
class Obj { constructor() { this.position = vec(); this.rotation = vec(); this.scale = vec(); this.scale.set(1,1,1); this.quaternion = { copy() {} }; this.children = []; this.visible = true; }
  add(...c) { this.children.push(...c); return this; } remove(c) { this.children = this.children.filter((x) => x !== c); } updateMatrix() { this.matrix = {}; } lookAt() {}
  traverse(f) { f(this); this.children.forEach((c) => c.traverse && c.traverse(f)); } }
export class Group extends Obj {}
export class Object3D extends Obj {}
export class Scene extends Obj {}
export class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
export class InstancedMesh extends Mesh { constructor(g, m, n) { super(g, m); this.count = n; this.instanceMatrix = {}; this.instanceColor = {}; } setMatrixAt() {} setColorAt() {} }
class Geo { rotateX() { return this; } dispose() {} }
export class BoxGeometry extends Geo {} export class CircleGeometry extends Geo {} export class PlaneGeometry extends Geo {} export class RingGeometry extends Geo {}
class Mat { constructor(o = {}) { Object.assign(this, o); this.color = new Color(o.color); } }
export class MeshBasicMaterial extends Mat {} export class MeshLambertMaterial extends Mat {}
export class Color { constructor(c) { this.c = c; } set(c) { this.c = c; } multiplyScalar() { return this; } getHexString() { return '808080'; } }
export class Fog {} export class HemisphereLight extends Obj {} export class DirectionalLight extends Obj {}
export class PerspectiveCamera extends Obj { updateProjectionMatrix() {} }
export class WebGLRenderer { constructor(o) { if (!o.canvas) throw new Error('no canvas'); this.frames = 0; } setPixelRatio() {} setSize() {} render() { this.frames++; globalThis.__frames = this.frames; } }
export class Vector3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } project() { this.z = 0.5; return this; } }
export class CanvasTexture { constructor() { this.repeat = vec(); } dispose() {} }
export const RepeatWrapping = 1, SRGBColorSpace = 'srgb', DoubleSide = 2;
`);
for (const f of ['util.js', 'world.js', 'game.js']) {
  fs.writeFileSync(path.join(tmp, f.replace('.js', '.mjs')), fs.readFileSync(path.join(CLIENT, f), 'utf8').replace(/from 'three'/g, "from './three-stub.mjs'").replace(/from '\.\/(\w+)\.js'/g, "from './$1.mjs'"));
}

// ---- fake DOM ----
const html = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
class El {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase(); this.id = id; this.style = {}; this.children = []; this.value = ''; this.dataset = {};
    this._cls = new Set(); this._txt = ''; this.scrollTop = 0; this.scrollHeight = 0; this.handlers = {};
    const self = this;
    this.classList = { add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c), contains: (c) => self._cls.has(c), toggle: (c, f) => (f ? self._cls.add(c) : self._cls.delete(c)), [Symbol.iterator]: () => self._cls[Symbol.iterator]() };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this._cls].join(' '); }
  set textContent(v) { this._txt = String(v); this.children = []; } get textContent() { return this._txt + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.children = []; this._html = v; this._txt = ''; } get innerHTML() { return this._html || ''; }
  appendChild(c) { this.children.push(c); c.parent = this; if (this.tagName === 'SELECT' && !this.value) this.value = c.value; return c; }
  append(...cs) { cs.forEach((c) => (typeof c === 'string' ? this.appendChild(Object.assign(new El('span'), { _txt: c })) : this.appendChild(c))); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); } remove() { if (this.parent) this.parent.removeChild(this); }
  get firstChild() { return this.children[0]; }
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
  focus() { document.activeElement = this; } blur() { if (document.activeElement === this) document.activeElement = document.body; }
  querySelectorAll() { return []; } getContext() { return new Proxy({}, { get: () => () => {} }); } setAttribute() {}
  set value(v) { this._v = v; } get value() { return this._v === undefined ? '' : this._v; }
}
const els = new Map();
const body = new El('body', 'body');
global.document = {
  body, activeElement: body,
  getElementById(id) { if (!ids.has(id)) throw new Error('index.html has no #' + id); if (!els.has(id)) els.set(id, new El(id === 'chatinput' || id === 'name' || id.startsWith('c-') ? (id === 'c-map' || id === 'c-diff' ? 'select' : 'input') : 'div', id)); return els.get(id); },
  createElement: (t) => new El(t),
};
const winHandlers = {};
global.window = global;
global.addEventListener = (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); };
global.innerWidth = 1280; global.innerHeight = 720; global.devicePixelRatio = 1;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } };
global.location = { protocol: 'http:', host: 'x' };
global.WebSocket = WebSocket;
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; };
const fire = (type, ev) => (winHandlers[type] || []).forEach((f) => f(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); } throw new Error('timeout: ' + fn); };

(async () => {
  process.env.DATA_FILE = path.join(tmp, 'data.json');
  const { server } = require('../server/server');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  global.GAME_CONFIG = { server: 'http://127.0.0.1:' + port };
  const errors = [];
  process.on('uncaughtException', (e) => { errors.push(e); console.error('UNCAUGHT', e); });

  await import(path.join(tmp, 'game.mjs'));
  const $ = (id) => document.getElementById(id);

  // lobby
  await until(() => $('c-map').children.length === 2);
  assert.ok(body.classList.contains('screen-menu'));
  $('name').value = 'Tester';
  $('c-name').value = 'Smoke room'; $('c-waves').value = '3'; $('c-max').value = '4'; $('c-diff').value = 'easy';
  $('btn-create').onclick();
  await until(() => body.classList.contains('screen-room'));
  assert.ok($('r-title').textContent === 'Smoke room');
  console.log('  ok  lobby: connect, map list, create room -> room screen');

  // second player (bot) joins and chats in the room lobby
  const bot = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  const botMsgs = [];
  bot.on('message', (d) => botMsgs.push(JSON.parse(d.toString())));
  await new Promise((r) => bot.on('open', r));
  bot.send(JSON.stringify({ t: 'hello', name: 'Botty' }));
  await until(() => botMsgs.find((m) => m.t === 'hello_ok'));
  const roomId = botMsgs.find((m) => m.t === 'rooms' || m.t === 'hello_ok').rooms[0].id;
  bot.send(JSON.stringify({ t: 'join', room: roomId }));
  await until(() => botMsgs.find((m) => m.t === 'room'));
  bot.send(JSON.stringify({ t: 'chat', text: 'hi from the bot' }));
  await until(() => $('chatlog').children.some((c) => /hi from the bot/.test(c.textContent)));
  console.log('  ok  chat: message from another player shows in the log');

  // start the game
  $('btn-start').onclick();
  await until(() => body.classList.contains('screen-game'));
  let t = performance.now();
  const stepFrames = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { t += 16.7; if (rafCb) { const cb = rafCb; rafCb = null; cb(t); } await sleep(16); } };
  await stepFrames(600);
  assert.ok(global.__frames > 5, 'render loop is running (' + global.__frames + ' frames)');
  assert.ok(/GET READY|WAVE/.test($('wave-title').textContent), 'wave HUD: ' + $('wave-title').textContent);
  console.log('  ok  game start: world built, render loop running, HUD:', $('wave-title').textContent, '/', $('wave-sub').textContent);

  // movement + shooting through real prediction/reconcile path
  fire('keydown', { code: 'KeyD' });
  fire('keydown', { code: 'Space' });
  await stepFrames(1500);
  fire('keyup', { code: 'KeyD' });
  fire('keyup', { code: 'Space' });
  const snapBefore = global.__frames;
  await stepFrames(400);
  assert.ok(global.__frames > snapBefore);
  console.log('  ok  input: move + shoot for 1.5s without errors');

  // in-game chat: Enter opens input, type, Enter sends
  fire('keydown', { code: 'Enter', key: 'Enter' });
  assert.ok(body.classList.contains('chat-open'), 'Enter opens chat');
  $('chatinput').value = 'zombies at the east door!';
  ($('chatinput').handlers.keydown || []).forEach((f) => f({ key: 'Enter', preventDefault() {}, stopPropagation() {} }));
  assert.ok(!body.classList.contains('chat-open'), 'chat closes after sending');
  await until(() => $('chatlog').children.some((c) => /east door/.test(c.textContent)));
  await stepFrames(200);
  const bubbles = [...document.getElementById('labels').children].filter((l) => l.classList.contains('talking'));
  assert.ok(bubbles.length >= 1 && /east door/.test(bubbles[0].children[0].textContent), 'speech bubble shown over my head');
  // bot replies; bubble over other player
  bot.send(JSON.stringify({ t: 'chat', text: 'on my way' }));
  await until(() => $('chatlog').children.some((c) => /on my way/.test(c.textContent)));
  await stepFrames(200);
  assert.ok([...document.getElementById('labels').children].filter((l) => l.classList.contains('talking')).length >= 2, 'bubble over the other player too');
  console.log('  ok  in-game chat: Enter to open/send, log + speech bubbles for both players');

  // typing in chat must not move the player / trigger actions
  fire('keydown', { code: 'Enter', key: 'Enter' });
  fire('keydown', { code: 'KeyW' });
  assert.ok(body.classList.contains('chat-open'));
  fire('keydown', { code: 'Escape' });
  document.activeElement = body;
  console.log('  ok  chat open state handled');

  // game actions send without throwing
  for (const c of ['KeyE', 'KeyQ', 'KeyH', 'KeyG', 'KeyM', 'Tab']) fire('keydown', { code: c });
  await stepFrames(300);

  // death/spectate path: kill the real client's player on the server
  const { rooms } = require('../server/server');
  const room = [...rooms.values()][0];
  const me = [...room.players.values()].find((p) => p.name === 'Tester');
  room.die(me);
  await stepFrames(600);
  assert.ok($('deadbox').style.display === 'block', 'dead overlay');
  assert.ok(/YOU DIED/.test($('deadbox').innerHTML));
  const graveLabel = [...document.getElementById('labels').children].find((l) => l.classList.contains('grave'));
  assert.ok(graveLabel, 'grave label exists');
  console.log('  ok  death: overlay + grave label + spectate camera');

  // bot revives by standing on the grave
  const botP = [...room.players.values()].find((p) => p.name === 'Botty');
  room.timer = 99999; room.zombies = [];
  botP.x = me.x; botP.y = me.y;
  room.graves[0].prog = 29.9;
  await stepFrames(900);
  assert.ok(!me.dead, 'revived');
  await stepFrames(300);
  assert.ok($('deadbox').style.display === 'none', 'dead overlay hidden after revive');
  console.log('  ok  revive: teammate standing on the grave brings the player back');

  // game over screen
  room.die(botP); room.die(me);
  await until(() => body.classList.contains('screen-over'));
  assert.ok(/GAME OVER/.test($('over-title').textContent));
  await sleep(100);
  console.log('  ok  game over screen');

  assert.strictEqual(errors.length, 0, 'no uncaught errors');
  console.log('\nClient smoke test passed');
  bot.close();
  process.exit(0);
})().catch((e) => { console.error('\nSMOKE FAILED:', e); process.exit(1); });
