'use strict';
// Peaceful office mode: roles, mini-game tasks (random difficulty), meetings, AI staff.

const SPRINT_SEC = 150;
const SPRINTS_WIN = 5;
const SEED_CASH = 5000;
const RENT_BASE = 400;
const RENT_PER_FURN = 50;

const ROLES = {
  ceo: { id: 'ceo', name: 'CEO', pay: 200, start: 100, tasks: ['meeting', 'budget', 'standup'] },
  dev: { id: 'dev', name: 'Dev', pay: 150, start: 50, tasks: ['code', 'bug', 'standup'] },
  tester: { id: 'tester', name: 'Tester', pay: 140, start: 50, tasks: ['qa', 'standup'] },
  hr: { id: 'hr', name: 'HR', pay: 130, start: 50, tasks: ['morale', 'hire', 'standup'] },
  intern: { id: 'intern', name: 'Intern', pay: 80, start: 20, tasks: ['coffee', 'mail', 'standup'] },
};

// station = map marker kind; game = mini-game type
const TASKS = {
  code: { name: 'Write code', station: 'desk', games: ['sequence', 'tap'], base: 55 },
  bug: { name: 'Fix bug', station: 'desk', games: ['timing', 'match'], base: 50 },
  qa: { name: 'Run QA', station: 'qa', games: ['match', 'tap'], base: 48 },
  budget: { name: 'Approve budget', station: 'ceo', games: ['timing', 'match'], base: 60 },
  morale: { name: '1:1 chat', station: 'hr', games: ['sequence', 'tap'], base: 42 },
  hire: { name: 'Post job listing', station: 'hr', games: ['match', 'timing'], base: 40 },
  coffee: { name: 'Fetch coffee', station: 'kitchen', games: ['tap', 'timing'], base: 28 },
  mail: { name: 'Deliver mail', station: 'mail', games: ['sequence', 'tap'], base: 30 },
  meeting: { name: 'Board meeting', station: 'meeting', games: ['meeting'], base: 80, meeting: true },
  standup: { name: 'Standup meeting', station: 'meeting', games: ['meeting'], base: 45, meeting: true },
};

const DIFFS = {
  easy: { mult: 0.85, pay: 0.9, label: 'Easy' },
  normal: { mult: 1, pay: 1, label: 'Normal' },
  hard: { mult: 1.25, pay: 1.35, label: 'Hard' },
};

const SHOP = [
  { id: 'desk', name: 'Desk', cost: 200 },
  { id: 'pc', name: 'Computer', cost: 350 },
  { id: 'plant', name: 'Plant', cost: 80 },
  { id: 'couch', name: 'Couch', cost: 150 },
];

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'Space'];

function roleList() {
  return Object.values(ROLES).map((r) => ({ id: r.id, name: r.name, pay: r.pay }));
}
function catalog() {
  return SHOP.map((s) => ({ ...s }));
}
function randDiff() {
  const r = Math.random();
  return r < 0.4 ? 'easy' : r < 0.75 ? 'normal' : 'hard';
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildMinigame(kind, difficulty) {
  const d = DIFFS[difficulty] || DIFFS.normal;
  const id = Math.random().toString(36).slice(2, 9);
  if (kind === 'tap') {
    const need = Math.round((difficulty === 'hard' ? 12 : difficulty === 'easy' ? 6 : 8) * d.mult);
    return { id, kind: 'tap', difficulty, need, secs: Math.round(5 / d.mult * 10) / 10, prompt: 'Mash Space / click ' + need + ' times!' };
  }
  if (kind === 'sequence') {
    const n = difficulty === 'hard' ? 5 : difficulty === 'easy' ? 3 : 4;
    const seq = [];
    for (let i = 0; i < n; i++) seq.push(pick(KEYS));
    return { id, kind: 'sequence', difficulty, seq, secs: Math.round((4 + n) / d.mult * 10) / 10, prompt: 'Press the keys in order' };
  }
  if (kind === 'timing') {
    const window = difficulty === 'hard' ? 0.12 : difficulty === 'easy' ? 0.28 : 0.18;
    const target = 0.35 + Math.random() * 0.35;
    return { id, kind: 'timing', difficulty, target, window, secs: Math.round(4.5 / d.mult * 10) / 10, prompt: 'Press Space when the bar is green' };
  }
  if (kind === 'match') {
    const opts = ['Ship it', 'LGTM', 'Needs work', 'Blocker', 'Nice catch', 'Refactor'];
    const answer = pick(opts);
    const choices = [answer];
    while (choices.length < 3) {
      const o = pick(opts);
      if (!choices.includes(o)) choices.push(o);
    }
    // shuffle
    for (let i = choices.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [choices[i], choices[j]] = [choices[j], choices[i]]; }
    return { id, kind: 'match', difficulty, answer, choices, secs: Math.round(6 / d.mult * 10) / 10, prompt: 'Pick: "' + answer + '"' };
  }
  // meeting: everyone in the meeting room must press Space when the countdown hits GO
  return { id, kind: 'meeting', difficulty, secs: Math.round(7 / d.mult * 10) / 10, goAt: 3.2, window: difficulty === 'hard' ? 0.35 : 0.55, prompt: 'When it says GO, everyone press Space!' };
}

function attachOffice(room) {
  room.company = SEED_CASH;
  room.sprintN = 1;
  room.sprintLeft = SPRINT_SEC;
  room.furniture = [];
  room.furnSeq = 1;
  room.officeStations = (room.map.stations || []).map((s) => ({ ...s }));
  room.officeShop = room.map.shop || null;
  room.mg = null; // active shared meeting mini-game
  for (const p of room.players.values()) initPlayerOffice(room, p);
}

function initPlayerOffice(room, p) {
  const role = ROLES[p.role] || ROLES.intern;
  p.role = role.id;
  // seed starting cash once per role assignment (join sets cash:0 before role is known)
  if (!p._officePaid) { p.cash = role.start; p._officePaid = true; }
  p.task = null;
  p.mg = null; // personal mini-game in progress
  p.shoot = false;
}

function setRole(room, p, roleId) {
  if (room.state !== 'lobby') return 'Game already started';
  const role = ROLES[roleId];
  if (!role) return 'Unknown role';
  if (roleId === 'ceo') {
    for (const q of room.players.values()) if (q !== p && q.role === 'ceo') return 'CEO seat is taken';
  }
  p.role = roleId;
  p.cash = role.start;
  p._officePaid = true;
  return null;
}

function nearestStation(room, p, kinds) {
  let best = null, bd = 1.7 * 1.7;
  for (const s of room.officeStations) {
    if (kinds && !kinds.includes(s.kind)) continue;
    const d = (s.x + 0.5 - p.x) ** 2 + (s.y + 0.5 - p.y) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function inMeetingRoom(room, p) {
  return !!nearestStation(room, p, ['meeting']);
}

function nearShop(room, p) {
  const s = room.officeShop;
  if (!s) return false;
  return (s.x + 0.5 - p.x) ** 2 + (s.y + 0.5 - p.y) ** 2 < 2.2 * 2.2;
}

function playersInMeeting(room) {
  return [...room.players.values()].filter((q) => !q.dead && inMeetingRoom(room, q));
}

function startPersonalGame(room, p, taskKey) {
  const def = TASKS[taskKey];
  if (!def) return 'Bad task';
  const difficulty = randDiff();
  const gameKind = pick(def.games);
  const mg = buildMinigame(gameKind, difficulty);
  const gear = 1 + Math.min(0.4, room.furniture.filter((f) => f.kind === 'pc' || f.kind === 'desk').length * 0.05);
  const pay = Math.round(def.base * DIFFS[difficulty].pay * gear);
  p.mg = { ...mg, taskKey, name: def.name, pay, started: Date.now(), deadline: Date.now() + mg.secs * 1000 };
  if (p.conn && !p.bot) {
    p.conn.send({
      t: 'minigame',
      id: mg.id, kind: mg.kind, difficulty, name: def.name, pay, secs: mg.secs,
      prompt: mg.prompt, need: mg.need, seq: mg.seq, target: mg.target, window: mg.window,
      choices: mg.choices, answer: undefined, goAt: mg.goAt,
    });
  }
  return null;
}

function startMeeting(room, p) {
  const present = playersInMeeting(room);
  if (present.length < 2) return 'Need at least 2 people in the Meeting Room';
  if (room.mg) return 'A meeting is already running';
  const taskKey = (ROLES[p.role] || ROLES.intern).tasks.find((t) => TASKS[t] && TASKS[t].meeting) || 'standup';
  const def = TASKS[taskKey];
  const difficulty = randDiff();
  const mg = buildMinigame('meeting', difficulty);
  const pay = Math.round(def.base * DIFFS[difficulty].pay);
  room.mg = {
    ...mg, taskKey, name: def.name, pay, started: Date.now(), deadline: Date.now() + mg.secs * 1000,
    members: present.map((q) => q.id), hits: new Set(),
  };
  for (const q of present) {
    q.mg = { id: mg.id, shared: true };
    if (q.conn && !q.bot) {
      q.conn.send({
        t: 'minigame', id: mg.id, kind: 'meeting', difficulty, name: def.name, pay, secs: mg.secs,
        prompt: mg.prompt + ' (' + present.length + ' people)', goAt: mg.goAt, window: mg.window,
      });
    }
  }
  room.broadcast({ t: 'toast', text: def.name + ' started in the Meeting Room (' + DIFFS[difficulty].label + ')' });
  return null;
}

function tryStartTask(room, p) {
  if (p.mg || (room.mg && room.mg.members.includes(p.id))) return 'Finish your current task first';
  const role = ROLES[p.role] || ROLES.intern;
  const st = nearestStation(room, p, null);
  if (!st) return 'Stand near a work station or Meeting Room';

  if (st.kind === 'meeting') return startMeeting(room, p);

  const taskKey = role.tasks.find((t) => TASKS[t] && !TASKS[t].meeting && TASKS[t].station === st.kind);
  if (!taskKey) return 'Wrong station for ' + role.name + ' (try a matching desk / room)';
  return startPersonalGame(room, p, taskKey);
}

function finishPersonal(room, p, ok) {
  const mg = p.mg;
  if (!mg || mg.shared) return;
  p.mg = null;
  if (!ok) {
    if (p.conn && !p.bot) p.conn.send({ t: 'toast', text: 'Task failed — try again' });
    pushOffice(room);
    return;
  }
  p.cash = (p.cash | 0) + mg.pay;
  if (p.conn && !p.bot) p.conn.send({ t: 'toast', text: mg.name + ' done! +$' + mg.pay + ' (you have $' + p.cash + ')' });
  pushOffice(room);
}

function minigameDone(room, p, msg) {
  const id = String(msg.id || '');
  // shared meeting
  if (room.mg && room.mg.id === id) {
    if (!room.mg.members.includes(p.id)) return;
    const elapsed = (Date.now() - room.mg.started) / 1000;
    const go = room.mg.goAt || 3.2;
    const win = room.mg.window || 0.5;
    const ok = !!msg.ok && Math.abs(elapsed - go) <= win;
    if (ok) room.mg.hits.add(p.id);
    // bots auto-succeed near GO
    for (const q of room.players.values()) {
      if (!q.bot || !room.mg.members.includes(q.id) || room.mg.hits.has(q.id)) continue;
      if (Math.abs(elapsed - go) <= win) room.mg.hits.add(q.id);
    }
    if (room.mg.hits.size >= Math.ceil(room.mg.members.length * 0.6) || elapsed > room.mg.secs) {
      endMeeting(room, room.mg.hits.size >= Math.ceil(room.mg.members.length * 0.6));
    }
    return;
  }
  if (!p.mg || p.mg.id !== id) return;
  const elapsed = (Date.now() - p.mg.started) / 1000;
  if (elapsed > p.mg.secs + 1.5) { finishPersonal(room, p, false); return; }
  let ok = !!msg.ok;
  if (p.mg.kind === 'tap') ok = ok && Number(msg.taps) >= p.mg.need;
  if (p.mg.kind === 'sequence') ok = ok && Array.isArray(msg.seq) && msg.seq.join() === (p.mg.seq || []).join();
  if (p.mg.kind === 'timing') {
    const t = Number(msg.at);
    ok = Number.isFinite(t) && Math.abs(t - p.mg.target) <= p.mg.window;
  }
  if (p.mg.kind === 'match') ok = ok && String(msg.choice) === p.mg.answer;
  finishPersonal(room, p, ok);
}

function endMeeting(room, ok) {
  const mg = room.mg;
  if (!mg) return;
  for (const id of mg.members) {
    const q = room.players.get(id);
    if (!q) continue;
    q.mg = null;
    if (ok) {
      q.cash = (q.cash | 0) + mg.pay;
      if (q.conn && !q.bot) q.conn.send({ t: 'toast', text: mg.name + ' success! +$' + mg.pay });
    } else if (q.conn && !q.bot) q.conn.send({ t: 'toast', text: mg.name + ' flopped' });
    if (q.conn && !q.bot) q.conn.send({ t: 'minigame_end', id: mg.id, ok: ok ? 1 : 0 });
  }
  room.broadcast({ t: 'toast', text: ok ? 'Meeting succeeded!' : 'Meeting failed — try again with more people' });
  room.mg = null;
  pushOffice(room);
}

function tryBuy(room, p, itemId, useCompany) {
  const item = SHOP.find((s) => s.id === itemId);
  if (!item) return 'Unknown item';
  if (useCompany) {
    if (p.role !== 'ceo') return 'Only the CEO can spend company money';
    if (room.company < item.cost) return 'Company is short on cash';
    room.company -= item.cost;
  } else {
    if ((p.cash | 0) < item.cost) return 'Not enough personal cash';
    p.cash -= item.cost;
  }
  const spot = placeSpot(room, p);
  room.furniture.push({ id: room.furnSeq++, kind: item.id, x: spot.x, y: spot.y });
  room.broadcast({ t: 'toast', text: p.name + ' bought a ' + item.name });
  pushOffice(room);
  return null;
}

function placeSpot(room, p) {
  const slots = room.map.furnSlots || [];
  for (const s of slots) {
    if (!room.furniture.some((f) => Math.floor(f.x) === s.x && Math.floor(f.y) === s.y)) {
      return { x: s.x + 0.5, y: s.y + 0.5 };
    }
  }
  return { x: p.x + Math.cos(p.a || 0), y: p.y + Math.sin(p.a || 0) };
}

function interact(room, p) {
  if (nearShop(room, p)) {
    if (p.conn && !p.bot) p.conn.send({ t: 'office_shop', items: catalog(), company: p.role === 'ceo' });
    return null;
  }
  return tryStartTask(room, p);
}

function tickOffice(room, dt) {
  if (room.state !== 'playing' || room.mode !== 'office') return;

  // expire personal mini-games
  for (const p of room.players.values()) {
    if (p.bot) botStaff(room, p, dt);
    if (p.mg && !p.mg.shared && Date.now() > p.mg.deadline) {
      if (p.conn && !p.bot) p.conn.send({ t: 'minigame_end', id: p.mg.id, ok: 0 });
      finishPersonal(room, p, false);
    }
  }
  // expire / auto-resolve meeting
  if (room.mg && Date.now() > room.mg.deadline) {
    endMeeting(room, room.mg.hits.size >= Math.ceil(room.mg.members.length * 0.6));
  } else if (room.mg) {
    const elapsed = (Date.now() - room.mg.started) / 1000;
    const go = room.mg.goAt || 3.2;
    const win = room.mg.window || 0.5;
    if (elapsed >= go - 0.05) {
      for (const q of room.players.values()) {
        if (q.bot && room.mg.members.includes(q.id)) room.mg.hits.add(q.id);
      }
      if (room.mg.hits.size >= room.mg.members.length) endMeeting(room, true);
    }
    if (elapsed > go + win + 0.8 && room.mg) {
      endMeeting(room, room.mg.hits.size >= Math.ceil(room.mg.members.length * 0.6));
    }
  }

  room.sprintLeft -= dt;
  if (room.sprintLeft <= 0) payroll(room);
}

function payroll(room) {
  let salaries = 0;
  for (const p of room.players.values()) {
    const role = ROLES[p.role] || ROLES.intern;
    salaries += role.pay;
    p.mg = null; p.task = null;
  }
  room.mg = null;
  const rent = RENT_BASE + room.furniture.length * RENT_PER_FURN;
  room.company -= salaries + rent;
  const msg = `Sprint ${room.sprintN} payroll: -$${salaries} salaries, -$${rent} rent. Company: $${room.company}`;
  room.say(msg);
  room.broadcast({ t: 'toast', text: msg });
  if (room.company < 0) { room.end('bankrupt'); pushOffice(room); return; }
  if (room.sprintN >= SPRINTS_WIN) { room.end('office_win'); pushOffice(room); return; }
  room.sprintN += 1;
  room.sprintLeft = SPRINT_SEC;
  pushOffice(room);
}

function botStaff(room, p, dt) {
  if (!p.ai) p.ai = { path: [], pathT: 0, shopT: 0 };
  const role = ROLES[p.role] || ROLES.intern;
  // finish bot auto tasks first
  if (p.mg && p.mg.botAuto) {
    if (Date.now() > p.mg.started + 1600) {
      p.cash = (p.cash | 0) + p.mg.pay;
      p.mg = null;
    }
    return;
  }
  if (p.mg || (room.mg && room.mg.members.includes(p.id))) return;
  const ai = p.ai;
  ai.pathT = (ai.pathT || 0) - dt;
  ai.shopT = (ai.shopT || 0) - dt;

  // AI CEO: occasionally buy a cheap plant/desk with company cash if vault is healthy
  if (role.id === 'ceo' && ai.shopT <= 0 && room.company > 2200 && Math.random() < 0.004) {
    const cheap = SHOP.filter((s) => s.cost <= 200 && room.company - s.cost >= 1500);
    if (cheap.length && nearShop(room, p)) {
      tryBuy(room, p, pick(cheap).id, true);
      ai.shopT = 25;
      return;
    }
    if (cheap.length && room.officeShop) {
      goalWalk(room, p, room.officeShop.x + 0.5, room.officeShop.y + 0.5, ai);
      return;
    }
  }

  // CEO prefers starting meetings when 1+ others are already in the room; others join meetings
  const inMeet = playersInMeeting(room).length;
  const meetChance = role.id === 'ceo' ? 0.008 : 0.003;
  if (Math.random() < meetChance && (role.id === 'ceo' ? inMeet >= 1 : inMeet >= 1)) {
    const meet = room.officeStations.find((s) => s.kind === 'meeting');
    if (meet) {
      goalWalk(room, p, meet.x + 0.5, meet.y + 0.5, ai);
      if ((meet.x + 0.5 - p.x) ** 2 + (meet.y + 0.5 - p.y) ** 2 < 1.4) tryStartTask(room, p);
      return;
    }
  }

  const kinds = role.tasks.filter((t) => TASKS[t] && !TASKS[t].meeting).map((t) => TASKS[t].station);
  let goal = nearestStation(room, p, kinds);
  if (!goal) {
    const pool = room.officeStations.filter((s) => kinds.includes(s.kind));
    if (!pool.length) return;
    goal = pool[Math.floor(Math.random() * pool.length)];
  }
  if ((goal.x + 0.5 - p.x) ** 2 + (goal.y + 0.5 - p.y) ** 2 < 1.3) {
    const taskKey = role.tasks.find((t) => TASKS[t] && TASKS[t].station === goal.kind);
    if (!taskKey) return;
    const def = TASKS[taskKey];
    const difficulty = randDiff();
    const pay = Math.round(def.base * DIFFS[difficulty].pay);
    p.mg = { id: 'bot', shared: false, pay, name: def.name, started: Date.now(), deadline: Date.now() + 1800, botAuto: true };
    return;
  }
  goalWalk(room, p, goal.x + 0.5, goal.y + 0.5, ai);
}

function goalWalk(room, p, gx, gy, ai) {
  if (ai.pathT <= 0 || !ai.path.length) {
    ai.path = room.bfs(Math.floor(p.x), Math.floor(p.y), Math.floor(gx), Math.floor(gy));
    ai.pathT = 0.7;
  }
  while (ai.path.length > 1 && Math.hypot(ai.path[0][0] - p.x, ai.path[0][1] - p.y) < 0.5) ai.path.shift();
  const wp = ai.path[0];
  if (!wp) return;
  const mx = wp[0] - p.x, my = wp[1] - p.y;
  const len = Math.hypot(mx, my);
  if (len > 0.01) {
    const sp = 3.2 * (1 / 20) * 0.8;
    room.move(p, (mx / len) * sp, (my / len) * sp, 0.32);
    p.a = Math.atan2(my, mx);
  }
}

function officeState(room, forPlayer) {
  return {
    t: 'office',
    company: room.company,
    sprint: room.sprintN,
    of: SPRINTS_WIN,
    left: Math.ceil(Math.max(0, room.sprintLeft)),
    furniture: room.furniture,
    stations: room.officeStations,
    shop: room.officeShop,
    roles: roleList(),
    catalog: catalog(),
    you: forPlayer ? {
      role: forPlayer.role,
      cash: forPlayer.cash | 0,
      busy: !!(forPlayer.mg || (room.mg && room.mg.members && room.mg.members.includes(forPlayer.id))),
    } : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, role: p.role, cash: p.cash | 0, bot: p.bot ? 1 : 0,
    })),
  };
}

function pushOffice(room) {
  for (const p of room.players.values()) {
    if (p.bot) continue;
    p.conn.send(officeState(room, p));
  }
}

module.exports = {
  ROLES, TASKS, SHOP, SPRINT_SEC, SPRINTS_WIN, SEED_CASH, DIFFS,
  roleList, catalog, attachOffice, initPlayerOffice, setRole,
  interact, tryBuy, tickOffice, pushOffice, officeState, minigameDone,
};
