'use strict';
/* TrailMates — simple hiking app. No build step. */
const $ = id => document.getElementById(id);
const NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const BG = NATIVE ? Capacitor.registerPlugin('BackgroundGeolocation') : null;

const store = {
  get(k, d) { try { const v = localStorage.getItem('tm:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tm:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('tm:' + k); } catch {} },
};

const S = {
  server: store.get('server', NATIVE ? '' : location.origin),
  token: store.get('token', null),
  user: store.get('user', null),
  set: Object.assign({ units: 'imperial', pace: '4', text: '1', map: 'topo' }, store.get('settings', {})),
  trails: store.get('trails', []),
  trail: null,          // current trail with cum arrays
  hike: store.get('hike', null), // {trailId, start}
  pos: null,            // {lat, lon, acc, ts}
  prog: null,           // {along, off}
  others: [],
  screen: 'login',
};

// ---------- helpers ----------
function toast(msg, ms = 3000) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), ms); }
function ask(text, yes = 'Yes', no = 'No') {
  return new Promise(res => {
    $('mText').textContent = text; $('mYes').textContent = yes; $('mNo').textContent = no; $('modal').classList.remove('hidden');
    $('mYes').onclick = () => { $('modal').classList.add('hidden'); res(true); };
    $('mNo').onclick = () => { $('modal').classList.add('hidden'); res(false); };
  });
}
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(S.server.replace(/\/$/, '') + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) } });
  } catch { throw new Error('Cannot reach the server. Check your signal.'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && path !== '/api/login') { logout(true); throw new Error('Please log in again'); }
  if (!r.ok) throw new Error(j.error || 'Server problem (' + r.status + ')');
  return j;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imp = () => S.set.units === 'imperial';
function fmtDist(m) {
  if (m == null || !isFinite(m)) return '–';
  if (imp()) { const mi = m / 1609.344; return mi < 0.1 ? Math.round(m * 3.281) + ' ft' : mi.toFixed(mi < 10 ? 1 : 0) + ' mi'; }
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
}
const fmtElev = m => imp() ? Math.round(m * 3.281).toLocaleString() + ' ft' : Math.round(m).toLocaleString() + ' m';
function fmtDur(h) { if (!isFinite(h)) return '–'; const t = Math.max(0, Math.round(h * 60)); return t < 60 ? t + ' min' : Math.floor(t / 60) + ' h ' + (t % 60) + ' m'; }
const fmtClock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ago(ts) { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m === 1 ? '1 min ago' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; }
function hav(a1, o1, a2, o2) { const r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r; const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(s)); }

// ---------- screens ----------
function show(name, push = true) {
  for (const s of document.querySelectorAll('.scr')) s.classList.toggle('hidden', s.id !== 'scr-' + name);
  S.screen = name;
  $('backBtn').classList.toggle('hidden', name === 'login' || name === 'home');
  $('setBtn').classList.toggle('hidden', name !== 'home');
  $('title').textContent = name === 'hike' ? (S.trail ? S.trail.name : 'Everyone') : name === 'settings' ? 'Settings' : 'TrailMates';
  if (push && name !== 'login' && name !== 'home') history.pushState({ s: name }, '');
  if (name === 'hike') { map.invalidateSize(); setTimeout(() => map.invalidateSize(), 200); }
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => { if (S.screen !== 'home' && S.screen !== 'login') leaveHike(), show('home', false); });
$('backBtn').onclick = () => history.back();
$('setBtn').onclick = () => openSettings();

function applySettings() {
  document.documentElement.style.setProperty('--scale', S.set.text);
  for (const seg of document.querySelectorAll('.seg')) for (const b of seg.children) b.classList.toggle('on', S.set[seg.dataset.key] === b.dataset.v);
}
for (const seg of document.querySelectorAll('.seg')) seg.onclick = e => {
  if (!e.target.dataset.v) return; S.set[seg.dataset.key] = e.target.dataset.v; store.set('settings', S.set); applySettings();
};

// ---------- login ----------
if (!NATIVE) $('serverWrap').classList.add('hidden');
$('lServer').value = S.server || '';
$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  if (NATIVE) { let v = $('lServer').value.trim(); if (v && !/^https?:\/\//.test(v)) v = 'https://' + v; S.server = v.replace(/\/$/, ''); store.set('server', S.server); }
  if (!S.server) return ($('loginErr').textContent = 'Type the server address');
  $('loginBtn').disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('lUser').value, password: $('lPass').value }) });
    S.token = r.token; S.user = r.user; store.set('token', r.token); store.set('user', r.user);
    $('lPass').value = ''; startApp();
  } catch (e) { $('loginErr').textContent = e.message; }
  $('loginBtn').disabled = false;
};
$('lPass').onkeydown = e => { if (e.key === 'Enter') $('loginBtn').click(); };

async function logout(expired) {
  if (!expired && !(await ask('Log out of TrailMates?'))) return;
  if (!expired) api('/api/logout', { method: 'POST' }).catch(() => {});
  stopBg(); S.token = null; S.user = null; S.hike = null;
  for (const k of ['token', 'user', 'hike']) store.del(k);
  show('login', false);
}
$('logoutBtn').onclick = () => logout(false);

// ---------- trails ----------
// Saved maps are stored as "style:trailId" (old saves were plain ids = topo).
const offlineSet = () => new Set(store.get('offline', []).map(k => typeof k === 'number' ? 'topo:' + k : k));
const isSaved = id => [...offlineSet()].some(k => k.endsWith(':' + id));
const isSavedStyle = (id, st = S.set.map) => offlineSet().has(st + ':' + id);
function renderTrails() {
  $('trailList').innerHTML = S.trails.length ? S.trails.map(t => `<button class="trail" data-id="${t.id}"><b>${esc(t.name)}${isSaved(t.id) ? '<span class="badge">Saved</span>' : ''}${S.hike && S.hike.trailId === t.id ? '<span class="badge">Hiking</span>' : ''}</b><span>${fmtDist(t.distance)} · ↑ ${fmtElev(t.gain)} · about ${fmtDur(estimate(t.distance, t.gain))}</span></button>`).join('')
    : '<p class="hint">No trails yet. Add one below.</p>';
  for (const b of $('trailList').children) if (b.dataset.id) b.onclick = () => openTrail(Number(b.dataset.id));
}
async function loadTrails() {
  try { S.trails = await api('/api/trails'); store.set('trails', S.trails); } catch (e) { if (navigator.onLine) toast(e.message); }
  renderTrails();
}
$('addTrailBtn').onclick = () => $('gpxFile').click();
$('gpxFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const gpx = await f.text();
    toast('Adding trail…');
    const r = await api('/api/trails', { method: 'POST', body: JSON.stringify({ gpx, name: '' }) });
    await loadTrails(); toast('Trail added'); openTrail(r.id);
  } catch (err) { toast(err.message, 5000); }
};

function prepTrail(t) {
  const p = t.points, cum = [0], up = [0];
  let ref = p[0][2], gain = 0;
  for (let i = 1; i < p.length; i++) {
    cum.push(cum[i - 1] + hav(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]));
    const d = p[i][2] - ref; if (d > 3) { gain += d; ref = p[i][2]; } else if (d < -3) ref = p[i][2];
    up.push(gain);
  }
  return { ...t, cum, up, total: cum[cum.length - 1] };
}
async function openTrail(id) {
  let t = store.get('trail:' + id, null);
  try { t = await api('/api/trails/' + id); } catch (e) { if (!t) return toast(e.message); }
  if (isSaved(id)) store.set('trail:' + id, t);
  S.trail = prepTrail(t); S.prog = null;
  show('hike'); drawTrail(); updateStats(); pollOthers();
  const meta = S.trails.find(x => x.id === id);
  $('delTrailBtn').classList.toggle('hidden', !(S.user.isAdmin || (meta && meta.ownerId === S.user.id)));
  if (S.hike && S.hike.trailId !== id) toast('You are hiking another trail. Stop that hike first to start this one.', 4000);
}
$('everyoneBtn').onclick = () => { S.trail = null; show('hike'); drawTrail(); pollOthers(); };
$('delTrailBtn').onclick = async () => {
  if (!(await ask(`Delete “${S.trail.name}” for everyone?`, 'Delete', 'Keep'))) return;
  try { await api('/api/trails/' + S.trail.id, { method: 'DELETE' }); toast('Trail deleted'); history.back(); loadTrails(); } catch (e) { toast(e.message); }
};
function leaveHike() { /* keep tracking if a hike is active; nothing else needed */ }

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([39.5, -98.35], 4);
const STYLES = {
  topo: { name: 'Topo', max: 17, attr: 'Map data © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)' },
  street: { name: 'Street', max: 18, attr: '© OpenStreetMap contributors' },
  satellite: { name: 'Satellite', max: 18, attr: 'Imagery © Esri, Maxar, Earthstar Geographics' },
};
if (!STYLES[S.set.map]) S.set.map = 'topo';
const tileKey = (st, k) => `https://tile.cache/${st}/${k}.png`;
const tileSrc = (st, k) => `${S.server}/tiles/${st}/${k}.png?t=${S.token}`;
async function tileUrl(st, z, x, y) {
  const k = `${z}/${x}/${y}`;
  const cache = window.caches ? await caches.open('tiles').catch(() => null) : null;
  if (cache) { const hit = await cache.match(tileKey(st, k)); if (hit) return URL.createObjectURL(await hit.blob()); }
  const r = await fetch(tileSrc(st, k));
  if (!r.ok) throw new Error('tile');
  const blob = await r.blob();
  if (cache) cache.put(tileKey(st, k), new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(() => {});
  return URL.createObjectURL(blob);
}
const CachedTiles = L.TileLayer.extend({
  createTile(c, done) {
    const img = document.createElement('img'); img.alt = '';
    tileUrl(this.options.style, c.z, c.x, c.y).then(u => { img.onload = () => { URL.revokeObjectURL(u); done(null, img); }; img.src = u; }).catch(e => done(e, img));
    return img;
  },
});
let baseLayer = null;
function setStyle(st) {
  if (baseLayer) map.removeLayer(baseLayer);
  const d = STYLES[st];
  baseLayer = new CachedTiles('', { style: st, maxZoom: d.max, maxNativeZoom: d.max, attribution: d.attr }).addTo(map);
  map.setMaxZoom(d.max);
  $('styleBtn').textContent = '🗺 ' + d.name;
  for (const b of $('styleBox').children) b.classList.toggle('on', b.dataset.v === st);
  if (S.trail) updateOfflineBtn();
}
$('styleBtn').onclick = () => $('styleBox').classList.toggle('hidden');
map.on('click movestart', () => $('styleBox').classList.add('hidden'));
$('styleBox').onclick = e => {
  const v = e.target.dataset.v; if (!v) return;
  S.set.map = v; store.set('settings', S.set); setStyle(v); $('styleBox').classList.add('hidden');
  if (!navigator.onLine && S.trail && !isSavedStyle(S.trail.id)) toast(`The ${STYLES[v].name} map is not saved for this trail.`, 4000);
};
setStyle(S.set.map);
let trailLine = null, walkedLine = null, startMk = null, meMk = null, meAcc = null; const otherMks = new Map();

function drawTrail() {
  for (const l of [trailLine, walkedLine, startMk]) if (l) map.removeLayer(l);
  trailLine = walkedLine = startMk = null;
  $('trailOnly').classList.toggle('hidden', !S.trail);
  $('fitBtn').classList.toggle('hidden', !S.trail);
  if (S.trail) {
    const ll = S.trail.points.map(p => [p[0], p[1]]);
    trailLine = L.polyline(ll, { color: '#d7263d', weight: 6, opacity: .85 }).addTo(map);
    walkedLine = L.polyline([], { color: '#5a189a', weight: 7 }).addTo(map);
    startMk = L.circleMarker(ll[0], { radius: 9, color: '#fff', weight: 3, fillColor: '#1f6b3a', fillOpacity: 1 }).addTo(map).bindTooltip('Start', { className: 'name' });
    map.fitBounds(trailLine.getBounds(), { padding: [20, 20] });
    updateStartBtn(); updateOfflineBtn();
  } else {
    const pts = S.others.map(o => [o.lat, o.lon]); if (S.pos) pts.push([S.pos.lat, S.pos.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
  }
  drawMe(); drawOthers();
}
$('fitBtn').onclick = () => trailLine && map.fitBounds(trailLine.getBounds(), { padding: [20, 20] });
$('centerBtn').onclick = () => S.pos ? map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 15)) : toast('Looking for your location…');

function drawMe() {
  if (!S.pos) return;
  const ll = [S.pos.lat, S.pos.lon];
  if (!meMk) {
    meAcc = L.circle(ll, { radius: S.pos.acc || 10, color: '#1c5fb8', weight: 1, fillOpacity: .12 }).addTo(map);
    meMk = L.circleMarker(ll, { radius: 11, color: '#fff', weight: 4, fillColor: '#1c5fb8', fillOpacity: 1 }).addTo(map).bindTooltip('You', { permanent: true, direction: 'top', offset: [0, -10], className: 'name' });
  } else { meMk.setLatLng(ll); meAcc.setLatLng(ll).setRadius(Math.min(S.pos.acc || 10, 300)); }
}
function drawOthers() {
  const seen = new Set();
  for (const o of S.others) {
    seen.add(o.id); const ll = [o.lat, o.lon]; const label = `${esc(o.username)} · ${ago(o.ts)}`;
    let m = otherMks.get(o.id);
    if (!m) { m = L.circleMarker(ll, { radius: 11, color: '#fff', weight: 4, fillColor: o.color, fillOpacity: 1 }).addTo(map).bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10], className: 'name' }); otherMks.set(o.id, m); }
    else { m.setLatLng(ll); m.setTooltipContent(label); }
  }
  for (const [id, m] of otherMks) if (!seen.has(id)) { map.removeLayer(m); otherMks.delete(id); }
}

// ---------- progress + estimates ----------
// Naismith-style: walking speed + 1 hour per 600 m of climbing.
const estimate = (distM, upM, f = 1) => (distM / 1000 / Number(S.set.pace) + upM / 600) * f;
function project(t, lat, lon, near) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540, p = t.points; let cands = [];
  let min = Infinity;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = (p[i][1] - lon) * kx, ay = (p[i][0] - lat) * ky, bx = (p[i + 1][1] - lon) * kx, by = (p[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + u * dx, ay + u * dy);
    cands.push([d, i, u]); if (d < min) min = d;
  }
  // On out-and-back trails, pick the matching spot closest to where we were before.
  cands = cands.filter(c => c[0] < min + 25);
  const along = c => t.cum[c[1]] + c[2] * (t.cum[c[1] + 1] - t.cum[c[1]]);
  let best = cands[0];
  if (near != null) best = cands.reduce((a, c) => Math.abs(along(c) - near) < Math.abs(along(a) - near) ? c : a, best);
  return { along: along(best), off: best[0], i: best[1], u: best[2] };
}
const upAt = (t, i, u) => t.up[i] + u * ((t.up[i + 1] ?? t.up[i]) - t.up[i]);

function updateStats() {
  const t = S.trail; if (!t) return;
  const hiking = S.hike && S.hike.trailId === t.id;
  if (S.pos) S.prog = project(t, S.pos.lat, S.pos.lon, S.prog ? S.prog.along : (hiking ? 0 : null));
  const p = S.prog, onTrail = p && p.off < 150;
  const totalUp = t.up[t.up.length - 1];
  $('offTrail').classList.toggle('hidden', !(p && p.off >= 60));
  if (p && p.off >= 60) $('offTrail').textContent = p.off > 3000 ? `You are ${fmtDist(p.off)} from this trail.` : `⚠ You are ${fmtDist(p.off)} off the trail.`;

  if (onTrail) {
    const upDone = upAt(t, p.i, p.u), upLeft = totalUp - upDone, left = t.total - p.along;
    let f = 1;
    if (hiking) { const el = (Date.now() - S.hike.start) / 3.6e6, pred = estimate(p.along, upDone); if (el > 1 / 6 && p.along > 300 && pred > 0) f = Math.min(2.5, Math.max(0.6, el / pred)); }
    const h = estimate(left, upLeft, f);
    $('sGone').textContent = fmtDist(p.along); $('sLeft').textContent = fmtDist(left);
    $('sTimeLbl').textContent = 'Time left'; $('sTime').textContent = fmtDur(h);
    $('sEta').textContent = fmtClock(new Date(Date.now() + h * 3.6e6));
    $('sElev').textContent = `Climb left: ↑ ${fmtElev(upLeft)}`;
    if (walkedLine) walkedLine.setLatLngs(t.points.slice(0, p.i + 1).map(q => [q[0], q[1]]).concat([[t.points[p.i][0] + p.u * (t.points[p.i + 1][0] - t.points[p.i][0]), t.points[p.i][1] + p.u * (t.points[p.i + 1][1] - t.points[p.i][1])]]));
  } else {
    const h = estimate(t.total, totalUp);
    $('sGone').textContent = fmtDist(0); $('sLeft').textContent = fmtDist(t.total);
    $('sTimeLbl').textContent = 'Hike time'; $('sTime').textContent = 'about ' + fmtDur(h);
    $('sEta').textContent = hiking ? fmtClock(new Date(Date.now() + h * 3.6e6)) : '–';
    $('sElev').textContent = `Total climb: ↑ ${fmtElev(totalUp)}`;
    if (walkedLine) walkedLine.setLatLngs([]);
  }
  $('sElapsed').textContent = hiking ? 'Hiking for ' + fmtDur((Date.now() - S.hike.start) / 3.6e6) : '';
  drawElev(onTrail ? p.along : null);
}

function drawElev(along) {
  const c = $('elev'), t = S.trail; if (!t || !c.offsetWidth) return;
  const dpr = window.devicePixelRatio || 1, W = c.offsetWidth, H = c.offsetHeight;
  c.width = W * dpr; c.height = H * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const el = t.points.map(p => p[2]); let lo = Math.min(...el), hi = Math.max(...el);
  if (hi - lo < 20) { lo -= 10; hi += 10; }
  const fs = 13 * Number(S.set.text), L = 8, R = 8, T = fs + 10, B = fs + 10;
  const X = d => L + (d / t.total) * (W - L - R), Y = e => T + (1 - (e - lo) / (hi - lo)) * (H - T - B);
  const path = (to) => { g.beginPath(); g.moveTo(X(0), H - B); for (let i = 0; i < el.length && t.cum[i] <= to; i++) g.lineTo(X(t.cum[i]), Y(el[i])); };
  path(Infinity); g.lineTo(X(t.total), H - B); g.closePath(); g.fillStyle = '#cfe6d4'; g.fill();
  if (along != null) {
    path(along); g.lineTo(X(along), Y(elevAt(along))); g.lineTo(X(along), H - B); g.closePath(); g.fillStyle = '#7fb98f'; g.fill();
  }
  g.beginPath(); for (let i = 0; i < el.length; i++) g[i ? 'lineTo' : 'moveTo'](X(t.cum[i]), Y(el[i])); g.strokeStyle = '#1f5130'; g.lineWidth = 2.5; g.stroke();
  g.fillStyle = '#333'; g.font = `600 ${fs}px system-ui, sans-serif`;
  g.textAlign = 'left'; g.fillText('High ' + fmtElev(hi), L, fs + 2); g.fillText('Start', L, H - 4);
  g.textAlign = 'right'; g.fillText(fmtDist(t.total), W - R, H - 4); g.textAlign = 'center'; g.fillText('Low ' + fmtElev(lo), W / 2, H - 4);
  if (along != null) {
    const x = X(along), y = Y(elevAt(along));
    g.strokeStyle = '#1c5fb8'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, T - 4); g.lineTo(x, H - B); g.stroke();
    g.beginPath(); g.arc(x, y, 7, 0, 7); g.fillStyle = '#1c5fb8'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#1c5fb8'; g.textAlign = x > W / 2 ? 'right' : 'left'; g.fillText('You ' + fmtElev(elevAt(along)), x + (x > W / 2 ? -10 : 10), T + fs);
  }
}
function elevAt(d) { const t = S.trail; let i = t.cum.findIndex(c => c > d); if (i <= 0) return t.points[i < 0 ? t.points.length - 1 : 0][2]; const u = (d - t.cum[i - 1]) / (t.cum[i] - t.cum[i - 1]); return t.points[i - 1][2] + u * (t.points[i][2] - t.points[i - 1][2]); }
window.addEventListener('resize', () => S.screen === 'hike' && updateStats());

// ---------- hike start / stop ----------
function updateStartBtn() {
  const b = $('startBtn'), mine = S.hike && S.trail && S.hike.trailId === S.trail.id;
  b.textContent = mine ? '■ Finish Hike' : '▶ Start Hike'; b.classList.toggle('stop', !!mine);
  b.disabled = !!(S.hike && !mine);
}
$('startBtn').onclick = async () => {
  if (S.hike && S.hike.trailId === S.trail.id) {
    if (!(await ask('Finish your hike?', 'Finish', 'Keep Going'))) return;
    const dur = (Date.now() - S.hike.start) / 3.6e6; S.hike = null; store.del('hike'); stopBg(); releaseWake();
    toast(`Hike finished. Time: ${fmtDur(dur)}. Well done!`, 5000); sendPos(true);
  } else {
    S.hike = { trailId: S.trail.id, start: Date.now() }; store.set('hike', S.hike); S.prog = null;
    startBg(); keepAwake(); toast('Hike started. Others can now see you.'); sendPos(true);
  }
  updateStartBtn(); updateStats();
};
let wake = null;
async function keepAwake() { try { if (!NATIVE && navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch {} }
function releaseWake() { try { wake && wake.release(); } catch {} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (S.hike) keepAwake(); if (S.token) { pollOthers(); updateStats(); } } });

// ---------- location ----------
let lastSent = 0, lastSentPos = null;
function onPos(lat, lon, acc) {
  S.pos = { lat, lon, acc, ts: Date.now() };
  if (S.screen === 'hike') { drawMe(); updateStats(); }
  sendPos(false);
}
function sendPos(force) {
  if (!S.pos || !S.token) return;
  const moved = lastSentPos ? hav(lastSentPos.lat, lastSentPos.lon, S.pos.lat, S.pos.lon) : Infinity;
  if (!force && Date.now() - lastSent < 10000 && moved < 30) return;
  if (!force && Date.now() - lastSent < 60000 && moved < 10) return;
  lastSent = Date.now(); lastSentPos = S.pos;
  api('/api/location', { method: 'POST', body: JSON.stringify({ lat: S.pos.lat, lon: S.pos.lon, acc: S.pos.acc, trailId: S.hike ? S.hike.trailId : null, hiking: !!S.hike }) }).catch(() => {});
}
let watchId = null, bgId = null;
function startFg() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => onPos(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    e => { if (e.code === 1) toast('Please allow location so the map can show you.', 5000); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
async function startBg() {
  if (!BG || bgId) return;
  try {
    bgId = await BG.addWatcher({ backgroundTitle: 'TrailMates', backgroundMessage: 'Sharing your hike location with your group.', requestPermissions: true, stale: false, distanceFilter: 10 },
      (loc, err) => { if (err) { if (err.code === 'NOT_AUTHORIZED') toast('Please allow location “All the time” in phone settings.', 6000); return; } onPos(loc.latitude, loc.longitude, loc.accuracy); });
  } catch {}
}
function stopBg() { if (BG && bgId) { BG.removeWatcher({ id: bgId }).catch(() => {}); bgId = null; } }

// ---------- other hikers ----------
async function pollOthers() {
  if (!S.token) return;
  try { S.others = await api('/api/locations'); } catch { return; }
  drawOthers(); renderPeople();
}
function renderPeople() {
  const box = $('people');
  if (!S.others.length) { box.innerHTML = '<p class="hint">No one else is out right now.</p>'; return; }
  const name = id => (S.trails.find(t => t.id === id) || {}).name;
  box.innerHTML = S.others.map(o => {
    let where = o.hiking && o.trailId ? `Hiking ${esc(name(o.trailId) || 'a trail')}` : 'Not hiking';
    if (S.trail && o.trailId === S.trail.id) { const pr = project(S.trail, o.lat, o.lon); if (pr.off < 150) where = `On this trail · ${fmtDist(pr.along)} in`; }
    const away = S.pos ? ' · ' + fmtDist(hav(S.pos.lat, S.pos.lon, o.lat, o.lon)) + ' away' : '';
    return `<button class="person" data-id="${o.id}"><span class="dot" style="background:${esc(o.color)}"></span><div><b>${esc(o.username)}</b><span>${where}${away} · ${ago(o.ts)}</span></div></button>`;
  }).join('');
  for (const b of box.children) b.onclick = () => { const o = S.others.find(x => x.id === Number(b.dataset.id)); if (o) { map.setView([o.lat, o.lon], Math.max(map.getZoom(), 15)); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
}
setInterval(() => { if (S.token && S.screen === 'hike' && document.visibilityState === 'visible') pollOthers(); }, 10000);
setInterval(() => { if (S.screen === 'hike' && S.hike) updateStats(); }, 30000);

// ---------- offline maps ----------
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
function tilesFor(t, maxZ = 16) {
  // Tiles along the trail corridor (not the whole box), zoom 10–16.
  const set = new Set();
  for (let z = 10; z <= Math.min(16, maxZ); z++) {
    const pad = z >= 15 ? 1 : 0;
    for (const p of t.points) {
      const x = lon2x(p[1], z), y = lat2y(p[0], z);
      for (let dx = -pad; dx <= pad; dx++) for (let dy = -pad; dy <= pad; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
    }
  }
  return [...set];
}
function updateOfflineBtn() {
  const name = STYLES[S.set.map].name;
  $('offlineBtn').textContent = S.trail && isSavedStyle(S.trail.id) ? `✓ ${name} Map Saved (tap to remove)` : `⬇ Save ${name} Map for No Signal`;
}
$('offlineBtn').onclick = async () => {
  const t = S.trail, off = offlineSet(), st = S.set.map, me = st + ':' + t.id;
  if (off.has(me)) {
    if (!(await ask(`Remove the saved ${STYLES[st].name} map for this trail?`, 'Remove', 'Keep'))) return;
    off.delete(me); store.set('offline', [...off]); if (!isSaved(t.id)) store.del('trail:' + t.id); updateOfflineBtn(); renderTrails(); return;
  }
  if (!window.caches) return toast('This phone cannot save maps.');
  const list = tilesFor(t, STYLES[st].max); let done = 0, failed = 0;
  $('dl').classList.remove('hidden'); $('offlineBtn').disabled = true;
  const cache = await caches.open('tiles');
  const work = async () => {
    while (list.length) {
      const k = list.pop(), key = tileKey(st, k);
      try {
        if (!(await cache.match(key))) {
          const r = await fetch(tileSrc(st, k));
          if (!r.ok) throw 0; const blob = await r.blob(); await cache.put(key, new Response(blob, { headers: { 'Content-Type': blob.type } }));
        }
      } catch { failed++; }
      done++; const pct = Math.round(done / total * 100);
      $('dlBar').style.width = pct + '%'; $('dlTxt').textContent = `Saving map… ${pct}%`;
    }
  };
  const total = list.length;
  await Promise.all(Array.from({ length: 6 }, work));
  $('dl').classList.add('hidden'); $('offlineBtn').disabled = false;
  if (failed > total * 0.1) return toast('Some of the map did not save. Try again with better signal.', 5000);
  const { cum, up, total: _t, ...plain } = t;
  store.set('trail:' + t.id, plain); off.add(me); store.set('offline', [...off]);
  updateOfflineBtn(); renderTrails(); toast('Map saved. It will work with no signal.');
};

// ---------- settings ----------
async function openSettings() {
  show('settings'); applySettings();
  $('whoami').textContent = `Logged in as ${S.user.username}` + (NATIVE ? ` on ${S.server}` : '');
  $('adminCard').classList.toggle('hidden', !S.user.isAdmin);
  if (S.user.isAdmin) loadUsers();
}
async function loadUsers() {
  try {
    const us = await api('/api/users');
    $('userList').innerHTML = us.map(u => `<div class="urow"><span><span class="dot" style="display:inline-block;vertical-align:middle;background:${esc(u.color)}"></span> ${esc(u.username)}${u.isAdmin ? ' (admin)' : ''}</span>${u.id === S.user.id ? '' : `<button data-id="${u.id}" data-n="${esc(u.username)}">Remove</button>`}</div>`).join('');
    for (const b of $('userList').querySelectorAll('button')) b.onclick = async () => {
      if (!(await ask(`Remove ${b.dataset.n}?`, 'Remove', 'Keep'))) return;
      try { await api('/api/users/' + b.dataset.id, { method: 'DELETE' }); loadUsers(); } catch (e) { toast(e.message); }
    };
  } catch (e) { toast(e.message); }
}
$('addUserBtn').onclick = async () => {
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('nuName').value, password: $('nuPass').value, isAdmin: $('nuAdmin').checked }) });
    toast('Hiker added'); $('nuName').value = $('nuPass').value = ''; $('nuAdmin').checked = false; loadUsers();
  } catch (e) { toast(e.message); }
};
$('passBtn').onclick = async () => {
  try { await api('/api/me/password', { method: 'PUT', body: JSON.stringify({ password: $('newPass').value }) }); $('newPass').value = ''; toast('Password saved'); } catch (e) { toast(e.message); }
};

// ---------- start ----------
function netState() { $('offlineBar').classList.toggle('hidden', navigator.onLine); }
window.addEventListener('online', () => { netState(); if (S.token) loadTrails(); });
window.addEventListener('offline', netState);
function startApp() {
  show('home', false); renderTrails(); loadTrails(); startFg(); pollOthers();
  if (S.hike) { startBg(); keepAwake(); }
}
applySettings(); netState();
if (S.token && S.user) { startApp(); api('/api/me').then(u => { S.user = u; store.set('user', u); }).catch(() => {}); }
else show('login', false);
if ('serviceWorker' in navigator && !NATIVE) navigator.serviceWorker.register('sw.js').catch(() => {});
