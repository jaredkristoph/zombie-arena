// Admin: map editor + item creator. Talks to the server's REST API.
(function () {
  const $ = (id) => document.getElementById(id);
  const cfg = (window.GAME_CONFIG && window.GAME_CONFIG.server) || '';
  const BASE = cfg ? cfg.replace(/\/+$/, '').replace(/^ws/, 'http') : '';
  let key = sessionStorage.getItem('za-admin') || '';
  let maps = [], items = [], cur = null, tool = '#', painting = false;
  const CELL = 18;

  async function api(method, path, body, auth) {
    const res = await fetch(BASE + path, {
      method, headers: Object.assign({ 'content-type': 'application/json' }, auth ? { 'x-admin-key': key } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  }
  function say(id, text, ok) { const e = $(id); e.textContent = text; e.className = 'msg ' + (ok ? 'ok' : 'err'); }

  // ---------- login ----------
  async function login() {
    key = $('pw').value || key;
    try {
      await api('GET', '/api/admin/check', null, true);
      sessionStorage.setItem('za-admin', key);
      $('login').style.display = 'none'; $('app').style.display = 'block';
      await reload();
    } catch (e) { say('login-msg', e.message); }
  }
  $('btn-login').onclick = login;
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  if (key) { $('pw').value = key; login(); }

  async function reload() {
    maps = await api('GET', '/api/maps');
    items = await api('GET', '/api/items');
    renderMapList(); renderItems(); fillItemPicker();
    if (!cur || !maps.some((m) => m.id === cur.id)) selectMap(maps[0]);
  }

  // ---------- tabs ----------
  function tab(name) {
    $('pane-maps').style.display = name === 'maps' ? 'block' : 'none';
    $('pane-items').style.display = name === 'items' ? 'block' : 'none';
    $('tab-maps').className = name === 'maps' ? 'on' : 'ghost';
    $('tab-items').className = name === 'items' ? 'on' : 'ghost';
  }
  $('tab-maps').onclick = () => tab('maps'); $('tab-items').onclick = () => tab('items');

  // ---------- map editor ----------
  const TOOLS = [
    ['.', 'Floor / erase'], ['#', 'Wall'], ['c', 'Crate'], ['P', 'Player spawn'], ['Z', 'Zombie spawn'], ['I', 'Item spawn'],
  ];
  const tb = $('tools');
  TOOLS.forEach(([k, label]) => {
    const b = document.createElement('button'); b.textContent = label; b.dataset.k = k;
    b.onclick = () => { tool = k; [...tb.children].forEach((c) => c.classList.toggle('on', c.dataset.k === k)); $('item-pick').style.display = k === 'I' ? 'block' : 'none'; };
    tb.appendChild(b);
  });
  tb.children[1].classList.add('on');

  function blankMap(w, h) {
    const tiles = [];
    for (let y = 0; y < h; y++) tiles.push(y === 0 || y === h - 1 ? '#'.repeat(w) : '#' + '.'.repeat(w - 2) + '#');
    return { id: undefined, name: 'New Map', w, h, tiles, playerSpawns: [{ x: 2, y: 2 }], zombieSpawns: [{ x: w - 3, y: h - 3 }], itemSpawns: [] };
  }
  function selectMap(m) {
    cur = JSON.parse(JSON.stringify(m));
    cur.tiles = cur.tiles.map((r) => r.split(''));
    $('m-name').value = cur.name; $('m-w').value = cur.w; $('m-h').value = cur.h;
    renderMapList(); drawMap(); say('m-msg', '', true);
  }
  function renderMapList() {
    const box = $('maplist'); box.innerHTML = '';
    maps.forEach((m) => {
      const r = document.createElement('div'); r.className = 'mrow';
      const s = document.createElement('span'); s.textContent = m.name; s.className = cur && cur.id === m.id ? 'sel' : '';
      s.onclick = () => selectMap(m);
      r.appendChild(s); box.appendChild(r);
    });
  }
  $('m-new').onclick = () => { selectMap(blankMap(32, 32)); };
  $('m-dup').onclick = () => { if (!cur) return; cur.id = undefined; cur.name = (cur.name + ' copy').slice(0, 24); $('m-name').value = cur.name; say('m-msg', 'Duplicated - press Save to keep the copy.', true); renderMapList(); };

  function resizeMap() {
    const w = Math.min(64, Math.max(16, Number($('m-w').value) | 0)), h = Math.min(64, Math.max(16, Number($('m-h').value) | 0));
    if (w === cur.w && h === cur.h) return;
    const t = [];
    for (let y = 0; y < h; y++) { const row = []; for (let x = 0; x < w; x++) row.push(y < cur.h && x < cur.w ? cur.tiles[y][x] : '.'); t.push(row); }
    cur.tiles = t; cur.w = w; cur.h = h;
    const keep = (a) => a.filter((p) => p.x < w - 1 && p.y < h - 1);
    cur.playerSpawns = keep(cur.playerSpawns); cur.zombieSpawns = keep(cur.zombieSpawns); cur.itemSpawns = keep(cur.itemSpawns);
    drawMap();
  }
  $('m-w').onchange = $('m-h').onchange = resizeMap;

  const cv = $('cv'), ctx = cv.getContext('2d');
  function drawMap() {
    if (!cur) return;
    cv.width = cur.w * CELL; cv.height = cur.h * CELL;
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) {
      const c = cur.tiles[y][x];
      ctx.fillStyle = c === '#' ? '#8b7aa8' : c === 'c' ? '#b9854a' : (x + y) % 2 ? '#52704a' : '#4b6643';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      if (c === 'c') { ctx.fillStyle = '#e0aa6a'; ctx.fillRect(x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6); }
    }
    const dot = (p, col, ch) => {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x * CELL + CELL / 2, p.y * CELL + CELL / 2, CELL / 2 - 2, 0, 7); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ch, p.x * CELL + CELL / 2, p.y * CELL + CELL / 2 + 1);
    };
    cur.playerSpawns.forEach((p) => dot(p, '#4cc9f0', 'P'));
    cur.zombieSpawns.forEach((p) => dot(p, '#ff4d6d', 'Z'));
    cur.itemSpawns.forEach((p) => dot(p, '#ffd166', 'I'));
  }
  function paint(e) {
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * cur.w), y = Math.floor(((e.clientY - r.top) / r.height) * cur.h);
    if (x < 1 || y < 1 || x > cur.w - 2 || y > cur.h - 2) return;
    const same = (p) => p.x === x && p.y === y;
    const clearPoint = () => {
      cur.playerSpawns = cur.playerSpawns.filter((p) => !same(p));
      cur.zombieSpawns = cur.zombieSpawns.filter((p) => !same(p));
      cur.itemSpawns = cur.itemSpawns.filter((p) => !same(p));
    };
    if (tool === '#' || tool === 'c') { clearPoint(); cur.tiles[y][x] = tool; }
    else if (tool === '.') { clearPoint(); cur.tiles[y][x] = '.'; }
    else {
      if (cur.tiles[y][x] !== '.') cur.tiles[y][x] = '.';
      clearPoint();
      if (tool === 'P') cur.playerSpawns.push({ x, y });
      else if (tool === 'Z') cur.zombieSpawns.push({ x, y });
      else cur.itemSpawns.push({ x, y, item: $('m-item').value || 'random' });
    }
    drawMap();
  }
  cv.addEventListener('pointerdown', (e) => { painting = true; cv.setPointerCapture(e.pointerId); paint(e); });
  cv.addEventListener('pointermove', (e) => { if (painting) paint(e); });
  cv.addEventListener('pointerup', () => { painting = false; });

  function fillItemPicker() {
    const sel = $('m-item'); sel.innerHTML = '';
    const r = document.createElement('option'); r.value = 'random'; r.textContent = 'Random item'; sel.appendChild(r);
    items.filter((i) => i.id !== 'pistol').forEach((i) => { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name; sel.appendChild(o); });
  }
  $('m-save').onclick = async () => {
    try {
      resizeMap();
      const body = Object.assign({}, cur, { name: $('m-name').value, tiles: cur.tiles.map((r) => r.join('')) });
      const saved = await api('PUT', '/api/admin/maps', body, true);
      cur.id = saved.id;
      await reload();
      selectMap(maps.find((m) => m.id === saved.id) || saved);
      say('m-msg', 'Saved! New rooms will use the updated map.', true);
    } catch (e) { say('m-msg', e.message); }
  };
  $('m-del').onclick = async () => {
    if (!cur || !cur.id || !confirm('Delete map "' + cur.name + '"?')) return;
    try { await api('DELETE', '/api/admin/maps/' + cur.id, null, true); cur = null; await reload(); say('m-msg', 'Deleted.', true); } catch (e) { say('m-msg', e.message); }
  };

  // ---------- items ----------
  function syncType() {
    const heal = $('i-type').value === 'heal';
    document.querySelectorAll('.w').forEach((e) => { e.style.display = heal ? 'none' : 'block'; });
    document.querySelectorAll('.h').forEach((e) => { e.style.display = heal ? 'block' : 'none'; });
  }
  $('i-type').onchange = syncType;
  let editId = null;
  function renderItems() {
    const t = $('itemtable'); t.innerHTML = '';
    items.forEach((i) => {
      const r = document.createElement('tr');
      const n = document.createElement('td'); const d = document.createElement('span'); d.className = 'dot'; d.style.background = i.color;
      n.append(d, document.createTextNode(i.name));
      const s = document.createElement('td');
      s.textContent = i.type === 'heal' ? 'Heals ' + i.heal : `${i.damage} dmg x${i.pellets} · ${i.rate}/s · range ${i.range}` + (i.pierce ? ' · pierce ' + i.pierce : '');
      const a = document.createElement('td'); a.style.textAlign = 'right';
      const e = document.createElement('button'); e.textContent = 'Edit'; e.className = 'ghost'; e.style.padding = '4px 10px';
      e.onclick = () => editItem(i);
      a.appendChild(e);
      if (i.id !== 'pistol') {
        const x = document.createElement('button'); x.textContent = 'Delete'; x.className = 'ghost'; x.style.cssText = 'padding:4px 10px;margin-left:6px';
        x.onclick = async () => { if (!confirm('Delete ' + i.name + '?')) return; try { await api('DELETE', '/api/admin/items/' + i.id, null, true); await reload(); } catch (err) { say('i-msg', err.message); } };
        a.appendChild(x);
      }
      r.append(n, s, a); t.appendChild(r);
    });
  }
  function editItem(i) {
    editId = i.id; $('if-title').textContent = 'Edit item: ' + i.name;
    $('i-name').value = i.name; $('i-type').value = i.type; $('i-color').value = i.color;
    for (const k of ['damage', 'rate', 'range', 'pellets', 'spread', 'pierce', 'heal']) if (i[k] !== undefined) $('i-' + k).value = i[k];
    syncType();
  }
  $('i-clear').onclick = () => { editId = null; $('if-title').textContent = 'New item'; $('i-name').value = ''; $('i-type').value = 'weapon'; syncType(); say('i-msg', '', true); };
  $('i-save').onclick = async () => {
    const heal = $('i-type').value === 'heal';
    const body = { id: editId || undefined, name: $('i-name').value, type: $('i-type').value, color: $('i-color').value };
    if (heal) body.heal = Number($('i-heal').value);
    else for (const k of ['damage', 'rate', 'range', 'pellets', 'spread', 'pierce']) body[k] = Number($('i-' + k).value);
    try { await api('PUT', '/api/admin/items', body, true); await reload(); $('i-clear').onclick(); say('i-msg', 'Item saved. It can now drop from zombies and appear on item spawns.', true); } catch (e) { say('i-msg', e.message); }
  };
  syncType();
})();
