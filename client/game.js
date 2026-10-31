// Zombie Arena client: lobby UI, networking, input + prediction, HUD, chat.
import { $, clamp, lerp, lerpAngle, makeGrid, weaponSpeed, setDoorSolid, inBush, blocked, moveCircle, PLAYER_R, PLAYER_SPEED, STAM_MAX, DASH_TIME, DASH_MULT, KILL_BOOST, DASH_CD, sfx, unlockAudio, toggleMute, setVolume, setMuted } from './util.js';
import * as W3 from './world.js';

const INTERP_MS = 90;
// Room creation is in beta: the form only appears on the /create address (or ?create)
const LOC = window.location || {};
const CREATE_MODE = /create/i.test(LOC.pathname || '') || /(^|[?&])create(=|&|$)/.test(LOC.search || '');
document.body.classList.toggle('can-create', CREATE_MODE);
const S = {
  ws: null, id: 0, name: '', maps: [], rooms: [], room: null, roster: [],
  inGame: false, map: null, grid: null, items: {}, revive: 30, pickR: 1.6, graveR: 1.5,
  me: { x: 0, y: 0, vx: 0, vy: 0, a: 0, hp: 100, dead: false, weapon: 'pistol', bag: 0, kills: 0, armor: 0, init: false },
  pending: [], acc: { dx: 0, dy: 0, dt: 0, sh: 0 }, seq: 0, lastKey: '0,0,0', lastIdle: true,
  snaps: [], latest: null, groundList: [], graves: [], wave: { n: 0, of: 0, ph: 0, tm: 0, left: 0 },
  mode: 'coop', killLimit: 0, respawn: 10, mouse: { x: 0, y: 0, down: false, has: false }, aimMode: 'keys', sentAim: 0,
  stam: STAM_MAX, exh: false, dashT: 0, ddx: 0, ddy: 0, noRec: 0, dashKey: false,
  acc: 0, fit: 0, myColor: '#1982c4', preview: null, previewOn: false,
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
function myToken() { try { return sessionStorage.getItem('za-token') || ''; } catch (e) { return ''; } }
function ensureName() { send({ t: 'hello', name: myName(), acc: S.acc, fit: S.fit, token: myToken() }); }

function connect() {
  clearTimeout(S.retry);
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch (e) { return scheduleRetry(); }
  S.ws = ws;
  ws.onopen = () => { S.connected = true; ensureName(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } handle(m); };
  ws.onclose = () => {
    S.connected = false;
    if (S.inGame) { // stay on the game screen: the server keeps our seat for a while and sends the game again once we are back
      document.body.classList.add('conn-lost');
      scheduleRetry();
      return;
    }
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
    case 'hello_ok':
      S.serverDash = !!m.dash; S.serverBuild = m.build || 'old'; document.body.classList.toggle('old-server', !m.dash);
      document.body.classList.remove('conn-lost');
      try { if (m.token) sessionStorage.setItem('za-token', m.token); } catch (e) { /* ignore */ }
      if (S.inGame && !m.resumed) { leaveGameView(); S.room = null; setScreen('menu'); toast('The game you were in has ended'); } // too late to rejoin
      S.id = m.id; S.name = m.name; fillMaps(m.maps); fillWeapons(m.weapons || []); S.rooms = m.rooms; renderRooms(); localStorage.setItem('za-name', m.name); break;
    case 'rooms': S.rooms = m.rooms; renderRooms(); break;
    case 'left': if (S.inGame) leaveGameView(); S.rooms = m.rooms; S.room = null; renderRooms(); setScreen('menu'); clearChat(); break;
    case 'room': onRoom(m); break;
    case 'start': startGame(m); break;
    case 's': onSnapshot(m); break;
    case 'over': onOver(m); break;
    case 'chatlog': clearChat(); for (const c of m.msgs) addChat(c, true); break;
    case 'chat': addChat(m); break;
    case 'toast': toast(m.text); break;
    case 'err': toast(m.msg); break;
    case 'dd': S.ddCount = (S.ddCount || 0) + 1; readout(); if (m.id !== S.id) { // scripted dash: simulate it locally from the start point, same speed and walls as the server
      W3.startRoll(m.id);
      if (![m.x, m.y, m.dx, m.dy].every(Number.isFinite)) break; // (an older server only sends the id: the roll alone is still shown)
      S.dashSim.set(m.id, { x: m.x, y: m.y, dx: m.dx, dy: m.dy, left: DASH_TIME, mul: DASH_MULT * (m.b ? KILL_BOOST : 1) }); S.dashFade.delete(m.id);
      W3.burst(m.x, m.y, 0.1, '#cccccc', 6, 2.5, 0.12, 0.35); sfx('dash', distVol(m.x, m.y) * 0.5);
    } break;
    case 'hs': headshotFlash(); break;
    case 'dx': S.dxCount = (S.dxCount || 0) + 1; S.dxWhy = m.why; readout(); break;
    case 'pong': S.ping = Math.round(performance.now() - m.ts); break;
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
const FIT_N = W3.FIT_NAMES.length;
try {
  S.acc = Math.max(0, Math.min(ACC_N - 1, parseInt(localStorage.getItem('za-acc'), 10) || 0));
  S.fit = Math.max(0, Math.min(FIT_N - 1, parseInt(localStorage.getItem('za-fit'), 10) || 0));
} catch (e) { S.acc = 0; S.fit = 0; }
function refreshPreview() {
  $('acc-name').textContent = W3.ACC_NAMES[S.acc];
  $('fit-name').textContent = W3.FIT_NAMES[S.fit];
  if (!S.preview) {
    try { S.preview = W3.createPreview($('preview'), S.myColor, S.acc, S.fit); } catch (e) { S.preview = null; }
  }
  if (S.preview) S.preview.set(S.myColor, S.acc, S.fit);
}
function saveLook() {
  try { localStorage.setItem('za-acc', String(S.acc)); localStorage.setItem('za-fit', String(S.fit)); } catch (e) { /* ignore */ }
  refreshPreview();
  send({ t: 'acc', v: S.acc, f: S.fit });
}
function changeAcc(d) { S.acc = (S.acc + d + ACC_N) % ACC_N; saveLook(); }
function changeFit(d) { S.fit = (S.fit + d + FIT_N) % FIT_N; saveLook(); }
function randomizeLook() { S.acc = Math.floor(Math.random() * ACC_N); S.fit = Math.floor(Math.random() * FIT_N); saveLook(); }
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
$('fit-prev').onclick = () => changeFit(-1);
$('fit-next').onclick = () => changeFit(1);
$('rand-look').onclick = randomizeLook;
function fillMaps(maps) {
  const sel = $('c-map'), prev = sel.value;
  sel.innerHTML = '';
  for (const m of maps) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} (${m.w}x${m.h})`; sel.appendChild(o); }
  if (prev) sel.value = prev;
  S.maps = maps;
}
function fillWeapons(list) {
  const box = $('c-weapons');
  const key = list.map((w) => w.id).join(',');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const prevOn = new Set([...box.children].filter((l) => l.firstChild && l.firstChild.checked).map((l) => l.firstChild.value));
  const first = !box.children.length;
  box.innerHTML = '';
  for (const w of list) {
    const l = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = w.id; cb.checked = first || prevOn.has(w.id);
    cb.onchange = syncStartSelect;
    l.append(cb, document.createTextNode((w.melee ? '\u2694 ' : '') + w.name));
    box.appendChild(l);
  }
  syncStartSelect();
}
function selectedWeapons() { return [...$('c-weapons').children].filter((l) => l.firstChild && l.firstChild.checked).map((l) => l.firstChild.value); }
function syncStartSelect() {
  const sel = $('c-start'), prev = sel.value, ids = selectedWeapons();
  sel.innerHTML = '';
  const names = new Map([...$('c-weapons').children].map((l) => [l.firstChild.value, l.textContent.replace('\u2694 ', '')]));
  for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = names.get(id) || id; sel.appendChild(o); }
  sel.value = ids.includes(prev) ? prev : (ids.includes('pistol') ? 'pistol' : ids[0] || '');
}
function renderRooms() {
  const box = $('rooms');
  box.innerHTML = '';
  if (!S.rooms.length) { box.innerHTML = '<div class="empty">' + (CREATE_MODE ? 'No rooms yet. Create one!' : 'No rooms are open right now - check back soon!') + '</div>'; return; }
  for (const r of S.rooms) {
    const row = document.createElement('div'); row.className = 'rm';
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = r.name;
    const sm = document.createElement('small');
    const goal = r.mode === 'pvp' ? (r.killLimit ? 'first to ' + r.killLimit : 'endless') : (r.waves ? r.waves + ' waves' : 'endless');
    sm.textContent = `${r.mode === 'pvp' ? (r.teams ? 'PvP Teams' : 'PvP') : 'Co-op'} · ${r.map} · ${goal} · ${r.difficulty} · ${r.count}/${r.max}${r.state !== 'lobby' ? ' · in progress' : ''}`;
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
    $('r-info').textContent = `${pvp ? (m.room.teams ? 'Team deathmatch (Red vs Blue)' : 'PvP deathmatch') : 'Co-op survival'} · ${m.room.map} · ${goal} · ${pvp ? 'bot skill: ' : ''}${m.room.difficulty} · ${m.players.length}/${m.room.max} players${pvp && m.room.drops ? ' · item drops on death' : ''}`;
    const pl = $('r-players'); pl.innerHTML = '';
    const teamed = !!m.room.teams;
    const ordered = teamed ? m.players.slice().sort((a, b) => a.team - b.team) : m.players;
    const mine = m.players.find((p) => p.id === S.id);
    $('r-teamrow').style.display = teamed ? 'flex' : 'none';
    if (teamed && mine) $('r-team-label').innerHTML = `You are on the <b style="color:${mine.color}">${mine.team ? 'BLUE' : 'RED'}</b> team`;
    for (const p of ordered) {
      const c = document.createElement('div'); c.className = 'chip' + (p.bot ? ' bot' : '');
      const dot = document.createElement('i'); dot.style.background = p.color;
      const n = document.createElement('span'); n.textContent = (teamed ? (p.team ? '[Blue] ' : '[Red] ') : '') + p.name + (p.id === m.room.host ? ' (host)' : '') + (p.id === S.id ? ' (you)' : '');
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
$('btn-team').onclick = () => { const me = (S.roster || []).find((p) => p.id === S.id); if (me) send({ t: 'team', team: me.team ? 0 : 1 }); };
$('btn-create').onclick = () => {
  unlockAudio(); ensureName();
  send({
    t: 'create', name: $('c-name').value, map: $('c-map').value, mode: $('c-mode').value.startsWith('pvp') ? 'pvp' : 'coop', teams: $('c-mode').value === 'pvp-team', waves: Number($('c-waves').value),
    kills: Number($('c-kills').value), weapons: selectedWeapons(), start: $('c-start').value, drops: $('c-drop').checked, difficulty: $('c-diff').value, max: Number($('c-max').value),
  });
};
function syncModeUi() {
  const pvp = $('c-mode').value.startsWith('pvp');
  $('c-waves-l').style.display = pvp ? 'none' : '';
  $('c-kills-l').style.display = pvp ? '' : 'none';
  $('c-hint').textContent = pvp ? ($('c-mode').value === 'pvp-team' ? 'Red vs Blue: kills add up for the team, no friendly fire. 0 = endless. ' : '0 kills = endless deathmatch. ') + 'You respawn 10s after dying. Add bots in the room lobby.' : '0 waves = endless survival';
  $('c-diff-l').textContent = pvp ? 'Bot skill' : 'Difficulty';
  $('c-drop-l').style.display = pvp ? '' : 'none';
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
  S.teams = !!(m.room && m.room.teams); S.mode = m.room && m.room.mode === 'pvp' ? 'pvp' : 'coop'; S.killLimit = (m.room && m.room.killLimit) || 0; S.respawn = m.respawn || 10;
  S.building = false; S.mouse.down = false; S.sentAim = 1e9; // force the first input to carry our aim
  document.body.classList.toggle('mode-pvp', S.mode === 'pvp');
  S.grid = makeGrid(m.map);
  for (const i of m.doors || []) setDoorSolid(S.grid, i, true);
  S.snaps = []; S.latest = null; S.pending = []; S.groundList = []; S.graves = []; S.me.init = false; S.me.dead = false; S.seq = 0; S.spec = 0;
  S.acc = { dx: 0, dy: 0, dt: 0, sh: 0, dh: 0, sp: 0 }; S.lastKey = '0,0,0,0'; S.stam = STAM_MAX; S.exh = false; S.dashT = 0; S.noRec = 0; S.dashSeq = 0; S.dashSim.clear(); S.dashFade.clear(); S.lastIdle = true; S.lastHp = 100;
  if (!S.three) { W3.init($('c')); S.three = true; }
  W3.clearAll();
  W3.buildMap(m.map);
  for (const i of m.doors || []) W3.setDoor(i, true);
  for (const i of m.walls || []) { S.grid.solid[i] = 1; W3.setWall(i, true); }
  clearLabels();
  setScreen('game');
  unlockAudio();
  sfx('wave');
  S.last = performance.now();
  if (!S.loop) { S.loop = true; requestAnimationFrame(frame); } // (a reconnect re-sends 'start' while the loop is already running)
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
  const pvp = m.result === 'pvp', ended = m.result === 'ended';
  const myTeam = ((S.roster || []).find((p) => p.id === S.id) || {}).team;
  const win = pvp ? (m.teams ? m.winTeam === myTeam : m.winnerId === S.id) : m.result === 'victory';
  const t = $('over-title');
  t.textContent = pvp ? (m.teams ? (win ? 'YOUR TEAM WINS!' : `${m.winTeam ? 'BLUE' : 'RED'} TEAM WINS`) : win ? 'YOU WIN!' : `${(m.winner || '?').toUpperCase()} WINS`) : (win ? 'YOU SURVIVED!' : 'GAME OVER');
  if (ended) t.textContent = 'GAME ENDED';
  t.className = win ? 'win' : 'lose';
  $('over-sub').textContent = ended ? 'The host ended the game.' : pvp ? (m.teams && m.teamScore ? `Red ${m.teamScore[0]} - ${m.teamScore[1]} Blue. ` : '') + `Deathmatch over${m.killLimit ? ' - first to ' + m.killLimit + ' kills' : ''}.` : (win ? 'All waves cleared. Nice teamwork!' : `The horde got you on wave ${m.wave}.`);
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
  const snap = { t: performance.now(), p: new Map(m.p.filter((a) => a[19] !== 1).map((a) => [a[0], a])), hud: m.p, z: new Map(m.z.map((a) => [a[0], a])) };
  S.snaps.push(snap);
  if (S.snaps.length > 8) S.snaps.shift();
  S.latest = snap;
  if (m.g) { S.groundList = m.g; W3.setGround(m.g, S.items); }
  S.graves = m.gr;
  W3.setGrenades(m.gn || []);
  S.turretList = m.tu || []; W3.setTurrets(m.tu || []); W3.setMines(m.mn || []); W3.setWallHp(m.wl || []);
  W3.setGraves(m.gr, S.revive, S.graveR);
  S.wave = m.w;
  const sp = snap.p.get(S.id);
  const me = S.me;
  if (sp) {
    if (sp[4] < S.lastHp && !me.dead) { $('hurt').style.opacity = 1; setTimeout(() => { $('hurt').style.opacity = 0; }, 120); W3.shake(0.35); }
    S.lastHp = sp[4];
    me.hp = sp[4]; me.weapon = sp[5]; me.dead = !!sp[6]; me.bag = sp[7]; me.kills = sp[8]; me.rs = sp[9] || 0;
    me.armor = sp[15] || 0; me.nades = sp[18] || 0; me.heat = sp[20] || 0; me.lock = sp[21] === 1; me.turrets = sp[22] || 0; me.walls = sp[23] || 0; me.mines = sp[24] || 0;
    if (sp[17] === 1 && !S.boost && !me.dead) toast('Kill! +20% speed for 10s');
    S.boost = sp[17] === 1;
    if (sp[13] !== undefined) { if (sp[13] < S.stam - 12 || me.dead) S.stam = sp[13]; if (me.dead) { S.stam = STAM_MAX; S.dashT = 0; } } me.ammo = sp[12] === undefined ? 0 : sp[12];
    if (!me.init) { me.init = true; me.x = me.vx = sp[1]; me.y = me.vy = sp[2]; me.a = sp[3]; W3.snapCamera(sp[1], sp[2]); }
    // reconcile: server state + replay of inputs the server has not processed yet
    const sx = sp[1], sy = sp[2];
    S.pending = S.pending.filter((q) => q.seq > m.a);
    const e = { x: sx, y: sy };
    if (!me.dead) {
      for (const q of S.pending) moveCircle(S.grid, e, q.dx * PLAYER_SPEED * q.m * q.dt, q.dy * PLAYER_SPEED * q.m * q.dt, PLAYER_R);
      const a = S.acc;
      if (a.dt > 0 && (a.dx || a.dy)) { const am = (a.sp ? DASH_MULT : 1) * (S.boost ? KILL_BOOST : 1) * wmult(); moveCircle(S.grid, e, a.dx * PLAYER_SPEED * am * a.dt, a.dy * PLAYER_SPEED * am * a.dt, PLAYER_R); }
      if (Math.hypot(e.x - me.x, e.y - me.y) > 2.5) { me.x = e.x; me.y = e.y; }
      else { me.x += (e.x - me.x) * 0.35; me.y += (e.y - me.y) * 0.35; }
    } else { me.x = sx; me.y = sy; }
  }
  if (m.w.tm !== undefined && S.lastPhase !== m.w.ph) { S.lastPhase = m.w.ph; if (m.w.ph) sfx('wave'); }
  for (const ev of m.ev) fx(ev);
}
// big "HEADSHOT!" in the middle of the screen for a moment
let hsTimer = 0;
function headshotFlash() {
  const el = $('headshot');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(hsTimer); hsTimer = setTimeout(() => el.classList.remove('show'), 1100);
  sfx('hit', 1);
  W3.shake(0.25);
}
const me0 = () => S.me;
// the barricade tile in front of me (same maths as the server) and whether it is free
function buildSpot() {
  const me = S.me, g = S.grid, tx = Math.floor(me.vx + Math.cos(me.a) * 1.3), ty = Math.floor(me.vy + Math.sin(me.a) * 1.3), idx = ty * g.w + tx;
  let ok = !(tx < 1 || ty < 1 || tx >= g.w - 1 || ty >= g.h - 1 || g.solid[idx] || g.doors.includes(idx));
  if (ok) {
    const near = (x, y, r) => { const nx = Math.max(tx, Math.min(x, tx + 1)), ny = Math.max(ty, Math.min(y, ty + 1)); return (x - nx) ** 2 + (y - ny) ** 2 < r * r; };
    const snap = S.latest;
    if (snap) {
      for (const a of snap.p.values()) if (!a[6] && near(a[0] === S.id ? me.vx : a[1], a[0] === S.id ? me.vy : a[2], 0.46)) { ok = false; break; }
      if (ok) for (const z of snap.z.values()) if (near(z[1], z[2], 0.46)) { ok = false; break; }
      if (ok) for (const t of S.turretList || []) if (near(t[1], t[2], 0.46)) { ok = false; break; }
    }
  }
  return { tx, ty, ok };
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
      const dx = Math.cos(a), dy = Math.sin(a);
      // the gun's muzzle: 0.97 ahead and 0.3 to the right of the body centre (see buildPlayerModel)
      if (def && def.flame) { // a stream of fire instead of a tracer
        const mf0 = W3.muzzleForward(wid), sx = x + dx * mf0 + dy * 0.3, sy = y + dy * mf0 - dx * 0.3;
        for (let k = 0; k < 3; k++) { const d = 0.3 + Math.random() * (len - 0.3); W3.burst(sx + dx * d, sy + dy * d, 0.8, Math.random() < 0.5 ? '#ff7b00' : '#ffd23f', 1, 1.2, 0.2 + d * 0.03, 0.3); }
        if (performance.now() - S.shootSfxT > 70) { S.shootSfxT = performance.now(); sfx('shoot', distVol(x, y) * 0.35); }
        break;
      }
      const mf = W3.muzzleForward(wid), tx = x + dx * mf + dy * 0.3, ty = y + dy * mf - dx * 0.3;
      const far = len > mf + 0.05; // (a point-blank hit ends right at the muzzle)
      W3.tracer(tx, ty, far ? x + dx * len : tx + dx * 0.06, far ? y + dy * len : ty + dy * 0.06, col);
      W3.burst(tx + dx * 0.05, ty + dy * 0.05, 0.86, '#ffe27a', 4, 2.5, 0.18, 0.12);
      if (hit) W3.burst(x + dx * len, y + dy * len, 0.8, ev[7] ? '#ffd23f' : '#7bd24a', ev[7] ? 9 : 4, 3.2, ev[7] ? 0.2 : 0.14, 0.4);
      const now = performance.now();
      if (now - S.shootSfxT > 35) { S.shootSfxT = now; sfx('shoot', distVol(x, y) * 0.8); }
      if (hit) sfx('hit', distVol(x + dx * len, y + dy * len) * 0.7);
      break;
    }
    case 'k': W3.addBlood(ev[1], ev[2], ev[3] === 2 ? 1.7 : 1, ev[3] === 2 ? 9 : 6); W3.burst(ev[1], ev[2], 0.7, '#6bbf3a', ev[3] === 2 ? 26 : 12, 5, ev[3] === 2 ? 0.28 : 0.18, 0.7); W3.burst(ev[1], ev[2], 0.6, '#c0392b', 5, 4, 0.14, 0.6); sfx('kill', distVol(ev[1], ev[2])); break;
    case 'h': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.9, '#ff3b5c', 8, 3.5, 0.15, 0.45); sfx('hurt', ev[1] === S.id ? 1 : distVol(v ? v[1] : 99, v ? v[2] : 99) * 0.6); break; }
    case 'o': { // a door opened / closed (ev[1] = 1 open, ev[2] = tile indexes)
      for (const i of ev[2]) { setDoorSolid(S.grid, i, !!ev[1]); W3.setDoor(i, !!ev[1]); }
      const i0 = ev[2][0]; sfx('pick', distVol((i0 % S.grid.w) + 0.5, Math.floor(i0 / S.grid.w) + 0.5) * 0.7);
      break;
    }
    case 'g': W3.blast(ev[1], ev[2], ev[3]); sfx('kill', distVol(ev[1], ev[2])); sfx('shoot', distVol(ev[1], ev[2]) * 0.9); break;
    case 'b': W3.burst(ev[1], ev[2], 0.6, '#ff7b00', 4, 1.6, 0.14, 0.5); W3.burst(ev[1], ev[2], 1.0, '#ffd23f', 2, 1.2, 0.1, 0.4); break;
    case 'W': S.grid.solid[ev[1]] = ev[2] ? 1 : 0; W3.setWall(ev[1], !!ev[2]); break;
    case 'wh': { const x = (ev[1] % S.grid.w) + 0.5, y = Math.floor(ev[1] / S.grid.w) + 0.5; W3.burst(x, y, 0.6, '#b08968', 5, 2.5, 0.12, 0.35); sfx('hit', distVol(x, y) * 0.5); break; }
    case 'q': { const [, , x, y, a, len] = ev, dx = Math.cos(a), dy = Math.sin(a); W3.tracer(x + dx * 0.55, y + dy * 0.55, x + dx * len, y + dy * len, '#4cc9f0'); W3.burst(x + dx * 0.6, y + dy * 0.6, 0.7, '#ffe27a', 3, 2, 0.14, 0.1); sfx('shoot', distVol(x, y) * 0.4); break; }
    case 'th': break;
    case 'X': W3.burst(ev[1], ev[2], 0.5, '#888888', 18, 4, 0.2, 0.6); W3.burst(ev[1], ev[2], 0.5, '#ff9f1c', 8, 3, 0.16, 0.4); sfx('kill', distVol(ev[1], ev[2]) * 0.8); break;
    case 'P': W3.burst(ev[1], ev[2], 0.15, '#c9b896', 8, 2, 0.14, 0.4); sfx('pick', distVol(ev[1], ev[2])); break;
    case 'j': if (ev[1] === S.id) { toast('Gatling overheated! Cooling down...'); sfx('empty'); } break;
    case 't': sfx('dash', ev[1] === S.id ? 0.7 : 0.3); break;
    case 'D': if (ev[1] !== S.id) W3.startRoll(ev[1]); break; // (the 'dd' message normally got there first)
    case 'd': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.addBlood(v[1], v[2], 1.6, 9); if (v) W3.burst(v[1], v[2], 0.8, '#ff3b5c', 22, 5, 0.2, 0.8); sfx('death', ev[1] === S.id ? 1 : 0.5); if (ev[1] === S.id) W3.shake(0.8); break; }
    case 'r': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.3, '#9be564', 30, 4, 0.18, 1.0); sfx('revive', ev[1] === S.id ? 1 : 0.6); break; }
    case 'w': {
      const [, pid, x, y, a, range, arc, hit, wid] = ev;
      const def = S.items[wid];
      W3.slash(x, y, a, range, arc, def ? def.color : '#ffffff');
      W3.swingPlayer(pid);
      if (hit) { W3.burst(x + Math.cos(a) * range * 0.7, y + Math.sin(a) * range * 0.7, 0.85, '#7bd24a', 5, 3.2, 0.14, 0.4); sfx('hit', distVol(x, y) * 0.9); }
      else sfx('shoot', distVol(x, y) * 0.25);
      break;
    }
    case 'e': if (ev[1] === S.id) { sfx('empty'); if (performance.now() - (S.emptyT || 0) > 1500) { S.emptyT = performance.now(); toast('Out of ammo! Find an ammo pack'); } } break;
    case 'u': { const v = S.latest && S.latest.p.get(ev[1]); sfx('pick', ev[1] === S.id ? 1 : distVol(v ? v[1] : 99, v ? v[2] : 99) * 0.5); break; }
    case 'm': { const v = S.latest && S.latest.p.get(ev[1]); if (v) W3.burst(v[1], v[2], 0.9, '#ff7a9c', 10, 2.5, 0.16, 0.8); sfx('heal', ev[1] === S.id ? 1 : 0.4); break; }
    default:
  }
}

// ---------- input + customizable key bindings ----------
const DEFAULT_BINDS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  dash: 'ShiftLeft', shoot: 'Space',
  equip: 'KeyE', nade: 'KeyF', drop: 'KeyQ', dropheal: 'KeyG', heal: 'KeyH',
  turret: 'KeyT', wall: 'KeyB', mine: 'KeyN', remove: 'KeyX', mute: 'KeyM',
};
const BIND_LABELS = {
  up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right',
  dash: 'Dash', shoot: 'Shoot',
  equip: 'Equip / doors', nade: 'Throw grenade', drop: 'Drop gun', dropheal: 'Drop heal', heal: 'Use heal',
  turret: 'Plant turret', wall: 'Barricade', mine: 'Plant mine', remove: 'Remove build', mute: 'Mute',
};
const HOLD_BINDS = new Set(['up', 'down', 'left', 'right', 'dash', 'shoot']);
const FIXED_CODES = new Set(['Escape', 'Enter', 'NumpadEnter', 'Tab', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight']);
S.binds = { ...DEFAULT_BINDS };
S.rebind = null; // action id while listening for a new key in Settings
try {
  const saved = JSON.parse(localStorage.getItem('za-binds') || '{}');
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_BINDS)) if (typeof saved[k] === 'string') S.binds[k] = saved[k];
  }
} catch (e) { /* ignore */ }
function saveBinds() { try { localStorage.setItem('za-binds', JSON.stringify(S.binds)); } catch (e) { /* ignore */ } }
const MOUSE_NAMES = { Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
function mouseCode(button) { return 'Mouse' + button; }
function isMouseCode(code) { return typeof code === 'string' && code.startsWith('Mouse'); }
function codeLabel(code) {
  if (!code) return '?';
  if (MOUSE_NAMES[code]) return MOUSE_NAMES[code];
  if (code === 'Space') return 'Space';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}
function codesFor(action) {
  const c = S.binds[action];
  if (!c) return [];
  if (c === 'ShiftLeft' || c === 'ShiftRight') return ['ShiftLeft', 'ShiftRight'];
  return [c];
}
function bindDown(action) { return codesFor(action).some((c) => keys[c]); }
function isBind(e, action) { return codesFor(action).includes(e.code); }
function holdCodes() {
  const set = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  for (const a of HOLD_BINDS) for (const c of codesFor(a)) if (!isMouseCode(c)) set.add(c);
  return set;
}
function actionForCode(code) {
  for (const [a, c] of Object.entries(S.binds)) {
    if (c === code) return a;
    if ((code === 'ShiftLeft' || code === 'ShiftRight') && (c === 'ShiftLeft' || c === 'ShiftRight')) return a;
  }
  return null;
}
// left click shoots by default until Mouse0 is bound to something else
function unboundLeftShoot() { return !!keys.Mouse0 && !actionForCode('Mouse0'); }
function settingsOpen() { const d = $('settings-panel').style.display; return d === 'flex' || d === 'block'; }
function cancelRebind() { S.rebind = null; renderBinds(); }
function renderBinds() {
  const box = $('bind-list');
  if (!box) return;
  box.innerHTML = '';
  for (const [action, label] of Object.entries(BIND_LABELS)) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const name = document.createElement('span');
    name.textContent = label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = action;
    if (S.rebind === action) { btn.className = 'listening'; btn.textContent = 'Press…'; }
    else btn.textContent = codeLabel(S.binds[action]);
    btn.onclick = (ev) => {
      ev.preventDefault();
      S.rebind = S.rebind === action ? null : action;
      renderBinds();
      if (S.rebind) toast('Press a key or mouse button for ' + label + ' (Esc to cancel)');
    };
    // don't steal the click used to start listening; mouse bind is captured on window while listening
    btn.onmousedown = (ev) => { if (!S.rebind) ev.preventDefault(); };
    row.appendChild(name); row.appendChild(btn);
    box.appendChild(row);
  }
}
function assignBind(action, code) {
  if (!DEFAULT_BINDS[action] || FIXED_CODES.has(code)) return false;
  // if another action already uses this key / mouse button, swap
  for (const [other, c] of Object.entries(S.binds)) {
    if (other === action) continue;
    const clash = c === code
      || ((code === 'ShiftLeft' || code === 'ShiftRight') && (c === 'ShiftLeft' || c === 'ShiftRight'));
    if (clash) S.binds[other] = S.binds[action];
  }
  S.binds[action] = (code === 'ShiftRight') ? 'ShiftLeft' : code;
  saveBinds();
  S.rebind = null;
  renderBinds();
  updateHelpKeys();
  toast(BIND_LABELS[action] + ' → ' + codeLabel(S.binds[action]));
  return true;
}
function firePressAction(action) {
  if (action === 'equip') { send({ t: 'act', k: 'equip' }); return; }
  if (action === 'nade') { send({ t: 'act', k: 'nade' }); return; }
  if (action === 'drop') { S.building = false; send({ t: 'act', k: 'drop' }); return; }
  if (action === 'dropheal') { send({ t: 'act', k: 'dropheal' }); return; }
  if (action === 'heal') { send({ t: 'act', k: 'heal' }); return; }
  if (action === 'turret') { send({ t: 'act', k: 'turret' }); return; }
  if (action === 'wall') {
    if (me0().dead) return;
    if (!S.building) {
      if (!(me0().walls > 0)) { toast('No barricades. Open supply crates!'); return; }
      S.building = true; toast('Press ' + codeLabel(S.binds.wall) + ' again to place, Esc to cancel'); return;
    }
    const t = buildSpot();
    if (t.ok) { send({ t: 'act', k: 'wall' }); S.building = false; } else toast('Blocked - move or aim somewhere else');
    return;
  }
  if (action === 'mine') { send({ t: 'act', k: 'mine' }); return; }
  if (action === 'remove') { send({ t: 'act', k: 'remove' }); return; }
  if (action === 'mute') { const mu = toggleMute(); toast(mu ? 'Sound off' : 'Sound on'); S.set.mute = mu; $('set-mute').checked = mu; saveSettings(); }
}
function updateHelpKeys() {
  const h = $('help');
  if (!h) return;
  const k = (a) => codeLabel(S.binds[a]);
  h.innerHTML = `${k('up')}${k('left')}${k('down')}${k('right')} / Arrows move &middot; ${k('dash')} dash-roll (1s invincible, 3s cooldown) &middot; MOUSE aim &middot; ${k('shoot')} shoot (limited ammo - grab ammo packs) &middot; ${k('equip')} equip / open &amp; close doors &middot; ${k('nade')} throw grenade (gatling overheats, launcher has a slow reload, katana makes you run 1.5x) &middot; Co-op: ${k('turret')} turret &middot; ${k('wall')} barricade &middot; ${k('mine')} mine &middot; ${k('remove')} remove &middot; ${k('drop')} drop gun &middot; ${k('heal')} heal &middot; ${k('dropheal')} drop heal &middot; ENTER chat &middot; ${k('mute')} mute <span class="tiny">(edit keys / mouse in Settings)</span>`;
}

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (S.rebind) {
    e.preventDefault();
    if (e.code === 'Escape') { cancelRebind(); toast('Rebind cancelled'); return; }
    if (e.repeat) return;
    if (!assignBind(S.rebind, e.code)) toast('That key is reserved');
    return;
  }
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (!typing) { if (S.inGame) openChat(); else dom.chat.focus(); e.preventDefault(); }
    return;
  }
  if (!S.inGame && !typing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code) && (document.body.classList.contains('screen-menu') || document.body.classList.contains('screen-room'))) {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') changeAcc(e.code === 'ArrowLeft' ? -1 : 1); else changeFit(e.code === 'ArrowUp' ? -1 : 1);
    e.preventDefault(); return;
  }
  if (e.code === 'Escape') {
    if (typing) return;
    if (S.building) { S.building = false; e.preventDefault(); return; }
    if (document.body.classList.contains('chat-open')) { closeChat(); e.preventDefault(); return; }
    toggleSettings(); e.preventDefault(); return;
  }
  if (settingsOpen() || !S.inGame || typing) return;
  if (S.me.dead && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { if (!e.repeat) cycleSpectate(e.code === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return; }
  if (holdCodes().has(e.code)) {
    keys[e.code] = true; e.preventDefault();
    if (e.code.startsWith('Arrow')) setAimMode('keys'); // arrows = keyboard-only play; moving the mouse switches back
    return;
  }
  if (e.repeat) return;
  for (const action of Object.keys(BIND_LABELS)) {
    if (HOLD_BINDS.has(action)) continue;
    if (isBind(e, action)) { firePressAction(action); return; }
  }
  if (e.code === 'Tab') { cycleSpectate(e.shiftKey ? -1 : 1); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; S.mouse.down = false; S.rebind = null; });
// mouse: aim at the cursor; buttons are bindable (left / right / middle / side)
function setAimMode(mode) {
  if (S.aimMode === mode) return;
  S.aimMode = mode;
  if (S.inGame) toast(mode === 'mouse' ? 'Aim: mouse' : 'Aim: keyboard (arrows / walking direction)');
}
window.addEventListener('mousemove', (e) => {
  if (e.target && e.target.closest && e.target.closest('#settings-panel, #settings-btn')) return;
  const m = S.mouse;
  if (m.has && Math.hypot(e.clientX - m.x, e.clientY - m.y) < 3) return;
  m.x = e.clientX; m.y = e.clientY;
  if (m.has) setAimMode('mouse');
  m.has = true;
});
window.addEventListener('mousedown', (e) => {
  unlockAudio();
  const code = mouseCode(e.button);
  // while rebinding, any mouse button (including on the settings panel) assigns the bind
  if (S.rebind) {
    e.preventDefault();
    if (!assignBind(S.rebind, code)) toast('That button is reserved');
    return;
  }
  // side buttons: stop browser back/forward
  if (e.button >= 3) e.preventDefault();
  if (settingsOpen()) return;
  if (!S.inGame) return;
  // UI clicks outside the canvas shouldn't fire game binds
  if (e.target !== $('c') && e.button === 0) return;
  if (e.target !== $('c') && e.button < 3) return;
  keys[code] = true;
  S.mouse.x = e.clientX; S.mouse.y = e.clientY; S.mouse.has = true;
  if (e.button === 0) S.mouse.down = true;
  setAimMode('mouse');
  e.preventDefault();
  if (S.me.dead) { if (e.button === 0) cycleSpectate(1); return; }
  const action = actionForCode(code);
  if (action && !HOLD_BINDS.has(action)) firePressAction(action);
});
window.addEventListener('mouseup', (e) => {
  const code = mouseCode(e.button);
  keys[code] = false;
  if (e.button === 0) S.mouse.down = false;
});
window.addEventListener('auxclick', (e) => { if (S.inGame || S.rebind) e.preventDefault(); });
window.addEventListener('contextmenu', (e) => {
  if (S.rebind || (S.inGame && (e.target === $('c') || actionForCode('Mouse2')))) e.preventDefault();
});

// while dead you watch a player who is still alive; Tab / arrow keys / mouse click switch to the next or previous one
function cycleSpectate(dir = 1) {
  if (!S.latest) return;
  const alive = [...S.latest.p.values()].filter((p) => !p[6] && p[0] !== S.id).map((p) => p[0]);
  if (!alive.length) return;
  const i = alive.indexOf(S.spec);
  S.spec = alive[(i + (i < 0 ? (dir > 0 ? 0 : alive.length - 1) : dir) + alive.length) % alive.length];
}

function flushInput() {
  const a = S.acc;
  const moving = a.dx !== 0 || a.dy !== 0;
  const aim = S.me.a;
  let ad = Math.abs(aim - S.sentAim) % (Math.PI * 2);
  if (ad > Math.PI) ad = Math.PI * 2 - ad;
  const idle = !moving && !a.sh && !a.dh && !(ad > 0.01 && !S.me.dead);
  if (idle && S.lastIdle) { a.dt = 0; return; }
  S.lastIdle = idle;
  S.sentAim = aim;
  const dt = Math.min(a.dt, 0.1);
  S.seq++;
  send({ t: 'in', seq: S.seq, dx: a.dx, dy: a.dy, dt: Math.round(dt * 1000), sh: a.sh, dh: a.dh ? 1 : 0, sp: a.sp ? 1 : 0, aa: Math.round(aim * 1000) / 1000 });
  a.dh = 0;
  if (moving && dt > 0) S.pending.push({ seq: S.seq, dx: a.dx, dy: a.dy, dt, m: (a.sp ? DASH_MULT : 1) * (S.boost ? KILL_BOOST : 1) * wmult() });
  if (S.pending.length > 40) S.pending.shift();
  a.dt = 0;
}
// some weapons change how fast you walk (katana +50%, gatling -18%); the server uses the same number
function wmult() { return weaponSpeed(S.items && S.items[S.me.weapon]); }
function inputStep(dt) {
  const me = S.me;
  const typing = document.body.classList.contains('chat-open');
  let dx = 0, dy = 0;
  let keyed = false;
  if (!typing && !me.dead && !settingsOpen()) {
    if (bindDown('left') || keys.ArrowLeft) { dx -= 1; keyed = true; }
    if (bindDown('right') || keys.ArrowRight) { dx += 1; keyed = true; }
    if (bindDown('up') || keys.ArrowUp) { dy -= 1; keyed = true; }
    if (bindDown('down') || keys.ArrowDown) { dy += 1; keyed = true; }
    // settings: walk toward the cursor when no keyboard move is held
    if (!keyed && S.set.mouseWalk && S.mouse.has) {
      const g = W3.screenToGround(S.mouse.x, S.mouse.y);
      if (g) {
        const mx = g.x - me.vx, my = g.y - me.vy;
        const md = Math.hypot(mx, my);
        if (md > 0.45) { dx = mx / md; dy = my / md; }
      }
    }
  }
  const len = Math.hypot(dx, dy);
  if (len > 0) { dx /= len; dy /= len; }
  // dash (default Shift, one press): a forward roll with 1s of invincibility, then a cooldown (the stamina bar is the dash charge)
  const shiftDown = !typing && !me.dead && !settingsOpen() && bindDown('dash');
  let startDash = false;
  if (shiftDown && !S.dashKey && S.serverDash && S.dashT <= 0 && S.stam >= STAM_MAX - 1) {
    startDash = true; S.dashT = DASH_TIME; S.stam = 0; S.dashSent = (S.dashSent || 0) + 1; readout();
    send({ t: 'dash', dx: len > 0 ? dx : Math.cos(me.a), dy: len > 0 ? dy : Math.sin(me.a) }); // like a chat message: goes straight out, relayed to everyone
    S.ddx = len > 0 ? dx : Math.cos(me.a); S.ddy = len > 0 ? dy : Math.sin(me.a);
    sfx('dash');
  }
  S.dashKey = shiftDown;
  if (S.dashT <= 0) S.stam = Math.min(STAM_MAX, S.stam + (STAM_MAX / DASH_CD) * dt);
  const rolling = S.dashT > 0;
  if (rolling) { dx = S.ddx; dy = S.ddy; } // while rolling you run fast in the dash direction
  const sh = !typing && !me.dead && !settingsOpen() && !rolling && (bindDown('shoot') || unboundLeftShoot()) ? 1 : 0;
  // ---- aiming: pick a target angle, then turn toward it smoothly (never snap) ----
  if (!me.dead) {
    let target = null, rate = 14;
    if (S.aimMode === 'mouse' && S.mouse.has) {
      const g = W3.screenToGround(S.mouse.x, S.mouse.y);
      if (g && Math.hypot(g.x - me.vx, g.y - me.vy) > 0.2) { target = Math.atan2(g.y - me.vy, g.x - me.vx); rate = 22; }
    } else if (len > 0) target = Math.atan2(dy, dx);
    if (target !== null) me.a = lerpAngle(me.a, target, 1 - Math.exp(-dt * rate));
  }
  const key = dx.toFixed(2) + ',' + dy.toFixed(2) + ',' + sh + ',' + (rolling ? 1 : 0);
  if (key !== S.lastKey) { flushInput(); S.lastKey = key; S.acc.dx = dx; S.acc.dy = dy; S.acc.sh = sh; S.acc.sp = rolling ? 1 : 0; if (startDash) { S.acc.dh = 1; flushInput(); } } // (a new dash is sent at once, not with the next 50ms batch)
  S.acc.dt += dt;
  const moveLen = rolling ? 1 : len;
  if (moveLen > 0 && !me.dead) { const mu = (rolling ? DASH_MULT : 1) * (S.boost ? KILL_BOOST : 1) * wmult(); moveCircle(S.grid, me, dx * PLAYER_SPEED * mu * dt, dy * PLAYER_SPEED * mu * dt, PLAYER_R); }
  if (rolling) { S.dashT -= dt; if (S.dashT <= 0) S.dashT = 0; }
  if (S.acc.dt >= (rolling ? 0.017 : 0.05)) flushInput(); // (while rolling, send every frame so others see the burst at once)
  return moveLen > 0;
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

function readout() { setText('ping', `${S.ping || 0} ms · ${S.fps || 0} fps · page ${BUILD} · server ${S.serverBuild || '?'} · my dashes ${S.dashSent || 0} · dash msgs from server ${S.ddCount || 0}${S.dxCount ? ' · server refused ' + S.dxCount + 'x (' + S.dxWhy + ')' : ''}`); }
function frame(now) {
  if (!S.loop) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - S.last) / 1000);
  S.last = now;
  S.fc = (S.fc || 0) + 1; if (!S.fT) S.fT = now;
  if (now - S.fT >= 500) { S.fps = Math.round((S.fc * 1000) / (now - S.fT)); S.fc = 0; S.fT = now; readout(); }
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
    const v = W3.ensurePlayer(id, color, info ? info.acc : 0, info ? info.fit : 0);
    const def = S.items[p[5]] || S.items.pistol;
    const gunCol = def ? def.color : '#ffffff';
    let x, y, a, mv;
    if (id === S.id) { x = me.vx; y = me.vy; a = me.a; mv = moving; }
    else {
      let q = interp('p', id) || [p[1], p[2], p[3]];
      // other players are drawn ~90ms in the past (smooth interpolation). A dash is different: the 'dd' message starts a scripted
      // dash on every screen at once (like a shot), then we ease back into the interpolated position.
      const sim = S.dashSim.get(id);
      if (sim) {
        const st = Math.min(dt, sim.left);
        moveCircle(S.grid, sim, sim.dx * PLAYER_SPEED * sim.mul * st, sim.dy * PLAYER_SPEED * sim.mul * st, PLAYER_R);
        sim.left -= dt;
        q = [sim.x, sim.y, q[2]];
        if (sim.left <= 0) { S.dashFade.set(id, { x: sim.x, y: sim.y, k: 1 }); S.dashSim.delete(id); }
      } else {
        const f = S.dashFade.get(id);
        if (f) { f.k -= dt * 4; if (f.k <= 0) S.dashFade.delete(id); else q = [lerp(q[0], f.x, f.k), lerp(q[1], f.y, f.k), q[2]]; }
      }
      const moved = Math.hypot(q[0] - (v.lx === undefined ? q[0] : v.lx), q[1] - (v.ly === undefined ? q[1] : v.ly));
      mv = moved > 0.004;
      v.lx = q[0]; v.ly = q[1]; x = q[0]; y = q[1]; a = q[2];
    }
    // our own aim is already smoothed in inputStep; other players are eased here so 20Hz snapshots never look steppy
    W3.updatePlayer(v, x, y, a, !!p[6], gunCol, dt, mv, id === S.id ? 0 : 16, !!p[10], !!(def && def.melee), id === S.id ? S.dashT > 0 : p[16] === 1, p[5]);
    if (id === S.id ? S.dashT > 0 : (p[16] === 1 || (v.rollTimer > 0))) { // dash: dust kicked up behind the roller, visible to everyone
      W3.burst(x - Math.cos(a) * 0.3, y - Math.sin(a) * 0.3, 0.15, '#d9d2c3', 2, 1.6, 0.2, 0.35);
    }
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

  // barricade placement preview
  if (S.building && (me.dead || !(me.walls > 0))) S.building = false;
  if (S.building) { const t = buildSpot(); W3.setBuildGhost(t.tx, t.ty, t.ok); if (!prompt) prompt = t.ok ? '[B] place barricade here  (Esc cancel)' : 'Blocked - aim at a free tile  (Esc cancel)'; } else W3.setBuildGhost(null);
  // nearest item prompt
  if (!me.dead && !prompt) {
    let best = null, bd = S.pickR * S.pickR;
    for (const g of S.groundList) { if (S.items[g[3]] && ['ammo', 'crate', 'turret', 'barricade', 'mine'].includes(S.items[g[3]].type)) continue; const d = (g[1] - me.vx) ** 2 + (g[2] - me.vy) ** 2; if (d < bd) { bd = d; best = g; } }
    if (best) { const def = S.items[best[3]]; if (def && def.type !== 'ammo') prompt = `[E] ${def.type === 'heal' || def.type === 'grenade' ? 'Pick up' : def.type === 'armor' ? 'Wear' : 'Equip'} ${def.name}${def.weight ? ` (${def.weight} kg, ${Math.round(weaponSpeed(def) * 100)}% speed)` : ''}`; }
  }
  if (!me.dead && !prompt && S.grid.doors.length) { // a door nearby
    let bi = -1, bd2 = 1.9 * 1.9;
    for (const i of S.grid.doors) { const d = ((i % S.grid.w) + 0.5 - me.vx) ** 2 + (Math.floor(i / S.grid.w) + 0.5 - me.vy) ** 2; if (d < bd2) { bd2 = d; bi = i; } }
    if (bi >= 0) prompt = `[E] ${S.grid.solid[bi] ? 'Open' : 'Close'} door`;
  }
  $('hidden-tag').style.display = !me.dead && S.mode === 'pvp' && inBush(S.grid, me.vx, me.vy) ? 'block' : 'none';
  const pr = $('prompt');
  if (prompt) { pr.style.display = 'block'; setText('prompt', prompt); } else pr.style.display = 'none';

  // camera
  let cx = me.vx, cy = me.vy;
  if (me.dead) {
    const alive = [...S.latest.p.values()].filter((p) => !p[6] && p[0] !== S.id);
    if (alive.length && !alive.some((p) => p[0] === S.spec)) S.spec = alive[0][0];
    const q = alive.length ? interp('p', S.spec) : null;
    if (q) { cx = q[0]; cy = q[1]; }
    const si = S.roster.find((r) => r.id === S.spec);
    S.specName = q && si ? si.name : '';
  }
  // camera panning: lean toward the mouse so you can see farther in the direction you aim (mouse aim only)
  if (!me.dead && !S.set.calm && S.set.pan > 0 && S.aimMode === 'mouse' && S.mouse.has) {
    const k = S.set.pan / 100;
    const dz = (n) => Math.sign(n) * Math.max(0, (Math.abs(n) - 0.12) / 0.88); // small dead zone in the middle of the screen
    cx += dz(clamp((S.mouse.x / (window.innerWidth || 1)) * 2 - 1, -1, 1)) * 7 * k;
    cy += dz(clamp((S.mouse.y / (window.innerHeight || 1)) * 2 - 1, -1, 1)) * 5.5 * k;
  }
  W3.followCamera(cx, cy, dt);
  W3.draw(dt, now / 1000);
  updateHud(me, myGrave);
}

function updateHud(me, myGrave) {
  const w = S.wave;
  if (S.mode === 'pvp') {
    if (S.teams) {
      const sc = [0, 0];
      for (const p of S.latest.hud) { const r = S.roster.find((q) => q.id === p[0]); if (r && r.team >= 0) sc[r.team] += p[8]; }
      setText('wave-title', `RED ${sc[0]}  -  ${sc[1]} BLUE`);
      setText('wave-sub', S.killLimit ? `Team deathmatch - first to ${S.killLimit} kills` : 'Team deathmatch - endless');
    } else {
      setText('wave-title', 'DEATHMATCH');
      setText('wave-sub', S.killLimit ? `First to ${S.killLimit} kills` : 'Endless - most kills wins bragging rights');
    }
  } else if (w.ph) { setText('wave-title', `WAVE ${w.n}${w.of ? ' / ' + w.of : ''}`); setText('wave-sub', `${w.left} zombies left`); }
  else if (w.n === 0) { setText('wave-title', `PREPARE  ${w.tm}s`); setText('wave-sub', 'Open crates, plant turrets [T], barricades [B], mines [N]'); }
  else { setText('wave-title', `WAVE ${w.n} CLEARED`); setText('wave-sub', `Next wave in ${w.tm}s - revive friends & grab loot`); }
  $('hp-fill').style.width = clamp(me.hp, 0, 100) + '%';
  $('armor-bar').style.display = me.armor > 0 ? 'block' : 'none';
  $('armor-fill').style.width = clamp(me.armor, 0, 100) + '%';
  $('stam-fill').style.width = clamp(S.stam, 0, STAM_MAX) + '%';
  $('stam-fill').classList.toggle('exh', S.stam < STAM_MAX - 1);
  setText('hp-text', String(Math.max(0, Math.round(me.hp))));
  const def = S.items[me.weapon] || S.items.pistol;
  setText('weapon-name', def ? def.name + (def.weight ? ` \u00b7 ${def.weight} kg` : '') : 'Pistol');
  const melee = !!(def && def.melee);
  setText('ammo-info', melee ? 'Melee - no ammo needed' : `Ammo ${me.ammo | 0}` + (def && def.heat ? (me.lock ? '  JAMMED - cooling' : `  Heat ${me.heat | 0}%`) : '') + (def && def.ammoCost ? `  (${def.ammoCost} per shell)` : ''));
  $('ammo-info').classList.toggle('low', !melee && (me.ammo | 0) <= 15);
  setText('bag-info', [me.bag ? `Heals x${me.bag} [H]` : '', me.nades ? `Grenades x${me.nades} [F]` : '', me.turrets ? `Turrets x${me.turrets} [T]` : '', me.walls ? `Barricades x${me.walls} [B]` : '', me.mines ? `Mines x${me.mines} [N]` : '', (me.turrets || me.walls || me.mines) ? '[X] remove' : ''].filter(Boolean).join('  '));
  // players list
  let html = '';
  const plist = [...S.latest.hud];
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
      ? `YOU WERE KILLED<span class="rs">${Math.max(1, me.rs || S.respawn)}</span><small>Respawning...<br>TAB / \u2190 \u2192 / click: watch another player</small><span class="spec">Watching: ${escapeHtml(S.specName || 'nobody left')}</span>`
      : `YOU DIED<small>A teammate must stand on your grave for ${S.revive}s to revive you${prog ? ` (${prog}/${S.revive}s)` : ''}.<br>TAB / \u2190 \u2192 / click: watch another player</small><span class="spec">Watching: ${escapeHtml(S.specName || 'nobody left')}</span>`;
    if (hudCache.db !== msg) { hudCache.db = msg; db.innerHTML = msg; }
  } else db.style.display = 'none';
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


const BUILD = 'b39'; // shown in the corner so you can check every window runs the same version
// ---------- settings (gear button, top right; on the menu, in the room lobby and in game) ----------
S.dashSim = new Map(); S.dashFade = new Map();
globalThis.__za = S; S.W3 = W3; S.blockedAt = (x, y) => blocked(S.grid, x, y, PLAYER_R); // (debug / tests)
S.set = { pan: 40, vol: 80, mute: false, calm: false, mouseWalk: false };
try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) S.set.calm = true; } catch (e) { /* ignore */ }
try { Object.assign(S.set, JSON.parse(localStorage.getItem('za-settings2') || '{}')); } catch (e) { /* ignore */ }
function saveSettings() { try { localStorage.setItem('za-settings2', JSON.stringify(S.set)); } catch (e) { /* ignore */ } }
function applySettings() {
  $('set-pan').value = S.set.pan; $('pan-val').textContent = S.set.pan + '%';
  $('set-vol').value = S.set.vol; $('vol-val').textContent = S.set.vol + '%';
  $('set-mute').checked = !!S.set.mute;
  $('set-calm').checked = !!S.set.calm; document.body.classList.toggle('calm', !!S.set.calm); W3.setCalm(S.set.calm);
  $('set-mousewalk').checked = !!S.set.mouseWalk;
  setVolume(S.set.vol / 100); setMuted(S.set.mute);
}
function toggleSettings(force) {
  const p = $('settings-panel');
  const next = force === undefined ? p.style.display === 'none' : !!force;
  p.style.display = next ? 'flex' : 'none';
  if (!next) cancelRebind();
  if (next) {
    $('btn-end-game').classList.toggle('on', !!(S.room && S.room.host === S.id));
    renderBinds();
    for (const k in keys) keys[k] = false;
  }
}
$('settings-btn').onclick = () => toggleSettings();
$('settings-btn').onmousedown = (e) => e.preventDefault(); // keep keyboard focus off the button so Space still shoots
$('set-close').onclick = () => toggleSettings(false);
$('set-pan').oninput = () => { S.set.pan = Number($('set-pan').value); applySettings(); saveSettings(); };
$('set-vol').oninput = () => { S.set.vol = Number($('set-vol').value); applySettings(); saveSettings(); };
$('set-pan').onchange = $('set-vol').onchange = () => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); };
$('set-calm').onchange = () => { S.set.calm = $('set-calm').checked; applySettings(); saveSettings(); $('set-calm').blur(); };
$('set-mute').onchange = () => { S.set.mute = $('set-mute').checked; applySettings(); saveSettings(); $('set-mute').blur(); };
$('set-mousewalk').onchange = () => {
  S.set.mouseWalk = $('set-mousewalk').checked; applySettings(); saveSettings(); $('set-mousewalk').blur();
  toast(S.set.mouseWalk ? 'Walk toward mouse: on' : 'Walk toward mouse: off');
};
$('btn-leave-game').onclick = () => { toggleSettings(false); send({ t: 'leave' }); };
$('btn-end-game').onclick = () => { toggleSettings(false); send({ t: 'endgame' }); };
$('bind-reset').onclick = () => {
  S.binds = { ...DEFAULT_BINDS }; saveBinds(); cancelRebind(); renderBinds(); updateHelpKeys(); toast('Keys reset to default');
};
applySettings();
renderBinds();
updateHelpKeys();

// go
setScreen('menu');
connect();
