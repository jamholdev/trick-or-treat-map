import { firebaseConfig, NEIGHBORHOOD } from './config.js';

const CANDY_LEVELS = ['', 'Raisins & toothbrushes', 'Fun-size mix', 'The good stuff', 'Premium picks', 'FULL-SIZE BARS 👑'];
const TAGS = {
  decor: '🦇 Spooky decorations',
  haunt: '👻 Haunted yard / scare zone',
  teal: '🩵 Teal pumpkin (allergy-friendly treats)',
};
const COLORS = { none: '#5b5b6b', yes: '#ff7518', no: '#3a3150' };
const BOUNDS = L.latLngBounds(NEIGHBORHOOD.bounds);
const ADMIN_URL = new URLSearchParams(location.search).has('admin');

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = n => Math.min(5, Math.max(1, Math.round(Number(n) || 0)));
const candies = n => { n = clamp(n); return '🍬'.repeat(n) + `<span class="dim">${'🍬'.repeat(5 - n)}</span>`; };
const fail = e => alert('Oops: ' + (e?.message || e));
const isPermission = e => /permission/i.test(e?.message || e?.code || '');
const ago = t => {
  if (typeof t !== 'number') return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`;
};

let store = null;
let isAdmin = false;
let houses = {};      // id -> {lat,lng,addr,status,candy,tags,note,owner,t}
let ratings = {};     // houseId -> {uid: 1..5}
let reportsFor = {};  // houseId -> {uid: {note,t}} (my houses, or all houses for admins)
let myReports = {};   // houseId -> my own report on someone else's house, or null
let current = null;   // house the sheet is showing
let mode = 'view';    // view | confirm | edit | report | move | move-confirm
let moveFrom = null;  // house id being moved while mode is move/move-confirm
let mineIdx = 0;
const footprints = {}; // id -> {id,a,lat,lng,poly}
const geocodeCache = {};
const watchers = {};   // houseId -> unsubscribe for report listeners

/* ---------------- storage backends ---------------- */

async function firebaseStore() {
  const V = '10.14.1';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const { getAuth, signInAnonymously, onAuthStateChanged } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const { getDatabase, ref, onValue, set, remove, update, get, serverTimestamp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`);
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const uid = await new Promise((resolve, reject) => {
    onAuthStateChanged(auth, u => u && resolve(u.uid));
    signInAnonymously(auth).catch(reject);
  });
  const db = getDatabase(app);
  const clearHouse = id => ({ [`houses/${id}`]: null, [`ratings/${id}`]: null, [`reports/${id}`]: null });
  return {
    uid,
    onHouses: cb => onValue(ref(db, 'houses'), s => cb(s.val() || {})),
    onRatings: cb => onValue(ref(db, 'ratings'), s => cb(s.val() || {})),
    saveHouse: (id, h) => set(ref(db, `houses/${id}`), { ...h, owner: uid, t: serverTimestamp() }),
    // Removes the check-in plus its ratings and reports in one update, so the real owner can claim it.
    releaseHouse: id => update(ref(db), clearHouse(id)),
    moveHouse: (from, to, h) => update(ref(db), { ...clearHouse(from), [`houses/${to}`]: { ...h, owner: uid, t: serverTimestamp() } }),
    rate: (id, n) => set(ref(db, `ratings/${id}/${uid}`), n),
    report: (id, note) => set(ref(db, `reports/${id}/${uid}`), note ? { note, t: serverTimestamp() } : { t: serverTimestamp() }),
    cancelReport: id => remove(ref(db, `reports/${id}/${uid}`)),
    getMyReport: id => get(ref(db, `reports/${id}/${uid}`)).then(s => s.val()).catch(() => null),
    watchReports: (id, cb) => onValue(ref(db, `reports/${id}`), s => cb(s.val() || {}), () => cb({})),
    watchAllReports: cb => onValue(ref(db, 'reports'), s => cb(s.val() || {}), e => console.warn('reports', e)),
    dismissReports: id => remove(ref(db, `reports/${id}`)),
    checkAdmin: () => get(ref(db, `admins/${uid}`)).then(s => s.val() === true).catch(() => false),
  };
}

function localStore() {
  const K = 'tot-demo';
  let uid = localStorage.getItem('tot-uid');
  if (!uid) { uid = 'local-' + Math.random().toString(36).slice(2); localStorage.setItem('tot-uid', uid); }
  const load = () => {
    const d = JSON.parse(localStorage.getItem(K) || '{}');
    d.houses ||= {}; d.ratings ||= {}; d.reports ||= {};
    return d;
  };
  const subs = new Set();
  const save = d => { localStorage.setItem(K, JSON.stringify(d)); subs.forEach(f => f(d)); };
  const sub = f => { subs.add(f); f(load()); return () => subs.delete(f); };
  const denied = () => { throw new Error('PERMISSION_DENIED'); };
  const canEdit = (d, id) => !d.houses[id] || d.houses[id].owner === uid || ADMIN_URL;
  const clear = (d, id) => { delete d.houses[id]; delete d.ratings[id]; delete d.reports[id]; };
  return {
    uid, demo: true,
    onHouses: cb => sub(d => cb(d.houses)),
    onRatings: cb => sub(d => cb(d.ratings)),
    saveHouse: async (id, h) => { const d = load(); if (!canEdit(d, id)) denied(); d.houses[id] = { ...h, owner: uid, t: Date.now() }; save(d); },
    releaseHouse: async id => { const d = load(); if (!canEdit(d, id)) denied(); clear(d, id); save(d); },
    moveHouse: async (from, to, h) => {
      const d = load();
      if (!canEdit(d, from) || d.houses[to]) denied();
      clear(d, from); d.houses[to] = { ...h, owner: uid, t: Date.now() }; save(d);
    },
    rate: async (id, n) => { const d = load(); (d.ratings[id] ||= {})[uid] = n; save(d); },
    report: async (id, note) => { const d = load(); (d.reports[id] ||= {})[uid] = note ? { note, t: Date.now() } : { t: Date.now() }; save(d); },
    cancelReport: async id => { const d = load(); delete d.reports[id]?.[uid]; save(d); },
    getMyReport: async id => load().reports[id]?.[uid] || null,
    watchReports: (id, cb) => sub(d => cb(d.reports[id] || {})),
    watchAllReports: cb => sub(d => cb(d.reports)),
    dismissReports: async id => { const d = load(); delete d.reports[id]; save(d); },
    checkAdmin: async () => ADMIN_URL,
  };
}

/* ---------------- map ---------------- */

const map = L.map('map', { zoomControl: false, minZoom: 15, maxZoom: 20, maxBounds: BOUNDS.pad(1) });
map.fitBounds(BOUNDS);
L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.addAttribution('Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, addresses &copy; Placer County');
// Streets and their names are drawn from streets.json (no tile server or API key needed).
map.createPane('streets').style.zIndex = 350;                  // below house outlines
const labelPane = map.createPane('labels');
labelPane.style.zIndex = 450; labelPane.style.pointerEvents = 'none'; // above outlines, below pins
const markers = L.layerGroup().addTo(map);
const streetLabels = L.layerGroup();
const houseNums = L.layerGroup();

const STREET_STYLE = {
  primary: [12, '#4d4270'], secondary: [11, '#4d4270'], tertiary: [10, '#463c66'],
  residential: [8, '#3b3352'], unclassified: [8, '#3b3352'], living_street: [7, '#3b3352'],
  service: [4, '#332b47'], footway: [2, '#5d5280'], path: [2, '#5d5280'],
};

// Point halfway along a street, plus the street's angle there, so the name sits on the road.
function midpointAndAngle(pts) {
  const k = Math.cos(pts[0][0] * Math.PI / 180);
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][1] - pts[i - 1][1]) * k, dy = pts[i][0] - pts[i - 1][0];
    const len = Math.hypot(dx, dy);
    seg.push({ i, len, dx, dy });
    total += len;
  }
  let walked = 0;
  for (const s of seg) {
    if (walked + s.len >= total / 2 && s.len > 0) {
      const f = (total / 2 - walked) / s.len, a = pts[s.i - 1], b = pts[s.i];
      let deg = -Math.atan2(s.dy, s.dx) * 180 / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], deg, total };
    }
    walked += s.len;
  }
  return null;
}

async function loadStreets() {
  const list = await (await fetch('streets.json')).json();
  for (const s of list) {
    const [weight, color] = STREET_STYLE[s.k] || STREET_STYLE.residential;
    L.polyline(s.p, {
      pane: 'streets', weight, color, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false,
      dashArray: s.k === 'path' || s.k === 'footway' ? '4 6' : null,
    }).addTo(map);
    if (!s.n) continue;
    const m = midpointAndAngle(s.p);
    if (!m || m.total < 0.0004) continue; // skip tiny stubs (~40 m)
    streetLabels.addLayer(L.marker(m.at, {
      pane: 'labels', interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="street" style="transform:translate(-50%,-50%) rotate(${m.deg.toFixed(1)}deg)">${esc(s.n)}</div>` }),
    }));
  }
  const toggleLabels = () => map.getZoom() >= 16 ? streetLabels.addTo(map) : streetLabels.remove();
  map.on('zoomend', toggleLabels);
  toggleLabels();
}

async function loadFootprints() {
  const list = await (await fetch('buildings.json')).json();
  for (const b of list) {
    const poly = L.polygon(b.p, { weight: 1, color: '#000', fillColor: COLORS.none, fillOpacity: 0.6 }).addTo(map);
    const c = poly.getBounds().getCenter();
    const fp = { id: b.id, a: b.a, lat: c.lat, lng: c.lng, poly };
    poly.on('click', e => { L.DomEvent.stopPropagation(e); openHouse(fp); });
    footprints[b.id] = fp;
    if (b.n) {
      houseNums.addLayer(L.marker(c, {
        pane: 'labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="hnum">${esc(b.n)}</div>` }),
      }));
    }
  }
  // House numbers (from Placer County address points) appear once there is room to read them.
  const toggleNums = () => map.getZoom() >= 18 ? houseNums.addTo(map) : houseNums.remove();
  map.on('zoomend', toggleNums);
  toggleNums();
}

// Only real house outlines can be checked in; tapping empty ground just closes any open panel.
map.on('click', () => { if (mode === 'view') closeSheet(); });

const target = id => footprints[id];
const myHouses = () => Object.keys(houses).filter(id => houses[id].owner === store?.uid && footprints[id]);
const nameOf = id => houses[id]?.addr || footprints[id]?.a || geocodeCache[id] || 'this house';
const reportCount = id => Object.keys(reportsFor[id] || {}).length;

/* ---------------- scoring ---------------- */

function stats(id) {
  const v = Object.values(ratings[id] || {}).filter(n => typeof n === 'number');
  const sum = v.reduce((a, b) => a + b, 0);
  // Score pulls toward 3 with few votes so one 5-star vote can't beat ten 4.8s.
  return { count: v.length, avg: v.length ? sum / v.length : 0, score: (sum + 3 * 2) / (v.length + 2) };
}

function leaderboard() {
  return Object.entries(houses)
    .filter(([id, h]) => h.status === 'yes' && footprints[id])
    .map(([id, h]) => ({ id, h, ...stats(id) }))
    .sort((a, b) => (b.count > 0) - (a.count > 0) || b.score - a.score || b.count - a.count || (b.h.candy || 0) - (a.h.candy || 0));
}

/* ---------------- rendering ---------------- */

function styleHouses() {
  for (const fp of Object.values(footprints)) {
    const h = houses[fp.id], s = h?.status || 'none';
    const sel = current?.id === fp.id, from = moveFrom === fp.id, mine = h && h.owner === store?.uid;
    fp.poly.setStyle({
      fillColor: COLORS[s] || COLORS.none, fillOpacity: s === 'no' ? 0.4 : 0.6,
      color: sel ? '#ffd000' : from ? '#ff4d6d' : mine ? '#ffffff' : '#000',
      weight: sel ? 4 : from || mine ? 2 : 1,
      dashArray: from ? '4 4' : null,
    });
    if (sel) fp.poly.bringToFront();
  }
}

function render() {
  styleHouses();
  const ranked = leaderboard();
  const top = new Set(ranked.filter(r => r.count).slice(0, 3).map(r => r.id));
  markers.clearLayers();
  for (const [id, h] of Object.entries(houses)) {
    if (!footprints[id] || typeof h.lat !== 'number' || typeof h.lng !== 'number') continue;
    const { avg, count } = stats(id);
    const html = h.status === 'yes'
      ? `<div class="pin ${top.has(id) ? 'top' : ''}">${top.has(id) ? '👑' : ''}🎃${count ? `<b>${avg.toFixed(1)}</b>` : ''}</div>`
      : '<div class="pin no">🚫</div>';
    const m = L.marker([h.lat, h.lng], { icon: L.divIcon({ className: '', html, iconSize: [0, 0] }), keyboard: false });
    m.on('click', () => openHouse(target(id)));
    markers.addLayer(m);
  }
  const all = Object.entries(houses).filter(([id]) => footprints[id]).map(([, h]) => h);
  $('#stats').textContent = `🎃 ${all.filter(h => h.status === 'yes').length} handing out · 🚫 ${all.filter(h => h.status === 'no').length} sitting out`;
  syncReportWatchers();
  updateControls();
  if (!$('#board').hidden) renderBoard();
  if (!$('#admin').hidden) renderAdmin();
  if (current && mode === 'view') houses[current.id] ? renderSheet() : closeSheet();
}

function showPanel(id) {
  for (const p of ['#sheet', '#board', '#admin']) $(p).hidden = p !== id;
}

function openHouse(t) {
  if (!store || !t) return;
  if (mode === 'move' || mode === 'move-confirm') return pickMoveTarget(t);
  current = t;
  mode = houses[t.id] ? 'view' : 'confirm';
  showPanel('#sheet');
  renderSheet();
  styleHouses();
  if (mode === 'confirm') map.setView([t.lat, t.lng], Math.max(map.getZoom(), 19));
  else map.panTo([t.lat, t.lng]);
}

function closeSheet() {
  current = null;
  $('#sheet').hidden = true;
  if (mode !== 'move') mode = 'view';
  styleHouses();
}

function renderSheet() {
  const t = current, h = houses[t.id];
  $('#sheet').hidden = false;
  if (mode === 'confirm' && !h) return renderConfirm(t);
  if (mode === 'move-confirm') return renderMoveConfirm(t);
  if (mode === 'report' && h) return renderReport(t);
  if (mode === 'edit') return renderForm(t, h);
  if (!h) { mode = 'confirm'; return renderConfirm(t); }
  renderView(t, h);
}

// Shows the address next to the highlighted outline, looking it up if the map data has none.
function addressLine(t) {
  const known = t.a || geocodeCache[t.id];
  if (!known) {
    reverseGeocode(t).then(a => {
      const el = $('#c-addr');
      if (el && current?.id === t.id) el.textContent = a || 'Address not found. Check the highlighted outline.';
    });
  }
  return `<p class="addr">📍 <span id="c-addr">${esc(known || 'Looking up address…')}</span></p>
    <p class="fine">The address is approximate. Make sure the <span class="hl">highlighted outline</span> is your house.</p>`;
}

function renderConfirm(t) {
  const el = $('#sheet');
  const mine = myHouses();
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>Is this your house? 🏠</h2>
    ${addressLine(t)}
    ${mine.length ? `<p class="warn">You already checked in <b>${esc(nameOf(mine[0]))}</b>${mine.length > 1 ? ` and ${mine.length - 1} more` : ''}.</p>` : ''}
    <div class="col">
      ${mine.length === 1 ? '<button class="btn primary" id="c-move">Move my check-in here</button><button class="btn" id="c-yes">Add as another house</button>'
        : '<button class="btn primary" id="c-yes">Yes, this is my house</button>'}
      <button class="btn" id="c-no">No, pick another</button>
    </div>`;
  el.querySelector('.close').onclick = closeSheet;
  $('#c-yes').onclick = () => { mode = 'edit'; renderSheet(); };
  $('#c-no').onclick = closeSheet;
  if (mine.length === 1) $('#c-move').onclick = () => doMove(mine[0], t);
}

function renderView(t, h) {
  const el = $('#sheet');
  const mine = h.owner === store.uid;
  const s = stats(t.id), my = ratings[t.id]?.[store.uid] || 0;
  const canRate = h.status === 'yes' && (!mine || store.demo);
  const reps = Object.values(reportsFor[t.id] || {});
  if (!mine && !(t.id in myReports)) {
    myReports[t.id] = null;
    store.getMyReport(t.id).then(v => { myReports[t.id] = v; if (current?.id === t.id && mode === 'view') renderSheet(); });
  }
  const myRep = myReports[t.id];
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>${esc(nameOf(t.id))}</h2>
    ${mine && reps.length ? `
      <div class="alertbox">
        <b>⚠️ ${reps.length === 1 ? 'A neighbor says' : `${reps.length} neighbors say`} this is their house.</b>
        ${reps.map(r => `<p class="note">${r.note ? `“${esc(r.note)}”` : '(no note)'} <span class="fine">${ago(r.t)}</span></p>`).join('')}
        <p class="fine">If you picked the wrong house, move or remove your check-in. If this really is your house, you can leave it and the organizer will sort it out.</p>
        <div class="col">
          <button class="btn primary" id="v-move">Move to my correct house</button>
          <button class="btn danger" id="v-release">Remove my check-in</button>
        </div>
      </div>` : ''}
    ${h.status === 'yes' ? `
      <p class="status yes">🎃 Handing out candy!</p>
      ${h.candy ? `<p>They say: ${candies(h.candy)}<br><em>${CANDY_LEVELS[clamp(h.candy)]}</em></p>` : ''}
      ${Object.keys(TAGS).filter(k => h.tags?.[k] === true).map(k => `<span class="tag">${TAGS[k]}</span>`).join('')}
      <div class="rating"><span class="big">${s.count ? s.avg.toFixed(1) : '–'}</span>🍬 trick-or-treater rating
        <span class="fine">(${s.count} ${s.count === 1 ? 'vote' : 'votes'})</span></div>`
    : '<p class="status no">🚫 Not doing trick-or-treat this year</p>'}
    ${h.note ? `<p class="note">“${esc(h.note)}”</p>` : ''}
    ${canRate ? `
      <p class="lbl">${my ? 'Your rating (tap to change):' : 'Visited? Rate their candy:'}</p>
      <div class="rate">${[1, 2, 3, 4, 5].map(n => `<button data-r="${n}" class="${n <= my ? 'on' : ''}" aria-label="${n} candies">🍬</button>`).join('')}</div>` : ''}
    ${mine ? `<div class="row"><button class="btn" id="edit">✏️ Edit</button><button class="btn" id="wrong">Wrong house?</button></div>` : ''}
    ${!mine && myRep ? `
      <div class="infobox">You told the neighbor who checked this in that it's your house${myRep.note ? `: “${esc(myRep.note)}”` : ''}.
        They and the organizer can see your report. Once it's released, tap this house again to check in.
        <div class="row"><button class="btn" id="v-unreport">Cancel my report</button></div></div>` : ''}
    ${!mine && !myRep ? '<button class="linkbtn" id="v-report">🏠 This is actually my house</button>' : ''}
    ${isAdmin ? `<div class="adminbox">🛠 Organizer${reps.length && !mine ? ` · ${reps.length} report${reps.length > 1 ? 's' : ''}` : ''}
      <div class="row"><button class="btn danger" id="v-admin-release">Remove claim</button>
      ${reps.length ? '<button class="btn" id="v-admin-dismiss">Dismiss reports</button>' : ''}</div></div>` : ''}`;
  el.querySelector('.close').onclick = closeSheet;
  el.querySelectorAll('[data-r]').forEach(b => { b.onclick = () => store.rate(t.id, +b.dataset.r).catch(fail); });
  if (mine) {
    $('#edit').onclick = () => { mode = 'edit'; renderSheet(); };
    $('#wrong').onclick = () => startMove(t.id);
    if (reps.length) {
      $('#v-move').onclick = () => startMove(t.id);
      $('#v-release').onclick = () => release(t.id, 'Remove your check-in so your neighbor can claim this house?');
    }
  }
  $('#v-report')?.addEventListener('click', () => { mode = 'report'; renderSheet(); });
  $('#v-unreport')?.addEventListener('click', async () => {
    try { await store.cancelReport(t.id); myReports[t.id] = null; renderSheet(); } catch (e) { fail(e); }
  });
  $('#v-admin-release')?.addEventListener('click', () => adminRelease(t.id));
  $('#v-admin-dismiss')?.addEventListener('click', () => store.dismissReports(t.id).catch(fail));
}

function renderReport(t) {
  const el = $('#sheet');
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>This is my house 🏠</h2>
    <p>Someone else checked in <b>${esc(nameOf(t.id))}</b>. We'll let them know so they can move or remove their check-in. The organizer sees it too.</p>
    <label class="lbl">Note (optional)
      <input id="r-note" maxlength="140" placeholder="e.g. I live here. I think you meant the house next door."></label>
    <div class="row">
      <button class="btn primary" id="r-send">Send</button>
      <button class="btn" id="r-cancel">Cancel</button>
    </div>
    <p class="fine">Once it's released, tap this house again to check in.</p>`;
  el.querySelector('.close').onclick = closeSheet;
  $('#r-cancel').onclick = () => { mode = 'view'; renderSheet(); };
  $('#r-send').onclick = async e => {
    const note = $('#r-note').value.trim().slice(0, 140);
    e.target.disabled = true;
    try { await store.report(t.id, note); myReports[t.id] = { note, t: Date.now() }; mode = 'view'; renderSheet(); }
    catch (err) { e.target.disabled = false; fail(isPermission(err) ? 'Could not send. The house may have just been released, so try tapping it again.' : err); }
  };
}

function renderForm(t, h) {
  const el = $('#sheet');
  const d = h || { status: 'yes', candy: 3, tags: {}, note: '', addr: t.a || geocodeCache[t.id] || '' };
  let status = d.status, candy = clamp(d.candy || 3);
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>${h ? 'Edit your house' : 'Check in your house 🏠'}</h2>
    <label class="lbl">Address or name
      <input id="f-addr" maxlength="60" value="${esc(d.addr)}" placeholder="e.g. 123 Sofia Dr or The Smiths"></label>
    <div class="toggle">
      <button type="button" data-s="yes">🎃 Yes, handing out candy!</button>
      <button type="button" data-s="no">🚫 Not this year</button>
    </div>
    <div id="yes-only">
      <p class="lbl">How good is your candy? <em id="lvl"></em></p>
      <div class="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-c="${n}" aria-label="${n} candies">🍬</button>`).join('')}</div>
      ${Object.entries(TAGS).map(([k, v]) => `<label class="chk"><input type="checkbox" data-t="${k}" ${d.tags?.[k] ? 'checked' : ''}> ${v}</label>`).join('')}
    </div>
    <label class="lbl">Note (optional)
      <input id="f-note" maxlength="140" value="${esc(d.note)}" placeholder="e.g. Bowl on the porch after 8pm"></label>
    <div class="row">
      <button class="btn primary" id="save">Save</button>
      ${h ? '<button class="btn" id="cancel">Cancel</button>' : ''}
    </div>
    ${h ? '<div class="row"><button class="btn" id="f-move">Wrong house? Move it</button><button class="btn danger" id="del">Remove</button></div>' : ''}
    <p class="fine">Only this device can change this house later. Use 🏠 My house at the top to find it again.</p>`;

  const paint = () => {
    el.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === status));
    $('#yes-only').hidden = status !== 'yes';
    el.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', +b.dataset.c <= candy));
    $('#lvl').textContent = CANDY_LEVELS[candy];
  };
  el.querySelectorAll('[data-s]').forEach(b => { b.onclick = () => { status = b.dataset.s; paint(); }; });
  el.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => { candy = +b.dataset.c; paint(); }; });
  paint();

  el.querySelector('.close').onclick = closeSheet;
  if (h) {
    $('#cancel').onclick = () => { mode = 'view'; renderSheet(); };
    $('#f-move').onclick = () => startMove(t.id);
    $('#del').onclick = () => release(t.id, 'Remove your house from the map? Its ratings will be cleared too.');
  }
  $('#save').onclick = async e => {
    const rec = {
      lat: +t.lat.toFixed(6), lng: +t.lng.toFixed(6), status,
      addr: $('#f-addr').value.trim().slice(0, 60),
      note: $('#f-note').value.trim().slice(0, 140),
    };
    if (status === 'yes') {
      rec.candy = candy;
      rec.tags = Object.fromEntries([...el.querySelectorAll('[data-t]')].map(c => [c.dataset.t, c.checked]));
    }
    e.target.disabled = true;
    try { await store.saveHouse(t.id, rec); mode = 'view'; renderSheet(); }
    catch (err) { e.target.disabled = false; fail(isPermission(err) ? 'Someone else just checked in this house. Close this and tap it again.' : err); }
  };

  if (!d.addr) reverseGeocode(t).then(a => { const i = $('#f-addr'); if (a && i && !i.value) i.value = a; });
}

async function release(id, question) {
  if (!confirm(question)) return;
  try { await store.releaseHouse(id); closeSheet(); } catch (e) { fail(e); }
}

async function adminRelease(id) {
  if (!confirm(`Remove the check-in for ${nameOf(id)}? This also clears its ratings and reports, and lets anyone claim it.`)) return;
  try { await store.releaseHouse(id); if (current?.id === id) closeSheet(); } catch (e) { fail(isPermission(e) ? 'This device is not set up as an organizer.' : e); }
}

/* ---------------- moving a check-in to the right house ---------------- */

function startMove(fromId) {
  moveFrom = fromId;
  mode = 'move';
  current = null;
  $('#sheet').hidden = true;
  styleHouses();
  updateControls();
}

function endMove() {
  moveFrom = null;
  if (mode === 'move' || mode === 'move-confirm') mode = 'view';
  closeSheet();
  updateControls();
}

function pickMoveTarget(t) {
  if (t.id === moveFrom) return alert("That's the house you're moving from. Tap your correct house.");
  const h = houses[t.id];
  if (h && h.owner === store.uid) return alert('You already checked in that house.');
  if (h) return alert('Someone else already checked in that house. Cancel the move, tap that house, and choose "This is actually my house".');
  current = t;
  mode = 'move-confirm';
  showPanel('#sheet');
  renderSheet();
  styleHouses();
  map.setView([t.lat, t.lng], Math.max(map.getZoom(), 19));
}

function renderMoveConfirm(t) {
  const el = $('#sheet');
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>Move your check-in here?</h2>
    <p>From <b>${esc(nameOf(moveFrom))}</b> (dashed red outline) to the <span class="hl">highlighted house</span>:</p>
    ${addressLine(t)}
    <p class="fine">Ratings on the old house will be cleared, since they were for the wrong house.</p>
    <div class="col">
      <button class="btn primary" id="m-yes">Move here</button>
      <button class="btn" id="m-other">Pick a different house</button>
      <button class="btn" id="m-cancel">Cancel move</button>
    </div>`;
  el.querySelector('.close').onclick = endMove;
  $('#m-yes').onclick = () => doMove(moveFrom, t);
  $('#m-other').onclick = () => { current = null; mode = 'move'; $('#sheet').hidden = true; styleHouses(); };
  $('#m-cancel').onclick = endMove;
}

async function doMove(fromId, t) {
  const old = houses[fromId];
  if (!old) return endMove();
  const rec = { ...old, lat: +t.lat.toFixed(6), lng: +t.lng.toFixed(6) };
  delete rec.owner; delete rec.t;
  // Swap in the new house's address if the old one was just the wrong house's looked-up address.
  const oldAuto = [footprints[fromId]?.a, geocodeCache[fromId]].filter(Boolean);
  const newAddr = t.a || geocodeCache[t.id] || await reverseGeocode(t);
  if (newAddr && (!rec.addr || oldAuto.includes(rec.addr))) rec.addr = newAddr;
  try {
    await store.moveHouse(fromId, t.id, rec);
    moveFrom = null;
    current = t;
    mode = 'edit'; // let them double-check the details on the right house
    showPanel('#sheet');
    renderSheet();
    styleHouses();
    updateControls();
  } catch (e) { fail(isPermission(e) ? 'Someone else just checked in that house. Pick a different one.' : e); }
}

/* ---------------- reports, alerts and header buttons ---------------- */

// Each owner listens for reports on their own houses. Organizers get all reports instead.
function syncReportWatchers() {
  if (!store || isAdmin) return;
  const want = new Set(myHouses());
  for (const id of Object.keys(watchers)) {
    if (!want.has(id)) { watchers[id](); delete watchers[id]; delete reportsFor[id]; }
  }
  for (const id of want) {
    if (watchers[id]) continue;
    watchers[id] = store.watchReports(id, v => {
      reportsFor[id] = v;
      updateControls();
      if (current?.id === id && mode === 'view') renderSheet();
    });
  }
}

function updateControls() {
  if (!store) return;
  const mine = myHouses();
  const bm = $('#btn-mine');
  bm.hidden = !mine.length;
  bm.textContent = mine.length > 1 ? `🏠 My houses (${mine.length})` : '🏠 My house';

  const ba = $('#btn-admin');
  const open = Object.keys(reportsFor).filter(reportCount).length;
  ba.hidden = !(isAdmin || ADMIN_URL);
  ba.textContent = isAdmin && open ? `🛠 Reports (${open})` : '🛠 Organizer';

  const al = $('#alert');
  if (mode === 'move' || mode === 'move-confirm') {
    al.innerHTML = `Moving <b>${esc(nameOf(moveFrom))}</b>: tap your correct house. <button class="btn" id="al-cancel">Cancel</button>`;
    al.className = 'move';
    al.hidden = false;
    $('#al-cancel').onclick = e => { e.stopPropagation(); endMove(); };
    al.onclick = null;
    return;
  }
  const flagged = mine.filter(reportCount);
  if (flagged.length) {
    al.innerHTML = `⚠️ A neighbor says <b>${esc(nameOf(flagged[0]))}</b> is their house. Tap to review.`;
    al.className = 'warn';
    al.hidden = false;
    al.onclick = () => { const t = target(flagged[0]); map.setView([t.lat, t.lng], 19); openHouse(t); };
  } else {
    al.hidden = true;
  }
}

function renderAdmin() {
  const el = $('#admin');
  const flagged = Object.keys(reportsFor).filter(reportCount)
    .sort((a, b) => Math.max(...Object.values(reportsFor[b]).map(r => r.t || 0)) - Math.max(...Object.values(reportsFor[a]).map(r => r.t || 0)));
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>🛠 Organizer tools</h2>
    ${isAdmin ? `
      <p class="fine">Neighbors who say someone else checked in their house show up here. <b>Remove claim</b> deletes that check-in, its ratings and reports, so the real owner can check in. You can also tap any house on the map and use <b>Remove claim</b>.</p>
      ${flagged.length ? `<ol class="reports">${flagged.map(id => `
        <li>
          <div class="nm"><b>${esc(nameOf(id))}</b>${houses[id] ? '' : ' <span class="fine">(no longer checked in)</span>'}</div>
          ${Object.values(reportsFor[id]).map(r => `<div class="note">${r.note ? `“${esc(r.note)}”` : '(no note)'} <span class="fine">${ago(r.t)}</span></div>`).join('')}
          <div class="row">
            ${footprints[id] ? `<button class="btn" data-open="${esc(id)}">Show</button>` : ''}
            ${houses[id] ? `<button class="btn danger" data-release="${esc(id)}">Remove claim</button>` : ''}
            <button class="btn" data-dismiss="${esc(id)}">Dismiss</button>
          </div>
        </li>`).join('')}</ol>` : '<p>No reports right now. 🎉</p>'}
      <p class="fine">This device's organizer ID: <code>${esc(store.uid)}</code></p>`
    : `
      <p>This device isn't set up as an organizer yet. To set it up:</p>
      <ol class="steps">
        <li>Copy this device's ID: <code id="my-uid">${esc(store.uid)}</code> <button class="btn" id="copy-uid">Copy</button></li>
        <li>In the Firebase console, open <b>Realtime Database → Data</b>.</li>
        <li>Click <b>+</b> next to the database name. Key: <code>admins</code>. Then click <b>+</b> next to <code>admins</code>. Key: your ID, Value: <code>true</code> (type <b>boolean</b> if asked). Click <b>Add</b>.</li>
        <li>Reload this page with <code>?admin</code> at the end of the link.</li>
      </ol>
      <p class="fine">The ID belongs to this browser. If you clear browser data or switch devices, repeat these steps.</p>`}`;
  el.querySelector('.close').onclick = () => { el.hidden = true; };
  $('#copy-uid')?.addEventListener('click', () => navigator.clipboard?.writeText(store.uid).then(() => alert('Copied.'), () => alert(store.uid)));
  el.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => { const t = target(b.dataset.open); map.setView([t.lat, t.lng], 19); openHouse(t); }; });
  el.querySelectorAll('[data-release]').forEach(b => { b.onclick = () => adminRelease(b.dataset.release); });
  el.querySelectorAll('[data-dismiss]').forEach(b => { b.onclick = () => store.dismissReports(b.dataset.dismiss).catch(fail); });
}

async function reverseGeocode(t) {
  if (t.id in geocodeCache) return geocodeCache[t.id];
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${t.lat}&lon=${t.lng}`);
    const a = (await r.json()).address || {};
    return (geocodeCache[t.id] = a.house_number && a.road ? `${a.house_number} ${a.road}` : '');
  } catch { return ''; }
}

function renderBoard() {
  const list = leaderboard();
  const el = $('#board');
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <h2>🏆 Candy Leaderboard</h2>
    <p class="fine">Ranked by trick-or-treater ratings. Visit a 🎃 house, then tap it on the map to rate it.</p>
    ${list.length ? `<ol>${list.map((r, i) => `
      <li data-id="${esc(r.id)}">
        <span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
        <span class="nm">${esc(r.h.addr || 'A neighbor')}</span>
        <span>${r.count ? `${r.avg.toFixed(1)} 🍬 <span class="fine">(${r.count})</span>` : '<span class="fine">no votes yet</span>'}</span>
      </li>`).join('')}</ol>` : '<p>No candy houses yet. Be the first to check in!</p>'}`;
  el.querySelector('.close').onclick = () => { el.hidden = true; };
  el.querySelectorAll('li').forEach(li => {
    li.onclick = () => { const t = target(li.dataset.id); map.setView([t.lat, t.lng], 19); openHouse(t); };
  });
}

/* ---------------- controls ---------------- */

$('#btn-board').onclick = () => {
  if (mode !== 'move') closeSheet();
  const show = $('#board').hidden;
  showPanel(show ? '#board' : null);
  if (show) renderBoard();
};

$('#btn-admin').onclick = () => {
  if (mode !== 'move') closeSheet();
  const show = $('#admin').hidden;
  showPanel(show ? '#admin' : null);
  if (show) renderAdmin();
};

$('#btn-mine').onclick = () => {
  const mine = myHouses();
  if (!mine.length) return;
  const t = target(mine[mineIdx++ % mine.length]);
  map.setView([t.lat, t.lng], 19);
  openHouse(t);
};

let me = null;
$('#btn-locate').onclick = () => map.locate({ setView: true, maxZoom: 19, enableHighAccuracy: true });
map.on('locationfound', e => {
  if (me) me.setLatLng(e.latlng);
  else me = L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#4da3ff', fillOpacity: 1 }).addTo(map);
});
map.on('locationerror', () => alert('Could not get your location.'));

/* ---------------- start ---------------- */

(async () => {
  try { await loadStreets(); } catch (e) { console.warn('Could not load streets.json', e); }
  try { await loadFootprints(); } catch (e) { console.warn('Could not load buildings.json', e); }
  let note = '';
  if (firebaseConfig) {
    try { store = await firebaseStore(); }
    catch (e) { console.error(e); note = 'Could not connect to the shared database. '; }
  }
  if (!store) {
    store = localStore();
    const b = $('#banner');
    b.textContent = note + 'Demo mode: changes are only saved in this browser.';
    b.hidden = false;
  }
  isAdmin = await store.checkAdmin();
  if (isAdmin) store.watchAllReports(v => { reportsFor = v; updateControls(); if (!$('#admin').hidden) renderAdmin(); if (current && mode === 'view') renderSheet(); });
  store.onHouses(v => { houses = v; render(); });
  store.onRatings(v => { ratings = v; render(); });
  if (ADMIN_URL) { showPanel('#admin'); renderAdmin(); }
})();
