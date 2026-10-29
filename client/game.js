// Zombie Arena client: lobby UI, networking, input + prediction, HUD, chat.
import { $, clamp, lerp, lerpAngle, makeGrid, moveCircle, PLAYER_R, PLAYER_SPEED, sfx, unlockAudio, toggleMute } from './util.js';
import * as W3 from './world.js';

const INTERP_MS = 110;
const S = {
  ws: null, id: 0, name: '', maps: [], rooms: [], room: null, roster: [],
  inGame: false, map: null, grid: null, items: {}, revive: 30, pickR: 1.6, graveR: 1.5,
  me: { x: 0, y: 0, vx: 0, vy: 0, a: 0, hp: 100, dead: false, weapon: 'pistol', bag: 0, kills: 0, init: false },
  pending: [], acc: { dx: 0, dy: 0, dt: 0, sh: 0 }, seq: 0, lastKey: '0,0,0', lastIdle: true,
  snaps: [], latest: null, groundList: [], graves: [], wave: { n: 0, of: 0, ph: 0, tm: 0, left: 0 },
  mode: 'coop', killLimit: 0, respawn: 10, mouse: { x: 0, y: 0, down: false, has: false }, aimMode: 'keys', sentAim: 0,
  acc: 0, myColor: '#1982c4', preview: null, previewOn: false,
  spec: 0, lastHp: 100, ping: 0, loop: false, three: false, shootSfxT: 0, connected: false, retry: 0,
};
const keys = {};
const labels = new Map(); // 'p<id>' / 'g<id>' -> { el, nm, bubble, rv, talkUntil }
const dom = {
  chat: $('chatinput'), log: $('chatlog'), labels: $('labels'),
};

// ---------- networking ----------
function wsUrl() {
  const cfg = (window.GAME_CONFIG && window.GAME_CONFIG.server) || '';
  if (!cfg) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const u = cfg.replace(/\/+$/, '').replace(/^http/, 'ws');
  return (/^wss?:\/\//.test(u) ? u : (location.protocol === 'https:' ? 'wss://' : 'ws://') + u) + '/ws';
}
function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function myName() { return ($('name').value || '').trim(); }
function ensureName() { send({ t: 'hello', name: myName(), acc: S.acc }); }

function connect() {
  clearTimeout(S.retry);
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch (e) { return scheduleRetry(); }
  S.ws = ws;
  ws.onopen = () => { S.connected = true; ensureName(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } handle(m); };
  ws.onclose = () => {
    S.connected = false;
    if (S.inGame) leaveGameView();
    S.room = null;
    setScreen('menu');
    $('rooms').innerHTML = '<div class="empty">Disconnected. Reconnecting...</div>';
    scheduleRetry();
  };
}
function scheduleRetry() { S.retry = setTimeout(connect, 2000); }
setInterval(() => { if (S.connected) send({ t: 'ping', ts: performance.now() }); }, 2000);

function handle(m) {
  switch (m.t) {
    case 'hello_ok': S.id = m.id; S.name = m.name; fillMaps(m.maps); S.rooms = m.rooms; renderRooms(); localStorage.setItem('za-name', m.name); break;
    case 'rooms': S.rooms = m.rooms; renderRooms(); break;
    case 'left': S.rooms = m.rooms; S.room = null; renderRooms(); setScreen('menu'); clearChat(); break;
    case 'room': onRoom(m); break;
    case 'start': startGame(m); break;
    case 's': onSnapshot(m); break;
    case 'over': onOver(m); break;
    case 'chatlog': clearChat(); for (const c of m.msgs) addChat(c, true); break;
    case 'chat': addChat(m); break;
    case 'toast': toast(m.text); break;
    case 'err': toast(m.msg); break;
    case 'pong': S.ping = Math.round(performance.now() - m.ts); $('ping').textContent = S.ping + ' ms'; break;
    default:
  }
}

// ---------- screens / lobby ----------
function setScreen(name) {
  for (const c of [...document.body.classList]) if (c.startsWith('screen-')) document.body.classList.remove(c);
  document.body.classList.add('screen-' + name);
  if (name !== 'game') document.body.classList.remove('chat-open');
  if (name === 'menu' || name === 'room') {
    const slot = $(name === 'room' ? 'slot-room' : 'slot-menu');
    const cb = $('char-box');
    if (slot && (cb.parentNode || cb.parent) !== slot) slot.appendChild(cb);
    if (name === 'menu') S.myColor = '#1982c4';
    refreshPreview();
    startPreview();
  }
}
// ---- your character (shown on the home screen and in the room lobby) ----
const ACC_N = W3.ACC_NAMES.length;
try { S.acc = Math.max(0, Math.min(ACC_N - 1, parseInt(localStorage.getItem('za-acc'), 10) || 0)); } catch (e) { S.acc = 0; }
function refreshPreview() {
  $('acc-name').textContent = W3.ACC_NAMES[S.acc];
  if (!S.preview) {
    try { S.preview = W3.createPreview($('preview'), S.myColor, S.acc); } catch (e) { S.preview = null; }
  }
  if (S.preview) S.preview.set(S.myColor, S.acc);
}
function changeAcc(d) {
  S.acc = (S.acc + d + ACC_N) % ACC_N;
  try { localStorage.setItem('za-acc', String(S.acc)); } catch (e) { /* ignore */ }
  refreshPreview();
  send({ t: 'acc', v: S.acc });
}
function startPreview() {
  if (S.previewOn || !S.preview) return;
  S.previewOn = true;
  let last = performance.now();
  const loop = (now) => {
    if (!document.body.classList.contains('screen-menu') && !document.body.classList.contains('screen-room')) { S.previewOn = false; return; }
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    S.preview.render(dt);
  };
  requestAnimationFrame(loop);
}
$('acc-prev').onclick = () => changeAcc(-1);
$('acc-next').onclick = () => changeAcc(1);
function fillMaps(maps) {
  const sel = $('c-map'), prev = sel.value;
  sel.innerHTML = '';
  for (const m of maps) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} (${m.w}x${m.h})`; sel.appendChild(o); }
  if (prev) sel.value = prev;
  S.maps = maps;
}
function renderRooms() {
  const box = $('rooms');
  box.innerHTML = '';
  if (!S.rooms.length) { box.innerHTML = '<div class="empty">No rooms yet. Create one!</div>'; return; }
  for (const r of S.rooms) {
    const row = document.createElement('div'); row.className = 'rm';
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = r.name;
    const sm = document.createElement('small');
    const goal = r.mode === 'pvp' ? (r.killLimit ? 'first to ' + r.killLimit : 'endless') : (r.waves ? r.waves + ' waves' : 'endless');
    sm.textContent = `${r.mode === 'pvp' ? 'PvP' : 'Co-op'} · ${r.map} · ${goal} · ${r.difficulty} · ${r.count}/${r.max}${r.state !== 'lobby' ? ' · in progress' : ''}`;
    meta.append(b, sm);
    const btn = document.createElement('button'); btn.textContent = 'Join'; btn.disabled = r.count >= r.max;
    btn.onclick = () => { ensureName(); send({ t: 'join', room: r.id }); };
    row.append(meta, btn);
    box.appendChild(row);
  }
}
function onRoom(m) {
  S.room = m.room; S.roster = m.players;
  if (S.inGame && m.room.state === 'lobby') leaveGameView();
  if (!S.inGame && m.room.state === 'lobby') setScreen('room');
  if (m.room.state === 'lobby') {
    $('r-title').textContent = m.room.name;
    const me0 = m.players.find((p) => p.id === S.id);
    if (me0 && me0.color !== S.myColor) { S.myColor = me0.color; refreshPreview(); }
    const pvp = m.room.mode === 'pvp';
    const host = m.room.host === S.id;
    const goal = pvp ? (m.room.killLimit ? 'first to ' + m.room.killLimit + ' kills' : 'endless') : (m.room.waves ? m.room.waves + ' waves' : 'endless');
    $('r-info').textContent = `${pvp ? 'PvP deathmatch' : 'Co-op survival'} · ${m.room.map} · ${goal} · ${pvp ? 'bot skill: ' : ''}${m.room.difficulty} · ${m.players.length}/${m.room.max} players`;
    const pl = $('r-players'); pl.innerHTML = '';
    for (const p of m.players) {
      const c = document.createElement('div'); c.className = 'chip' + (p.bot ? ' bot' : '');
      const dot = document.createElement('i'); dot.style.background = p.color;
      const n = document.createElement('span'); n.textContent = p.name + (p.id === m.room.host ? ' (host)' : '') + (p.id === S.id ? ' (you)' : '');
      c.append(dot, n);
      if (p.bot && host) {
        const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Remove bot';
        x.onclick = () => send({ t: 'rmbot', id: p.id });
        c.appendChild(x);
      }
      pl.appendChild(c);
    }
    $('r-bots').style.display = host && pvp ? 'flex' : 'none';
    $('btn-addbot').disabled = m.players.length >= m.room.max;
    $('btn-start').style.display = host ? 'block' : 'none';
    $('r-wait').textContent = host
      ? (pvp ? 'You are the host. Add bots to fill the arena, then start. Chat below!' : 'You are the host. Start when everyone is in. Chat below!')
      : 'Waiting for the host to start...';
  }
}
$('btn-create').onclick = () => {
  unlockAudio(); ensureName();
  send({
    t: 'create', name: $('c-name').value, map: $('c-map').value, mode: $('c-mode').value, waves: Number($('c-waves').value),
    kills: Number($('c-kills').value), difficulty: $('c-diff').value, max: Number($('c-max').value),
  });
};
function syncModeUi() {
  const pvp = $('c-mode').value === 'pvp';
  $('c-waves-l').style.display = pvp ? 'none' : '';
  $('c-kills-l').style.display = pvp ? '' : 'none';
  $('c-hint').textContent = pvp ? '0 kills = endless deathmatch. You respawn 10s after dying. Add bots in the room lobby.' : '0 waves = endless survival';
  $('c-diff-l').textContent = pvp ? 'Bot skill' : 'Difficulty';
}
$('c-mode').onchange = syncModeUi;
syncModeUi();
$('btn-addbot').onclick = () => send({ t: 'addbot' });
$('btn-start').onclick = () => { unlockAudio(); send({ t: 'start' }); };
$('btn-leave').onclick = () => send({ t: 'leave' });
$('name').value = localStorage.getItem('za-name') || '';
$('name').addEventListener('change', () => { if (!S.room) ensureName(); });

// ---------- chat ----------
function clearChat() { dom.log.innerHTML = ''; }
function addChat(m, quiet) {
  const row = document.createElement('div');
  if (m.sys) { row.className = 'sys'; row.textContent = m.text; }
  else {
    const n = document.createElement('b'); n.textContent = m.name + ': '; n.style.color = m.color || '#fff';
    const t = document.createElement('span'); t.textContent = m.text;
    row.append(n, t);
    if (S.inGame && m.id) {
      const l = labels.get('p' + m.id);
      if (l) { l.bubble.textContent = m.text; l.el.classList.add('talking'); l.talkUntil = performance.now() + 4500 + m.text.length * 40; }
    }
    if (!quiet && m.id !== S.id) sfx('chat', 0.8);
  }
  dom.log.appendChild(row);
  while (dom.log.children.length > 60) dom.log.removeChild(dom.log.firstChild);
  dom.log.scrollTop = dom.log.scrollHeight;
  if (quiet) row.classList.add('old');
  else setTimeout(() => row.classList.add('old'), 9000);
}
function openChat() {
  document.body.classList.add('chat-open');
  for (const k in keys) keys[k] = false;
  dom.chat.focus();
  dom.log.querySelectorAll('.old').forEach((e) => e.classList.remove('hidden'));
}
function closeChat() { document.body.classList.remove('chat-open'); dom.chat.value = ''; dom.chat.blur(); }
dom.chat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = dom.chat.value.trim();
    if (text) send({ t: 'chat', text });
    dom.chat.value = '';
    if (S.inGame) closeChat();
    e.preventDefault();
  } else if (e.key === 'Escape') { closeChat(); e.preventDefault(); }
  e.stopPropagation();
});

function toast(text) {
  const t = $('toast'); t.textContent = text; t.style.opacity = 1;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.style.opacity = 0; }, 2200);
}

// ---------- game start / stop ----------
function startGame(m) {
  S.inGame = true; S.map = m.map; S.items = m.items; S.revive = m.revive; S.pickR = m.pickR; S.graveR = m.graveR;
  S.mode = m.room && m.room.mode === 'pvp' ? 'pvp' : 'coop'; S.killLimit = (m.room && m.room.killLimit) || 0; S.respawn = m.respawn || 10;
  S.mouse.down = false; S.sentAim = 1e9; // force the first input to carry our aim
  document.body.classList.toggle('mode-pvp', S.mode === 'pvp');
  S.grid = makeGrid(m.map);
  S.snaps = []; S.latest = null; S.pending = []; S.groundList = []; S.graves = []; S.me.init = false; S.me.dead = false; S.seq = 0; S.spec = 0;
  S.acc = { dx: 0, dy: 0, dt: 0, sh: 0 }; S.lastKey = '0,0,0'; S.lastIdle = true; S.lastHp = 100;
  if (!S.three) { W3.init($('c')); S.three = true; }
  W3.clearAll();
  W3.buildMap(m.map);
  clearLabels();
  setScreen('game');
  unlockAudio();
  sfx('wave');
  S.loop = true; S.last = performance.now();
  requestAnimationFrame(frame);
}
function leaveGameView() {
  S.inGame = false; S.loop = false;
  W3.clearAll();
  clearLabels();
  closeChat();
  setScreen(S.room ? 'room' : 'menu');
}
function clearLabels() { for (const l of labels.values()) l.el.remove(); labels.clear(); }
function onOver(m) {
  setScreen('over');
  const pvp = m.result === 'pvp';
  const win = pvp ? m.winnerId === S.id : m.result === 'victory';
  const t = $('over-title');
  t.textContent = pvp ? (win ? 'YOU WIN!' : `${(m.winner || '?').toUpperCase()} WINS`) : (win ? 'YOU SURVIVED!' : 'GAME OVER');
  t.className = win ? 'win' : 'lose';
  $('over-sub').textContent = pvp ? `Deathmatch over${m.killLimit ? ' - first to ' + m.killLimit + ' kills' : ''}.` : (win ? 'All waves cleared. Nice teamwork!' : `The horde got you on wave ${m.wave}.`);
  const tb = $('over-stats'); tb.innerHTML = '<tr><th>PLAYER</th><th>KILLS</th><th>DEATHS</th></tr>';
  for (const s of m.stats) {
    const r = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = s.name; a.style.color = s.color;
    const b = document.createElement('td'); b.textContent = s.kills;
    const c = document.createElement('td'); c.textContent = s.deaths;
    r.append(a, b, c); tb.appendChild(r);
  }
  sfx(win ? 'revive' : 'death');
}

// ---------- snapshots ----------
function onSnapshot(m) {
  if (!S.inGame) return;
  const snap = { t: performance.now(), p: new Map(m.p.map((a) => [a[0], a])), z: new Map(m.z.map((a) => [a[0], a])) };
  S.snaps.push(snap);
  if (S.snaps.length > 8) S.snaps.shift();
  S.latest = snap;
  if (m.g) { S.groundList = m.g; W3.setGround(m.g, S.items); }
  S.graves = m.gr;
  W3.setGraves(m.gr, S.revive, S.graveR);
  S.wave = m.w;
  const sp = snap.p.get(S.id);
  const me = S.me;
  if (sp) {
    if (sp[4] < S.lastHp && !me.dead) { $('hurt').style.opacity = 1; setTimeout(() => { $('hurt').style.opacity = 0; }, 120); W3.shake(0.35); }
    S.lastHp = sp[4];
    me.hp = sp[4]; me.weapon = sp[5]; me.dead = !!sp[6]; me.bag = sp[7]; me.kills = sp[8]; me.rs = sp[9] || 0; me.ammo = sp[12] === undefined ? 0 : sp[12];
    if (!me.init) { me.init = true; me.x = me.vx = sp[1]; me.y = me.vy = sp[2]; me.a = sp[3]; W3.snapCamera(sp[1], sp[2]); }
    // reconcile: server state + replay of inputs the server has not processed yet
    const sx = sp[1], sy = sp[2];
    S.pending = S.pending.filter((q) => q.seq > m.a);
    const e = { x: sx, y: sy };
    if (!me.dead) {
      for (const q of S.pending) moveCircle(S.grid, e, q.dx * PLAYER_SPEED * q.dt, q.dy * PLAYER_SPEED * q.dt, PLAYER_R);
      const a = S.acc;
      if (a.dt > 0 && (a.dx || a.dy)) moveCircle(S.grid, e, a.dx * PLAYER_SPEED * a.dt, a.dy * PLAYER_SPEED * a.dt, PLAYER_R);
      if (Math.hypot(e.x - me.x, e.y - me.y) > 2.5) { me.x = e.x; me.y = e.y; }
      else { me.x += (e.x - me.x) * 0.35; me.y += (e.y - me.y) * 0.35; }
    } else { me.x = sx; me.y = sy; }
  }
  if (m.w.tm !== undefined && S.lastPhase !== m.w.ph) { S.lastPhase = m.w.ph; if (m.w.ph) sfx('wave'); }
  for (const ev of m.ev) fx(ev);
}
function distVol(x, y) {
  const d = Math.hypot(x - S.me.x, y - S.me.y);
  return clamp(1 - d / 22, 0, 1);
}
function fx(ev) {
  switch (ev[0]) {
    case 's': {
      const [, x, y, a, len, hit, wid] = ev;
      const def = S.items[wid], col = def ? def.color : '#ffffff';
      const dx = Math.cos(a), dy = Math.sin(a), off = Math.min(0.6, len);
      W3.tracer(x + dx * off, y + dy * off, x + dx * len, y + dy * len, col);
      W3.burst(x + dx * 0.7, y + dy * 0.7, 0.85, '#ffe27a', 3, 2.5, 0.16, 0.12);
      if (hit) W3.burst(x + dx * len, y + dy * len, 0.8, '#7bd24a', 4, 3.2, 0.14, 0.4);
      const now = performance.now();
      if (now - S.shootSfxT > 35) { S.shootSfxT = now; sfx('shoot', distVol(x, y) * 0.8); }
      if (hit) sfx('hit', distVol(x + dx * len, y + dy * len) * 0.7);
      break;
    }
    case 'k': W3.burst(ev[1], ev[2], 0.7, '#6bbf3a', ev[3] === 2 ? 26 : 12, 5, ev[3] === 2 ? 0.28 : 0.18, 0.7); W3.burst(ev[1], ev[2], 0.6, '#c0392b', 5, 4, 0.14, 0.6); sfx('kill', distVol(ev[1], ev[2])); break;
    case 'h': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.9, '#ff3b5c', 8, 3.5, 0.15, 0.45); sfx('hurt', ev[1] === S.id ? 1 : distVol(v ? v[1] : 99, v ? v[2] : 99) * 0.6); break; }
    case 'd': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.8, '#ff3b5c', 22, 5, 0.2, 0.8); sfx('death', ev[1] === S.id ? 1 : 0.5); if (ev[1] === S.id) W3.shake(0.8); break; }
    case 'r': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.3, '#9be564', 30, 4, 0.18, 1.0); sfx('revive', ev[1] === S.id ? 1 : 0.6); break; }
    case 'e': if (ev[1] === S.id) { sfx('empty'); if (performance.now() - (S.emptyT || 0) > 1500) { S.emptyT = performance.now(); toast('Out of ammo! Find an ammo pack'); } } break;
    case 'u': { const v = S.latest && S.latest.p.get(ev[1]); sfx('pick', ev[1] === S.id ? 1 : distVol(v ? v[1] : 99, v ? v[2] : 99) * 0.5); break; }
    case 'm': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.9, '#ff7a9c', 10, 2.5, 0.16, 0.8); sfx('heal', ev[1] === S.id ? 1 : 0.4); break; }
    default:
  }
}

// ---------- input ----------
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
window.addEventListener('keydown', (e) => {
  unlockAudio();
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (!typing) { if (S.inGame) openChat(); else dom.chat.focus(); e.preventDefault(); }
    return;
  }
  if (!S.inGame && !typing && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && (document.body.classList.contains('screen-menu') || document.body.classList.contains('screen-room'))) {
    changeAcc(e.code === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return;
  }
  if (!S.inGame || typing) return;
  if (GAME_KEYS.has(e.code)) {
    keys[e.code] = true; e.preventDefault();
    if (e.code.startsWith('Arrow')) setAimMode('keys'); // arrows = keyboard-only play; moving the mouse switches back
    return;
  }
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyE': send({ t: 'act', k: 'equip' }); break;
    case 'KeyQ': send({ t: 'act', k: 'drop' }); break;
    case 'KeyG': send({ t: 'act', k: 'dropheal' }); break;
    case 'KeyH': send({ t: 'act', k: 'heal' }); break;
    case 'KeyM': toast(toggleMute() ? 'Sound off' : 'Sound on'); break;
    case 'Tab': cycleSpectate(); e.preventDefault(); break;
    case 'Escape': closeChat(); break;
    default:
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; S.mouse.down = false; });
// mouse: aim at the cursor, hold left button to shoot
function setAimMode(mode) {
  if (S.aimMode === mode) return;
  S.aimMode = mode;
  if (S.inGame) toast(mode === 'mouse' ? 'Aim: mouse' : 'Aim: keyboard (arrows / walking direction)');
}
window.addEventListener('mousemove', (e) => {
  const m = S.mouse;
  if (m.has && Math.hypot(e.clientX - m.x, e.clientY - m.y) < 3) return;
  m.x = e.clientX; m.y = e.clientY;
  if (m.has) setAimMode('mouse');
  m.has = true;
});
window.addEventListener('mousedown', (e) => {
  unlockAudio();
  if (e.button !== 0 || !S.inGame || e.target !== $('c')) return;
  S.mouse.x = e.clientX; S.mouse.y = e.clientY; S.mouse.has = true; S.mouse.down = true;
  setAimMode('mouse');
  e.preventDefault();
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) S.mouse.down = false; });
window.addEventListener('contextmenu', (e) => { if (S.inGame && e.target === $('c')) e.preventDefault(); });

function cycleSpectate() {
  if (!S.latest) return;
  const alive = [...S.latest.p.values()].filter((p) => !p[6] && p[0] !== S.id).map((p) => p[0]);
  if (!alive.length) return;
  const i = alive.indexOf(S.spec);
  S.spec = alive[(i + 1) % alive.length];
}

function flushInput() {
  const a = S.acc;
  const moving = a.dx !== 0 || a.dy !== 0;
  const aim = S.me.a;
  let ad = Math.abs(aim - S.sentAim) % (Math.PI * 2);
  if (ad > Math.PI) ad = Math.PI * 2 - ad;
  const idle = !moving && !a.sh && !(ad > 0.01 && !S.me.dead);
  if (idle && S.lastIdle) { a.dt = 0; return; }
  S.lastIdle = idle;
  S.sentAim = aim;
  const dt = Math.min(a.dt, 0.1);
  S.seq++;
  send({ t: 'in', seq: S.seq, dx: a.dx, dy: a.dy, dt: Math.round(dt * 1000), sh: a.sh, aa: Math.round(aim * 1000) / 1000 });
  if (moving && dt > 0) S.pending.push({ seq: S.seq, dx: a.dx, dy: a.dy, dt });
  if (S.pending.length > 40) S.pending.shift();
  a.dt = 0;
}
function inputStep(dt) {
  const me = S.me;
  const typing = document.body.classList.contains('chat-open');
  let dx = 0, dy = 0;
  if (!typing && !me.dead) {
    if (keys.KeyA || keys.ArrowLeft) dx -= 1;
    if (keys.KeyD || keys.ArrowRight) dx += 1;
    if (keys.KeyW || keys.ArrowUp) dy -= 1;
    if (keys.KeyS || keys.ArrowDown) dy += 1;
  }
  const len = Math.hypot(dx, dy);
  if (len > 0) { dx /= len; dy /= len; }
  const sh = !typing && !me.dead && (keys.Space || S.mouse.down) ? 1 : 0;
  // ---- aiming: pick a target angle, then turn toward it smoothly (never snap) ----
  if (!me.dead) {
    let target = null, rate = 14;
    if (S.aimMode === 'mouse' && S.mouse.has) {
      const g = W3.screenToGround(S.mouse.x, S.mouse.y);
      if (g && Math.hypot(g.x - me.vx, g.y - me.vy) > 0.2) { target = Math.atan2(g.y - me.vy, g.x - me.vx); rate = 22; }
    } else if (len > 0) target = Math.atan2(dy, dx);
    if (target !== null) me.a = lerpAngle(me.a, target, 1 - Math.exp(-dt * rate));
  }
  const key = dx.toFixed(2) + ',' + dy.toFixed(2) + ',' + sh;
  if (key !== S.lastKey) { flushInput(); S.lastKey = key; S.acc.dx = dx; S.acc.dy = dy; S.acc.sh = sh; }
  S.acc.dt += dt;
  if (len > 0 && !me.dead) moveCircle(S.grid, me, dx * PLAYER_SPEED * dt, dy * PLAYER_SPEED * dt, PLAYER_R);
  if (S.acc.dt >= 0.05) flushInput();
  return len > 0;
}

// ---------- interpolation ----------
function interp(kind, id) {
  const arr = S.snaps;
  if (!arr.length) return null;
  const rt = performance.now() - INTERP_MS;
  let a = null, b = null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t <= rt) { a = arr[i]; b = arr[i + 1] || null; break; }
  if (!a) a = arr[0];
  const A = a[kind].get(id), B = b ? b[kind].get(id) : null;
  if (A && B) {
    const f = clamp((rt - a.t) / Math.max(1, b.t - a.t), 0, 1);
    return [lerp(A[1], B[1], f), lerp(A[2], B[2], f), kind === 'p' ? lerpAngle(A[3], B[3], f) : 0];
  }
  const R = B || A || S.latest[kind].get(id);
  return R ? [R[1], R[2], R[3]] : null;
}

// ---------- labels ----------
function label(key, color) {
  let l = labels.get(key);
  if (l) return l;
  const el = document.createElement('div'); el.className = 'lb';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  const nm = document.createElement('div'); nm.className = 'nm'; nm.style.color = color || '#fff';
  const rv = document.createElement('div'); rv.className = 'rv'; rv.appendChild(document.createElement('i'));
  el.append(bubble, nm, rv);
  dom.labels.appendChild(el);
  l = { el, nm, bubble, rv, fill: rv.firstChild, talkUntil: 0 };
  labels.set(key, l);
  return l;
}
function placeLabel(l, x, y, h) {
  const p = W3.project(x, y, h);
  l.el.style.display = p.ok ? 'block' : 'none';
  l.el.style.left = p.x.toFixed(0) + 'px'; l.el.style.top = p.y.toFixed(0) + 'px';
}

// ---------- main loop ----------
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }

function frame(now) {
  if (!S.loop) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - S.last) / 1000);
  S.last = now;
  if (!S.latest) { return; }
  const me = S.me;
  const moving = inputStep(dt);
  me.vx += (me.x - me.vx) * Math.min(1, dt * 22);
  me.vy += (me.y - me.vy) * Math.min(1, dt * 22);

  // sync entities
  const livePlayers = new Set();
  for (const [id, p] of S.latest.p) {
    livePlayers.add(id);
    const info = S.roster.find((r) => r.id === id);
    const color = info ? info.color : '#ffffff';
    const v = W3.ensurePlayer(id, color, info ? info.acc : 0);
    const def = S.items[p[5]] || S.items.pistol;
    const gunCol = def ? def.color : '#ffffff';
    let x, y, a, mv;
    if (id === S.id) { x = me.vx; y = me.vy; a = me.a; mv = moving; }
    else {
      const q = interp('p', id) || [p[1], p[2], p[3]];
      mv = Math.hypot(q[0] - (v.lx === undefined ? q[0] : v.lx), q[1] - (v.ly === undefined ? q[1] : v.ly)) > 0.004;
      v.lx = q[0]; v.ly = q[1]; x = q[0]; y = q[1]; a = q[2];
    }
    // our own aim is already smoothed in inputStep; other players are eased here so 20Hz snapshots never look steppy
    W3.updatePlayer(v, x, y, a, !!p[6], gunCol, dt, mv, id === S.id ? 0 : 16, !!p[10]);
    const l = label('p' + id, color);
    l.nm.textContent = info ? info.name + (p[6] ? ' (dead)' : '') : '...';
    if (l.talkUntil && now > l.talkUntil) { l.talkUntil = 0; l.el.classList.remove('talking'); }
    if (p[6]) l.el.style.display = 'none'; else placeLabel(l, x, y, 2.5);
  }
  W3.syncIds('p', livePlayers);
  for (const [k, l] of labels) if (k[0] === 'p' && !livePlayers.has(Number(k.slice(1)))) { l.el.remove(); labels.delete(k); }

  const liveZ = new Set();
  for (const [id, z] of S.latest.z) {
    liveZ.add(id);
    const v = W3.ensureZombie(id, z[3]);
    const q = interp('z', id) || [z[1], z[2], 0];
    W3.updateZombie(v, q[0], q[1], z[4], dt);
  }
  W3.syncIds('z', liveZ);

  // graves: labels + revive prompt
  let prompt = '';
  const liveG = new Set();
  let myGrave = null;
  for (const g of S.graves) {
    const [pid, gx, gy, prog, name] = g;
    liveG.add('g' + pid);
    if (pid === S.id) myGrave = g;
    const l = label('g' + pid, '#ffb4b4');
    l.el.classList.add('grave');
    l.nm.textContent = (pid === S.id ? 'Your grave' : name + ' (dead)');
    l.fill.style.width = clamp(prog / S.revive, 0, 1) * 100 + '%';
    placeLabel(l, gx, gy, 1.5);
    if (!me.dead && pid !== S.id && Math.hypot(gx - me.vx, gy - me.vy) <= S.graveR) prompt = `Reviving ${name}... ${Math.ceil(S.revive - prog)}s - stay on the grave!`;
  }
  for (const [k, l] of labels) if (k[0] === 'g' && !liveG.has(k)) { l.el.remove(); labels.delete(k); }

  // nearest item prompt
  if (!me.dead && !prompt) {
    let best = null, bd = S.pickR * S.pickR;
    for (const g of S.groundList) { if (S.items[g[3]] && S.items[g[3]].type === 'ammo') continue; const d = (g[1] - me.vx) ** 2 + (g[2] - me.vy) ** 2; if (d < bd) { bd = d; best = g; } }
    if (best) { const def = S.items[best[3]]; if (def && def.type !== 'ammo') prompt = `[E] ${def.type === 'heal' ? 'Pick up' : 'Equip'} ${def.name}`; }
  }
  const pr = $('prompt');
  if (prompt) { pr.style.display = 'block'; setText('prompt', prompt); } else pr.style.display = 'none';

  // camera
  let cx = me.vx, cy = me.vy;
  if (me.dead) {
    const alive = [...S.latest.p.values()].filter((p) => !p[6] && p[0] !== S.id);
    if (alive.length && !alive.some((p) => p[0] === S.spec)) S.spec = alive[0][0];
    const q = alive.length ? interp('p', S.spec) : null;
    if (q) { cx = q[0]; cy = q[1]; }
  }
  W3.followCamera(cx, cy, dt);
  W3.draw(dt, now / 1000);
  updateHud(me, myGrave);
}

function updateHud(me, myGrave) {
  const w = S.wave;
  if (S.mode === 'pvp') {
    setText('wave-title', 'DEATHMATCH');
    setText('wave-sub', S.killLimit ? `First to ${S.killLimit} kills` : 'Endless - most kills wins bragging rights');
  } else if (w.ph) { setText('wave-title', `WAVE ${w.n}${w.of ? ' / ' + w.of : ''}`); setText('wave-sub', `${w.left} zombies left`); }
  else if (w.n === 0) { setText('wave-title', 'GET READY'); setText('wave-sub', `Wave 1 starts in ${w.tm}s`); }
  else { setText('wave-title', `WAVE ${w.n} CLEARED`); setText('wave-sub', `Next wave in ${w.tm}s - revive friends & grab loot`); }
  $('hp-fill').style.width = clamp(me.hp, 0, 100) + '%';
  setText('hp-text', String(Math.max(0, Math.round(me.hp))));
  const def = S.items[me.weapon] || S.items.pistol;
  setText('weapon-name', def ? def.name : 'Pistol');
  setText('ammo-info', `Ammo ${me.ammo | 0}`);
  $('ammo-info').classList.toggle('low', (me.ammo | 0) <= 15);
  setText('bag-info', me.bag ? `Heals x${me.bag}  [H]` : '');
  // players list
  let html = '';
  const plist = [...S.latest.p.values()];
  if (S.mode === 'pvp') plist.sort((a, b) => b[8] - a[8] || (a[11] || 0) - (b[11] || 0));
  for (const p of plist) {
    const info = S.roster.find((r) => r.id === p[0]);
    const score = S.mode === 'pvp' ? `${p[8]} <span class="kd">/ ${p[11] || 0} D</span>` : `${p[8]} kills`;
    html += `<div class="pl${p[6] ? ' dead' : ''}${p[0] === S.id ? ' me' : ''}${p[10] ? ' prot' : ''}"><span style="color:${info ? info.color : '#fff'}">${info ? escapeHtml(info.name) : '?'}</span> <small>${score}</small><div class="b"><i style="width:${p[6] ? 0 : p[4]}%"></i></div></div>`;
  }
  if (hudCache.pl !== html) { hudCache.pl = html; $('hud-players').innerHTML = html; }
  const db = $('deadbox');
  if (me.dead) {
    db.style.display = 'block';
    const prog = myGrave ? Math.floor(myGrave[3]) : 0;
    const msg = S.mode === 'pvp'
      ? `YOU WERE KILLED<span class="rs">${Math.max(1, me.rs || S.respawn)}</span><small>Respawning...<br>Press TAB to switch who you watch.</small>`
      : `YOU DIED<small>A teammate must stand on your grave for ${S.revive}s to revive you${prog ? ` (${prog}/${S.revive}s)` : ''}.<br>Press TAB to switch who you watch.</small>`;
    if (hudCache.db !== msg) { hudCache.db = msg; db.innerHTML = msg; }
  } else db.style.display = 'none';
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// go
setScreen('menu');
connect();
