'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) { let d = r.statusText; try { d = (await r.json()).detail || d; } catch { } throw new Error(d); }
  return r.json();
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500); }
const run = fn => (...a) => fn(...a).catch(e => toast(e.message));
function fmt(t, tenths = false) {
  t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + ss;
}

const S = { projects: [], jobs: [], pid: null, cur: null, sig: null, sigMax: 1, chatMax: 1, sel: null, a: null, b: null, loop: false, view: [0, 1], cfg: null, clipsSig: '', videoPid: null };
const video = $('#video');

/* ================================================================ проекты */
async function refreshList() {
  const d = await api('/api/projects');
  S.projects = d.projects; S.jobs = d.jobs;
  $('#projectList').innerHTML = S.projects.map(p => {
    const j = S.jobs.find(j => j.pid === p.id && j.kind === 'analyze');
    const sub = j ? esc(j.stage) : p.status === 'error' ? 'ошибка' : `${fmt(p.duration || 0)} · клипов: ${p.clips}`;
    return `<div class="proj ${p.id === S.pid ? 'on' : ''}" data-id="${p.id}"><b title="${esc(p.title)}">${esc(p.title)}</b><span class="muted">${sub}</span>${j ? `<div class="mini"><i style="width:${(j.progress * 100).toFixed(0)}%"></i></div>` : ''}</div>`;
  }).join('') || '<div class="muted" style="padding:6px">Пока пусто</div>';
  if (!S.pid && S.projects.length) openProject(S.projects[0].id);
}
$('#projectList').onclick = e => { const el = e.target.closest('.proj'); if (el) openProject(el.dataset.id); };

async function openProject(pid) {
  S.pid = pid; S.cur = null; S.sig = null; S.sel = null; S.a = S.b = null; S.loop = false; S.clipsSig = ''; S.videoPid = null;
  video.removeAttribute('src'); video.load();
  $('#empty').hidden = true; $('#work').hidden = false;
  await pollProject(true);
  refreshList().catch(() => { });
}

async function pollProject(first = false) {
  if (!S.pid) return;
  const pid = S.pid;
  let p;
  try { p = await api('/api/projects/' + pid); } catch (e) { if (first) toast(e.message); return; }
  if (pid !== S.pid) return;
  const old = S.cur;
  S.cur = p;
  if (p.width && S.videoPid !== pid) { S.videoPid = pid; video.src = `/api/projects/${pid}/video?q=${p.width}x${p.height}x${p.fps}`; S.view = [0, p.duration || 1]; }
  if (p.status === 'ready' && (!S.sig || !old || old.status !== 'ready')) loadSignals();
  renderHead(); renderClips();
}
async function loadSignals() {
  const s = await api(`/api/projects/${S.pid}/signals`);
  S.sig = s; S.sigMax = Math.max(1, ...s.score); S.chatMax = Math.max(1, ...s.chat);
}

function renderHead() {
  const p = S.cur;
  $('#pTitle').textContent = p.title;
  const bits = [p.channel, p.duration ? fmt(p.duration) : '', p.width ? `${p.width}×${p.height} · ${Math.round(p.fps || 30)} fps` : '', p.words != null ? `слов: ${p.words}` : '', p.chat_messages ? `сообщений чата: ${p.chat_messages}` : ''];
  $('#pMeta').textContent = bits.filter(Boolean).join(' · ');
  const j = (p.jobs || []).find(j => j.kind === 'analyze' || j.kind === 'redownload');
  if (j?.kind === 'redownload') S.redl = true;
  else if (S.redl && !j) { S.redl = false; video.src = `/api/projects/${p.id}/video?v=${Date.now()}`; toast(`Видео перекачано: ${p.width}×${p.height}, ${Math.round(p.fps)} fps`); }
  $('#redlBtn').hidden = !p.url; $('#redlBtn').disabled = !!j || !p.width;
  $('#job').hidden = !j;
  if (j) { $('#jobBar').style.width = (j.progress * 100).toFixed(1) + '%'; $('#jobText').textContent = `${j.stage} — ${(j.progress * 100).toFixed(0)}%`; }
  $('#reanalyzeBtn').disabled = !!j || !p.width;
  let w = (p.warnings || []).map(x => `<div class="warn">${esc(x)}</div>`).join('');
  if (p.status === 'error') w += `<div class="warn err">Ошибка: ${esc(p.error)}</div>`;
  $('#warnings').innerHTML = w;
}

/* ================================================================ список клипов */
const clip = id => S.cur?.clips.find(c => c.id === (id ?? S.sel));
const sortedClips = () => [...(S.cur?.clips || [])].sort((x, y) => (y.score ?? 1000) - (x.score ?? 1000) || x.start - y.start);
function renderClips(force = false) {
  const p = S.cur, rj = (p.jobs || []).filter(j => j.kind === 'render');
  const sig = JSON.stringify([p.clips, rj.map(j => [j.cid, j.status, Math.round(j.progress * 50)]), S.sel]);
  if (!force && sig === S.clipsSig) return;
  if (!force && document.activeElement?.classList.contains('title')) return;
  S.clipsSig = sig;
  const list = sortedClips();
  $('#clipCount').textContent = list.length ? `${list.length} · готово ${list.filter(c => c.status === 'rendered').length}` : '';
  $('#renderAllBtn').disabled = !list.length;
  $('#clips').innerHTML = list.map(c => {
    const j = rj.find(j => j.cid === c.id);
    const sc = c.score == null ? '<span class="score" title="Создан вручную">✂</span>' : `<span class="score ${c.score >= 70 ? 'hi' : c.score >= 50 ? 'mid' : ''}" title="Оценка вирусности">${c.score}</span>`;
    const src = { llm: 'выбрала нейросеть', signal: 'всплеск эмоций', manual: 'вручную' }[c.source] || '';
    let bottom;
    if (j || c.status === 'queued' || c.status === 'rendering') bottom = `<div class="bar"><i style="width:${((j?.progress || 0) * 100).toFixed(0)}%"></i></div><span class="muted">${j?.status === 'running' ? 'рендер…' : 'в очереди'}</span>`;
    else if (c.status === 'rendered') bottom = `<button class="primary" data-act="view">▶ Шортс</button><a class="btn ghost" href="/api/projects/${p.id}/clips/${c.id}/file?download=1" data-act="dl">Скачать</a><button class="ghost" data-act="render" title="Отрендерить заново">↻</button>${c.stale ? '<span class="tag stale" title="Настройки изменились после рендера">изменён</span>' : '<span class="tag done">готов</span>'}`;
    else bottom = `<button class="primary" data-act="render">Сделать шортс</button>${c.status === 'error' ? `<span class="tag err" title="${esc(c.error)}">ошибка</span>` : ''}`;
    return `<div class="clip ${c.id === S.sel ? 'on' : ''}" data-id="${c.id}">
      <div class="top">${sc}<input class="title" value="${esc(c.title)}" maxlength="80"><button class="ghost danger" data-act="del" title="Удалить">✕</button></div>
      <div class="muted mono">${fmt(c.start)} – ${fmt(c.end)} · ${(c.end - c.start).toFixed(0)} с <span class="tag">${src}</span>${c.layout ? ' <span class="tag">настроен</span>' : ''}</div>
      ${c.reason ? `<div class="reason">${esc(c.reason)}</div>` : ''}
      ${c.text ? `<div class="text">${esc(c.text)}</div>` : ''}
      <div class="bottom"><button class="ghost" data-act="play" title="Проиграть отрезок">▶</button><button class="ghost" data-act="edit">✎ Редактор</button>${bottom}</div></div>`;
  }).join('') || `<div class="muted">${p.status === 'ready' ? 'Моменты не найдены. Выдели отрезок на шкале и вырежи клип вручную.' : 'Клипы появятся после анализа. Свой клип можно вырезать уже сейчас, как только загрузится видео.'}</div>`;
}

function selectClip(id, seek = true) {
  const c = clip(id); if (!c) return;
  S.sel = id; S.a = c.start; S.b = c.end;
  if (seek) video.currentTime = c.start;
  const len = S.view[1] - S.view[0];
  if (c.start < S.view[0] || c.end > S.view[1]) { const v0 = clamp(c.start - len / 2, 0, Math.max(0, S.cur.duration - len)); S.view = [v0, v0 + len]; }
  renderClips(true); updateRange();
}

function showViewer(id) {
  const base = `/api/projects/${S.pid}/clips/${id}`;
  video.pause(); ev.pause();
  $('#viewerVideo').src = base + '/file?t=' + Date.now(); $('#viewerDownload').href = base + '/file?download=1';
  $('#viewer').showModal(); $('#viewerVideo').play().catch(() => { });
}
$('#clips').addEventListener('click', run(async e => {
  const card = e.target.closest('.clip'); if (!card) return;
  const id = card.dataset.id, act = e.target.dataset.act, base = `/api/projects/${S.pid}/clips/${id}`;
  if (act === 'dl') return;
  if (act === 'del') { await api(base, 'DELETE'); if (S.sel === id) S.sel = null; return pollProject(); }
  if (act === 'render') { await api(base + '/render', 'POST'); return pollProject(); }
  if (act === 'view') return showViewer(id);
  if (act === 'edit') return openEditor(id);
  if (e.target.classList.contains('title')) { if (S.sel !== id) selectClip(id, false); return; }
  selectClip(id);
  if (act === 'play') { S.loop = true; $('#loopBtn').classList.add('on'); video.play().catch(() => { }); }
}));
$('#clips').addEventListener('dblclick', e => { const card = e.target.closest('.clip'); if (card && !e.target.closest('button, input, a')) openEditor(card.dataset.id); });
$('#clips').addEventListener('change', run(async e => {
  if (!e.target.classList.contains('title')) return;
  const id = e.target.closest('.clip').dataset.id;
  await api(`/api/projects/${S.pid}/clips/${id}`, 'PUT', { title: e.target.value.trim() || 'Клип' });
  pollProject();
}));
$('#viewerClose').onclick = () => $('#viewer').close();
$('#viewer').addEventListener('close', () => { const v = $('#viewerVideo'); v.pause(); v.removeAttribute('src'); v.load(); });   /* отпускаем файл, иначе его нельзя перезаписать */

/* ================================================================ отрезок на главном экране */
function updateRange() {
  const ok = S.a != null && S.b != null && S.b - S.a >= 1;
  $('#rangeText').textContent = S.a == null ? '—' : S.b == null ? fmt(S.a, true) + ' – …' : `${fmt(S.a, true)} – ${fmt(S.b, true)} · ${(S.b - S.a).toFixed(1)} с`;
  $('#newClipBtn').disabled = !ok;
}
function setRange(a, b) {
  const d = S.cur?.duration || 0;
  if (a != null) S.a = clamp(a, 0, d); if (b != null) S.b = clamp(b, 0, d);
  if (S.a != null && S.b != null && S.b < S.a) [S.a, S.b] = [S.b, S.a];
  updateRange();
}
$('#inBtn').onclick = () => setRange(video.currentTime, null);
$('#outBtn').onclick = () => setRange(null, video.currentTime);
$('#loopBtn').onclick = () => { S.loop = !S.loop; $('#loopBtn').classList.toggle('on', S.loop); if (S.loop && S.a != null) { video.currentTime = S.a; video.play().catch(() => { }); } };
$('#playBtn').onclick = () => video.paused ? video.play().catch(() => { }) : video.pause();
$('#newClipBtn').onclick = run(async () => {
  const c = await api(`/api/projects/${S.pid}/clips`, 'POST', { start: S.a, end: S.b, title: 'Мой клип' });
  await pollProject(); S.sel = c.id; openEditor(c.id);
});
document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || !S.cur || document.querySelector('dialog[open]')) return;
  const k = e.code, v = E.open ? ev : video;
  if (k === 'Space') { e.preventDefault(); (E.open ? $('#edPlay') : $('#playBtn')).click(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); v.currentTime += (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1); }
  else if (E.open) { if (k === 'Escape') closeEditor(); }
  else if (k === 'KeyI') $('#inBtn').click();
  else if (k === 'KeyO') $('#outBtn').click();
  else if (k === 'Enter' && !$('#newClipBtn').disabled) $('#newClipBtn').click();
});

/* ================================================================ шкала стрима */
const tl = $('#timeline');
const t2x = t => (t - S.view[0]) / (S.view[1] - S.view[0]) * tl.clientWidth;
const x2t = x => S.view[0] + x / tl.clientWidth * (S.view[1] - S.view[0]);
function prepCanvas(cv) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  return [g, W, H];
}
function drawCurve(g, arr, max, color, fill, W, top, base, xToT) {
  if (!arr?.length) return;
  g.beginPath(); g.moveTo(0, base);
  for (let x = 0; x <= W; x += 2) {
    const i0 = Math.floor(xToT(x)), i1 = Math.max(i0 + 1, Math.ceil(xToT(x + 2)));
    let m = 0; for (let i = Math.max(0, i0); i < Math.min(arr.length, i1); i++) if (arr[i] > m) m = arr[i];
    g.lineTo(x, base - (base - top) * Math.min(1, m / max));
  }
  if (fill) { g.lineTo(W, base); g.closePath(); g.fillStyle = color; g.fill(); } else { g.strokeStyle = color; g.lineWidth = 1.2; g.stroke(); }
}
function drawTicks(g, v0, v1, W, H, toX) {
  const span = v1 - v0, steps = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600], step = steps.find(s => span / s <= W / 80) || 7200;
  g.fillStyle = '#8b90a0'; g.font = '10.5px Consolas, monospace';
  for (let t = Math.ceil(v0 / step) * step; t < v1; t += step) { const x = toX(t); g.fillRect(x, H - 14, 1, 4); g.fillText(fmt(t), x + 3, H - 3); }
}
function drawTimeline() {
  const [g, W, H] = prepCanvas(tl);
  if (!S.cur) return;
  const [v0, v1] = S.view;
  drawCurve(g, S.sig?.score, S.sigMax, 'rgba(139,92,246,.55)', true, W, 16, H - 16, x2t);
  if (S.sig?.has_chat) drawCurve(g, S.sig.chat, S.chatMax, 'rgba(34,211,238,.8)', false, W, 16, H - 16, x2t);
  for (const c of S.cur.clips) {
    const x = t2x(c.start), w = Math.max(3, t2x(c.end) - x), on = c.id === S.sel;
    g.fillStyle = c.status === 'rendered' ? '#34d399' : on ? '#c4b5fd' : '#8b5cf6';
    g.fillRect(x, 3, w, on ? 10 : 7);
  }
  if (S.a != null) {
    const xa = t2x(S.a), xb = t2x(S.b ?? S.a);
    g.fillStyle = 'rgba(34,211,238,.16)'; g.fillRect(xa, 0, xb - xa, H);
    g.fillStyle = '#22d3ee'; g.fillRect(xa - 1, 0, 2, H); if (S.b != null) g.fillRect(xb - 1, 0, 2, H);
  }
  drawTicks(g, v0, v1, W, H, t2x);
  g.fillStyle = '#fff'; g.fillRect(t2x(video.currentTime) - 1, 0, 2, H);
}
let drag = null;
tl.addEventListener('mousedown', e => {
  if (!S.cur) return;
  const x = e.offsetX, near = t => t != null && Math.abs(t2x(t) - x) < 6;
  drag = { x, t: x2t(x), moved: false, edge: near(S.a) ? 'a' : near(S.b) ? 'b' : null };
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const x = e.clientX - tl.getBoundingClientRect().left, t = clamp(x2t(x), 0, S.cur.duration);
  if (!drag.moved && Math.abs(x - drag.x) < 4) return;
  drag.moved = true;
  if (drag.edge === 'a') setRange(Math.min(t, S.b - 1), null);
  else if (drag.edge === 'b') setRange(null, Math.max(t, S.a + 1));
  else { S.a = Math.min(drag.t, t); S.b = Math.max(drag.t, t); if (S.sel) { S.sel = null; renderClips(true); } updateRange(); }
});
window.addEventListener('mouseup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved) return;
  const hit = e.offsetY < 16 && S.cur.clips.find(c => d.t >= c.start && d.t <= c.end);
  if (hit) selectClip(hit.id); else video.currentTime = d.t;
});
tl.addEventListener('wheel', e => {
  if (!S.cur) return; e.preventDefault();
  const d = S.cur.duration; let [v0, v1] = S.view, len = v1 - v0;
  if (e.shiftKey) { const sh = len * 0.15 * Math.sign(e.deltaY || e.deltaX); v0 = clamp(v0 + sh, 0, d - len); v1 = v0 + len; }
  else { const t = x2t(e.offsetX), k = e.deltaY > 0 ? 1.3 : 1 / 1.3; len = clamp(len * k, 15, d); v0 = clamp(t - (t - v0) * (len / (v1 - v0)), 0, d - len); v1 = v0 + len; }
  S.view = [v0, v1];
}, { passive: false });

/* ================================================================ раскладка (та же логика, что в clipper/render.py: plan) */
let OW = 1080, OH = 1920;      /* размер итогового кадра — берётся из раскладки клипа */
const even = v => Math.max(2, Math.round(v / 2) * 2);
function region(r, W, H) { const x = clamp(r.x ?? 0, 0, .98), y = clamp(r.y ?? 0, 0, .98), w = clamp(r.w ?? 1, .02, 1 - x), h = clamp(r.h ?? 1, .02, 1 - y); return [x * W, y * H, w * W, h * H]; }
function cover([x, y, w, h], aspect, fx = .5, fy = .5) {
  let cw, ch; if (w / h > aspect) { cw = h * aspect; ch = h; } else { cw = w; ch = w / aspect; }
  cw = even(cw); ch = even(ch);
  return [Math.max(0, Math.floor(x + (w - cw) * fx)), Math.max(0, Math.floor(y + (h - ch) * fy)), cw, ch];
}
function inset(reg, crop) {
  if (!crop) return reg;
  const [x, y, w, h] = reg, l = clamp(crop.l || 0, 0, .9), t = clamp(crop.t || 0, 0, .9);
  const r = Math.min(clamp(crop.r || 0, 0, .9), .92 - l), b = Math.min(clamp(crop.b || 0, 0, .9), .92 - t);
  return [x + w * l, y + h * t, w * (1 - l - r), h * (1 - t - b)];
}
function camMask(L, W, H) { const c = region(L.cam, W, H), z = clamp(L.cam_zoom ?? 1, 1, 3); return [c[0] + c[2] * (1 - 1 / z) / 2, c[1] + c[3] * (1 - 1 / z) / 2, c[2] / z, c[3] / z]; }
function plan(L, W, H) {
  const ow = even(clamp(L.out_w || 1080, 240, 3840)), oh = even(clamp(L.out_h || 1920, 240, 3840)), A = ow / oh, sy = oh / 1920;
  const mode = L.mode || 'split', fx = clamp(L.focus_x ?? .5, 0, 1), fy = clamp(L.focus_y ?? .5, 0, 1);
  const game = inset(region(L.game || {}, W, H), L.game_crop);
  const cam = (mode === 'split' || mode === 'pip') && L.cam_source !== 'off' && L.cam ? inset(camMask(L, W, H), L.cam_crop) : null;
  const cam_dy = Math.trunc(L.cam_dy || 0), game_dy = Math.trunc(L.game_dy || 0);
  const items = []; let bg = null, title_y = 90 * sy;
  if (mode === 'fill' || mode === 'pip') {
    items.push({ src: cover(game, A, fx, fy), dst: [0, 0, ow, oh] });
    if (cam) {
      const w = even(ow * clamp(L.pip_size ?? .45, .2, .9)), h = Math.min(even(w * cam[3] / cam[2]), even(oh * .6));
      const x = Math.floor((ow - w) * clamp(L.pip_x ?? .5, 0, 1)), y = Math.floor((oh - h) * clamp(L.pip_y ?? .05, 0, 1));
      items.push({ src: cover(cam, w / h), dst: [x, y, w, h], border: 6, cam: true });
      if (y < 320 * sy) title_y = y + h + 40 * sy;
    }
  } else if (mode === 'split') {
    let cam_h = 0;
    if (cam) { const r = +L.cam_ratio || 0; cam_h = r > 0.01 ? even(oh * clamp(r, .12, .6)) : even(Math.min(ow * cam[3] / cam[2], oh * .45)); }
    const avail = oh - cam_h, h0 = Math.min(avail, ow * game[3] / game[2]);
    const game_h = Math.min(avail, even(h0 + (avail - h0) * clamp(L.game_zoom ?? 0, 0, 1))), left = oh - cam_h - game_h;
    let y0 = (L.title_overlay && left >= 250 * sy) ? even(left * .62) : Math.floor(left / 4) * 2;
    if (left < 2) y0 = 0;
    let [cam_y, game_y] = L.cam_pos === 'bottom' ? [y0 + game_h, y0] : [y0, y0 + cam_h];
    if (cam) cam_y = Math.trunc(clamp(cam_y + cam_dy, 0, oh - cam_h));
    game_y = Math.trunc(clamp(game_y + game_dy, 0, oh - game_h));
    items.push({ src: cover(game, ow / game_h, fx, fy), dst: [0, game_y, ow, game_h] });
    if (cam) items.push({ src: cover(cam, ow / cam_h), dst: [0, cam_y, ow, cam_h], cam: true });
    if (left >= 2) bg = cover(game, A, fx, fy);
    const top_y = cam ? Math.min(cam_y, game_y) : game_y;
    title_y = top_y >= 215 * sy ? Math.max(40 * sy, top_y - 215 * sy) : 90 * sy;
  } else {
    const zoom = clamp(L.zoom ?? 1, 1, 3), aspect = Math.max(A, (game[2] / zoom) / game[3]);
    const fg_h = Math.min(oh, even(ow / aspect)), top = Math.trunc(clamp(Math.floor((oh - fg_h) / 4) * 2 + game_dy, 0, oh - fg_h));
    items.push({ src: cover(game, ow / fg_h, fx, fy), dst: [0, top, ow, fg_h] });
    if (fg_h < oh) bg = cover(game, A, fx, fy);
    title_y = Math.max(60 * sy, top - 250 * sy);
  }
  for (const it of items) {       /* свободные окна */
    const box = it.cam ? L.cam_box : L.game_box; if (!box) continue;
    const w = Math.min(ow, even(clamp(box.w ?? 1, .05, 1) * ow)), h = Math.min(oh, even(clamp(box.h ?? 1, .03, 1) * oh));
    const x = Math.trunc(clamp((box.x || 0) * ow, 0, ow - w)), y = Math.trunc(clamp((box.y || 0) * oh, 0, oh - h));
    it.dst = [x, y, w, h]; it.src = cover(it.cam ? cam : game, w / h, .5, .5); it.free = true;
    bg = bg || cover(game, A, fx, fy);
  }
  (L.extras || []).forEach((ex, i) => {     /* куски кадра поверх всего */
    const box = ex.box || {};
    const w = Math.min(ow, even(clamp(box.w ?? .5, .03, 1) * ow)), h = Math.min(oh, even(clamp(box.h ?? .2, .02, 1) * oh));
    const x = Math.trunc(clamp((box.x || 0) * ow, 0, ow - w)), y = Math.trunc(clamp((box.y || 0) * oh, 0, oh - h));
    items.push({ src: cover(region(ex.src || {}, W, H), w / h), dst: [x, y, w, h], extra: i });
  });
  for (const lay of L.layers || []) {      /* слои: куски кадра и картинки, каждый в своё время */
    if (lay.hidden || !['crop', 'image'].includes(lay.kind) || (lay.kind === 'image' && !lay.asset)) continue;
    const box = lay.box || {};
    const w = Math.min(ow, even(clamp(box.w ?? .3, .02, 1) * ow)), h = Math.min(oh, even(clamp(box.h ?? .1, .01, 1) * oh));
    const x = Math.trunc(clamp((box.x || 0) * ow, -w + 2, ow - 2)), y = Math.trunc(clamp((box.y || 0) * oh, -h + 2, oh - 2));
    const it = { dst: [x, y, w, h], layer: lay.id, t: layerTime(lay), opacity: clamp(lay.opacity ?? 1, 0, 1), fade: clamp(lay.fade || 0, 0, 5) };
    if (lay.kind === 'crop') it.src = cover(region(lay.src || {}, W, H), w / h); else it.img = lay.asset;
    items.push(it);
  }
  if (L.title_pos != null) title_y = oh * clamp(L.title_pos, 0, .95);
  return { bg, items, title_y: Math.trunc(title_y), out: [ow, oh], bg_dim: clamp(L.bg_dim ?? .12, 0, .8) };
}
function layerTime(lay) { const s = Math.max(0, +lay.s || 0); return [s, lay.e == null || lay.e === '' ? null : Math.max(s + .05, +lay.e)]; }
function groupWords(words, maxWords = 3) {
  const groups = []; let cur = [];
  for (const w of words) {
    const chars = cur.reduce((n, x) => n + x.w.length, 0) + cur.length;
    if (cur.length && (cur.length >= maxWords || chars + w.w.length > 18 || w.s - cur[cur.length - 1].e > 0.6 || /[.?!…]$/.test(cur[cur.length - 1].w))) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}
function wrapText(g, text, maxW) { const out = []; let line = ''; for (const w of text.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (line && g.measureText(t).width > maxW) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; }

/* ================================================================ редактор шортса */
const E = { open: false, id: null, L: null, title: '', start: 0, end: 0, det: undefined, detBusy: false, words: [], subEdits: {}, eff: [], groups: [], dirty: false, saving: false, saveT: null, detT: null, wordsT: null, view: [0, 1], drag: null, tdrag: null, pdrag: null, plan: null, zones: [], hover: null };
const ev = $('#edVideo'), eo = $('#edOverlay'), et = $('#edTrim'), pv = $('#preview'), K = 0.5;
let PW = 540, PH = 960;
const usesCam = () => E.L.mode === 'split' || E.L.mode === 'pip';
const effL = () => ({ ...E.L, cam: !usesCam() || E.L.cam_source === 'off' ? null : E.L.cam_source === 'auto' ? (E.det || null) : E.L.cam });
const srcSize = () => [S.cur?.width || 1920, S.cur?.height || 1080];

async function openEditor(id) {
  const c = clip(id); if (!c) return;
  if (!S.cur.width) return toast('Видео ещё скачивается');
  video.pause(); S.sel = id;
  Object.assign(E, { open: true, id, L: JSON.parse(JSON.stringify({ ...S.cur.layout, ...(c.layout || {}) })), title: c.title, start: c.start, end: c.end, det: undefined, words: [], subEdits: { ...(c.sub_edits || {}) }, eff: [], groups: [], dirty: false, drag: null });
  migrateExtras(E.L); E.lastSel = undefined; loadPresets();
  E.audio = { vol: c.audio?.vol ?? 1, regions: JSON.parse(JSON.stringify(c.audio?.regions || [])) }; E.asel = null; E.arange = null; E.playTo = null; E.wave = null; E.waveKey = '';
  E.chat = []; E.chatHidden = [...(c.chat_hidden || [])]; E.sel = null;
  renderSubEdit(); syncAud(); renderChatList(); loadChat();
  $('#editor').hidden = false; $('#edTitle').value = c.title;
  const src = `/api/projects/${S.pid}/video?q=${S.cur.width}x${S.cur.height}x${S.cur.fps}`;
  if (!ev.src.endsWith(src)) ev.src = src;
  ev.currentTime = c.start;
  fitTrimView(); syncEd(); loadEdWords(); detect();
}
async function closeEditor() {
  await save().catch(e => toast(e.message));
  ev.pause(); E.open = false; $('#editor').hidden = true; if (acB) acB.gain.value = 0;
  const c = clip(E.id); if (c) { S.a = c.start; S.b = c.end; updateRange(); }
  await pollProject(); renderClips(true);
}
function change(patch) { Object.assign(E.L, patch); if ('sub_words' in patch) refreshWords(); if ('chat_shift' in patch) renderChatList(); touch(); syncEd(); }
function touch() { E.dirty = true; clearTimeout(E.saveT); E.saveT = setTimeout(() => save().catch(e => toast(e.message)), 700); }
async function save() {
  clearTimeout(E.saveT);
  if (!E.dirty || !E.id) return;
  E.dirty = false; E.saving = true;
  const body = { title: E.title.trim() || 'Клип', start: E.start, end: E.end, layout: E.L, sub_edits: E.subEdits, audio: E.audio, chat_hidden: E.chatHidden };
  try {
    const c = await api(`/api/projects/${S.pid}/clips/${E.id}`, 'PUT', body);
    const i = S.cur.clips.findIndex(x => x.id === c.id); if (i >= 0) S.cur.clips[i] = c;
  } catch (e) { E.dirty = true; throw e; } finally { E.saving = false; }
}
async function detect(force = false) {
  if (!usesCam() || E.L.cam_source !== 'auto') return;
  const id = E.id, key = E.start + '-' + E.end;
  E.detBusy = true; syncEd();
  try {
    const r = await api(`/api/projects/${S.pid}/detect_cam`, 'POST', { start: E.start, end: E.end, force });
    if (E.id !== id || key !== E.start + '-' + E.end) return;
    E.det = r.cam; if (r.cam) E.L.cam = r.cam;
  } catch (e) { toast(e.message); E.det = null; } finally { E.detBusy = false; syncEd(); }
}
async function loadEdWords() {
  const id = E.id;
  try { const w = await api(`/api/projects/${S.pid}/words?start=${(E.start - 1).toFixed(2)}&end=${(E.end + 1).toFixed(2)}`); if (E.id === id) { E.words = w; renderSubEdit(); } } catch { }
}
/* слова с учётом правок пользователя; пересчитываются при любом изменении */
function refreshWords() {
  E.eff = E.words.filter(w => w.e > E.start && w.s < E.end).map(w => { const k = w.s.toFixed(2); return k in E.subEdits ? { ...w, w: E.subEdits[k].trim() } : w; }).filter(w => w.w)
    .map(w => bleeped(w) ? { ...w, w: w.w[0] + '*'.repeat(Math.max(2, w.w.replace(/[.,!?…]+$/, '').length - 1)) } : w);     /* слово под «пиком» закрыто звёздочками */
  E.groups = groupWords(E.eff, clamp(E.L.sub_words ?? 3, 1, 6));
}
function renderSubEdit() {
  refreshWords();
  const inRange = E.words.filter(w => w.e > E.start && w.s < E.end);
  $('#subReset').hidden = !Object.keys(E.subEdits).length;
  let html = '', prev = null;
  for (const w of inRange) {
    const k = w.s.toFixed(2), ed = k in E.subEdits, val = ed ? E.subEdits[k] : w.w;
    if (prev && (w.s - prev.e > 0.8 || /[.?!…]$/.test(prev.w))) html += '<span class="brk"></span>';
    html += `<input data-k="${k}" data-t="${w.s}" data-o="${esc(w.w)}" value="${esc(val)}" size="${Math.max(2, val.length || w.w.length)}" class="${ed ? (val.trim() ? 'edited' : 'off') : ''}" placeholder="${esc(w.w)}">`;
    prev = w;
  }
  $('#subEdit').innerHTML = html || '<span class="muted">В этом отрезке речи не найдено.</span>';
  markBleeps();
}
$('#subEdit').addEventListener('focusin', e => { if (e.target.dataset.t) { ev.pause(); ev.currentTime = Math.max(E.start, parseFloat(e.target.dataset.t) + 0.05); } });
$('#subEdit').addEventListener('input', e => {
  const el = e.target, k = el.dataset.k; if (!k) return;
  if (el.value === el.dataset.o) delete E.subEdits[k]; else E.subEdits[k] = el.value;
  el.size = Math.max(2, el.value.length); el.className = k in E.subEdits ? (el.value.trim() ? 'edited' : 'off') : '';
  $('#subReset').hidden = !Object.keys(E.subEdits).length;
  refreshWords(); touch();
});
$('#subReset').onclick = () => { E.subEdits = {}; renderSubEdit(); touch(); };
function fitTrimView() { const d = S.cur.duration, pad = Math.max(15, (E.end - E.start) * 0.5); E.view = [Math.max(0, E.start - pad), Math.min(d, E.end + pad)]; }
function setTrim(start, end, refit = true) {
  const d = S.cur.duration;
  E.start = +clamp(start, 0, Math.max(0, end - 1)).toFixed(2); E.end = +clamp(end, E.start + 1, d).toFixed(2);
  touch(); syncEd(); refreshWords();
  if (refit) { const len = E.view[1] - E.view[0]; if (E.start < E.view[0] || E.end > E.view[1]) { const pad = len * 0.08; E.view = [Math.max(0, Math.min(E.view[0], E.start - pad)), Math.min(d, Math.max(E.view[1], E.end + pad))]; } }
  clearTimeout(E.wordsT); E.wordsT = setTimeout(() => { loadEdWords(); loadChat(); }, 400);
  if (usesCam() && E.L.cam_source === 'auto') { clearTimeout(E.detT); E.detT = setTimeout(() => detect(), 900); }
}

function gameKind() {
  const g = E.L.game, [W, H] = srcSize(), w43 = Math.min(1, H * 4 / 3 / W);
  if (g.w > .999 && g.h > .999) return 'full';
  if (Math.abs(g.w - w43) < .004 && Math.abs(g.x - (1 - w43) / 2) < .004 && g.h > .999) return '43';
  return 'custom';
}
const game43 = () => { const [W, H] = srcSize(), w = +Math.min(1, H * 4 / 3 / W).toFixed(4); return { x: +((1 - w) / 2).toFixed(4), y: 0, w, h: 1 }; };
function syncEd() {
  if (!E.open) return;
  const L = E.L;
  $$('#editor [data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(L[seg.dataset.seg]))));
  $$('#editor [data-l]').forEach(el => { if (el.type === 'checkbox') el.checked = !!L[el.dataset.l]; else if (document.activeElement !== el || el.tagName === 'SELECT') el.value = L[el.dataset.l] ?? 0; });
  $('#resetPos').parentElement.hidden = !(L.cam_dy || L.game_dy || L.title_pos != null || L.cam_box || L.game_box || L.cam_crop || L.game_crop);
  fitPreview();
  const fmtKey = `${L.out_w || 1080}x${L.out_h || 1920}`, fs = $('#fmtSel'); fs.value = [...fs.options].some(o => o.value === fmtKey) ? fmtKey : 'custom';
  $$('#editor [data-modes]').forEach(el => el.hidden = !el.dataset.modes.split(' ').includes(L.mode));
  const gk = gameKind(); $$('#gameSeg button').forEach(b => b.classList.toggle('on', b.dataset.g === gk));
  const src = L.cam_source;
  $('#camInfo').textContent = src === 'off' ? 'Вебка скрыта' : src === 'manual' ? (L.cam ? 'Своя рамка — тяни её на кадре' : 'Нарисуй рамку вебки на исходном кадре')
    : E.detBusy ? 'Ищу вебку…' : E.det ? 'Найдена автоматически' : E.det === null ? 'В этом клипе вебки нет — будет только игра' : '';
  $('#camRedetect').hidden = src === 'off';
  syncExport(); renderLayers(); $('#chatShiftVal').textContent = (+L.chat_shift || 0).toFixed(1) + ' с';
  $('#edRange').textContent = `${fmt(E.start, true)} – ${fmt(E.end, true)} · ${(E.end - E.start).toFixed(1)} с`;
  const order = sortedClips().map(c => c.id), i = order.indexOf(E.id);
  $('#edPrev').disabled = i <= 0; $('#edNext').disabled = i < 0 || i >= order.length - 1;
}

$$('#editor [data-seg]').forEach(seg => seg.onclick = e => {
  const v = e.target.dataset.v; if (!v) return;
  const key = seg.dataset.seg; change({ [key]: v });
  if (usesCam() && E.L.cam_source === 'auto' && (key === 'cam_source' || E.det === undefined)) detect();
});
$$('#editor [data-l]').forEach(el => {
  const read = () => el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number' || el.dataset.num != null) ? (parseFloat(el.value) || 0) : el.value;
  if (el.type === 'number') el.onchange = () => change({ [el.dataset.l]: read() });      /* числа применяем по завершении ввода */
  else el.oninput = el.onchange = () => change({ [el.dataset.l]: read() });
});
$('#resetPos').onclick = () => change({ cam_dy: 0, game_dy: 0, title_pos: null, pip_x: .5, pip_y: .05, focus_x: .5, focus_y: .5, cam_box: null, game_box: null, cam_crop: null, game_crop: null });
$('#gameSeg').onclick = e => {
  const g = e.target.dataset.g; if (!g) return;
  change({ game: g === 'full' ? { x: 0, y: 0, w: 1, h: 1 } : g === '43' ? game43() : (gameKind() === 'custom' ? E.L.game : { x: .1, y: .1, w: .8, h: .8 }) });
};
$('#presetOsu').onclick = () => { change({ mode: 'split', cam_pos: 'top', cam_ratio: 0, game: game43(), game_zoom: 0, focus_x: .5, focus_y: .5 }); if (E.L.cam_source === 'auto' && E.det === undefined) detect(); };
$('#presetWide').onclick = () => { change({ mode: 'split', cam_pos: 'top', cam_ratio: 0, game: { x: 0, y: 0, w: 1, h: 1 }, game_zoom: 1, focus_x: .5, focus_y: .5 }); if (E.L.cam_source === 'auto' && E.det === undefined) detect(); };
$('#camRedetect').onclick = () => { change({ cam_source: 'auto' }); detect(true); };
$('#edTitle').oninput = e => { E.title = e.target.value; touch(); };
$('#edBack').onclick = () => closeEditor();
$('#edPlay').onclick = () => ev.paused ? ev.play().catch(() => { }) : ev.pause();
$('#edView').onclick = () => showViewer(E.id);
$('#edRender').onclick = run(async () => { await save(); await api(`/api/projects/${S.pid}/clips/${E.id}/render`, 'POST'); await pollProject(); });
const edStep = d => run(async () => { const order = sortedClips().map(c => c.id), id = order[order.indexOf(E.id) + d]; if (!id) return; await save(); await openEditor(id); });
$('#edPrev').onclick = edStep(-1); $('#edNext').onclick = edStep(1);
$$('#editor .nudge button').forEach(b => b.onclick = () => {
  const m = b.dataset.n.match(/^(start|end)(.+)$/), d = parseFloat(m[2]);
  if (m[1] === 'start') { setTrim(E.start + d, E.end); ev.currentTime = E.start; } else { setTrim(E.start, E.end + d); ev.currentTime = Math.max(E.start, E.end - 2); }
});

/* ---- маски на исходном кадре: двигать, тянуть за края, рисовать новую ---- */
function edBox() {
  const cw = eo.clientWidth, ch = eo.clientHeight, [W, H] = srcSize(), s = Math.min(cw / W, ch / H);
  return { x: (cw - W * s) / 2, y: (ch - H * s) / 2, w: W * s, h: H * s };
}
function hitRect(r, mx, my, allowMove = true) {
  if (!r) return null;
  const b = edBox(), x0 = b.x + r.x * b.w, y0 = b.y + r.y * b.h, x1 = x0 + r.w * b.w, y1 = y0 + r.h * b.h, T = 9;
  if (mx < x0 - T || mx > x1 + T || my < y0 - T || my > y1 + T) return null;
  const h = (Math.abs(my - y0) <= T ? 'n' : Math.abs(my - y1) <= T ? 's' : '') + (Math.abs(mx - x0) <= T ? 'w' : Math.abs(mx - x1) <= T ? 'e' : '');
  return h || (allowMove ? 'move' : null);
}
function pickMask(mx, my) {
  const cam = effL().cam, game = E.L.game, full = gameKind() === 'full', crops = cropLayers(), cur = selLayer();
  let h;
  if (cur?.kind === 'crop' && cur.src) { h = hitRect(cur.src, mx, my); if (h) return { target: 'L' + cur.id, handle: h, orig: { ...cur.src } }; }
  for (let i = crops.length - 1; i >= 0; i--) {     /* невыбранные куски: щелчок по рамке только выбирает */
    if (crops[i] === cur) continue;
    const r = crops[i].src, b = edBox(), x0 = b.x + r.x * b.w, y0 = b.y + r.y * b.h;
    if (mx >= x0 && mx <= x0 + r.w * b.w && my >= y0 && my <= y0 + r.h * b.h) return { target: 'L' + crops[i].id, handle: 'pick', orig: { ...r } };
  }
  h = hitRect(cam, mx, my); if (h) return { target: 'cam', handle: h, orig: { ...cam } };
  h = hitRect(game, mx, my, !full); if (h) return { target: 'game', handle: h, orig: { ...game } };
  return usesCam() && E.L.cam_source !== 'off' ? { target: 'cam', handle: 'new', orig: cam ? { ...cam } : null } : null;
}
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move', new: 'crosshair' };
eo.addEventListener('mousedown', e => {
  const d = pickMask(e.offsetX, e.offsetY); if (!d) return;
  if (d.handle === 'pick') { E.sel = d.target; e.preventDefault(); return; }
  const b = edBox(); E.drag = { ...d, mx: e.offsetX, my: e.offsetY, nx: clamp((e.offsetX - b.x) / b.w, 0, 1), ny: clamp((e.offsetY - b.y) / b.h, 0, 1), moved: false };
  e.preventDefault();
});
eo.addEventListener('mousemove', e => { if (!E.drag) { const h = pickMask(e.offsetX, e.offsetY)?.handle; eo.style.cursor = h === 'pick' ? 'pointer' : CURSOR[h] || 'default'; } });
window.addEventListener('mousemove', e => {
  const d = E.drag; if (!d) return;
  const rc = eo.getBoundingClientRect(), b = edBox(), mx = e.clientX - rc.left, my = e.clientY - rc.top;
  if (!d.moved && Math.abs(mx - d.mx) + Math.abs(my - d.my) < 4) return;
  d.moved = true;
  const dx = (mx - d.mx) / b.w, dy = (my - d.my) / b.h, MIN = 0.04; let r;
  if (d.handle === 'new') {
    const nx = clamp((mx - b.x) / b.w, 0, 1), ny = clamp((my - b.y) / b.h, 0, 1);
    r = { x: Math.min(d.nx, nx), y: Math.min(d.ny, ny), w: Math.abs(nx - d.nx), h: Math.abs(ny - d.ny) };
  } else if (d.handle === 'move') {
    r = { ...d.orig, x: clamp(d.orig.x + dx, 0, 1 - d.orig.w), y: clamp(d.orig.y + dy, 0, 1 - d.orig.h) };
  } else {
    let l = d.orig.x, t = d.orig.y, rr = l + d.orig.w, bb = t + d.orig.h;
    if (d.handle.includes('w')) l = clamp(l + dx, 0, rr - MIN); if (d.handle.includes('e')) rr = clamp(rr + dx, l + MIN, 1);
    if (d.handle.includes('n')) t = clamp(t + dy, 0, bb - MIN); if (d.handle.includes('s')) bb = clamp(bb + dy, t + MIN, 1);
    r = { x: l, y: t, w: rr - l, h: bb - t };
  }
  for (const k in r) r[k] = +r[k].toFixed(4);
  d.rect = r;
  if (d.target === 'cam') { E.L.cam = r; E.L.cam_source = 'manual'; }
  else if (d.target[0] === 'L') { const lay = layerById(d.target.slice(1)); if (lay) { lay.src = r; fitExtraBox(lay); } }
  else E.L.game = r;
});
/* окно куска на шортсе подстраивается под пропорции выделенной части кадра (ширина сохраняется) */
function fitExtraBox(ex) {
  const [W, H] = srcSize(), a = (ex.src.w * W) / (ex.src.h * H), b = ex.box;
  let w = b.w * OW, h = w / a;
  if (h > OH * .9) { h = OH * .9; w = h * a; }
  if (w > OW) { w = OW; h = w / a; }
  const cx = (b.x + b.w / 2) * OW, cy = (b.y + b.h / 2) * OH, r4 = v => +v.toFixed(4);
  ex.box = { x: r4(clamp(cx - w / 2, 0, OW - w) / OW), y: r4(clamp(cy - h / 2, 0, OH - h) / OH), w: r4(w / OW), h: r4(h / OH) };
}
window.addEventListener('mouseup', () => {
  const d = E.drag; if (!d) return; E.drag = null;
  if (!d.moved) return;
  if (d.handle === 'new' && (d.rect.w < 0.04 || d.rect.h < 0.04)) { E.L.cam = d.orig; syncEd(); return; }
  touch(); syncEd();
});
function drawMasks() {
  const [g] = prepCanvas(eo), b = edBox(), L = effL();
  const box = (r, color, label, faint) => {
    const x = b.x + r.x * b.w, y = b.y + r.y * b.h, w = r.w * b.w, h = r.h * b.h;
    if (faint) {          /* невыбранный кусок кадра: только тонкая пунктирная рамка */
      g.save(); g.setLineDash([5, 4]); g.strokeStyle = color + '99'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w, h); g.restore();
      g.font = '600 11px Segoe UI'; g.fillStyle = color + 'aa'; g.fillText(label, x + 4, y + 13); return;
    }
    g.fillStyle = color + '22'; g.fillRect(x, y, w, h);
    g.strokeStyle = color; g.lineWidth = 2; g.strokeRect(x, y, w, h);
    g.fillStyle = color;
    for (const [hx, hy] of [[0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]]) g.fillRect(x + w * hx - 4, y + h * hy - 4, 8, 8);
    g.font = '600 12px Segoe UI'; const tw = g.measureText(label).width + 10;
    g.fillRect(x, Math.max(b.y, y - 18), tw, 18); g.fillStyle = '#0e0f13'; g.fillText(label, x + 5, Math.max(b.y, y - 18) + 13);
  };
  if (gameKind() !== 'full' || E.drag?.target === 'game') box(E.L.game, '#22d3ee', 'игра');
  if (L.cam) box(L.cam, '#34d399', E.L.cam_source === 'auto' ? 'вебка (авто)' : 'вебка');
  const cur = selLayer(), on = cur?.kind === 'crop' && cur.src ? cur : null;
  cropLayers().filter(l => l !== on).forEach(l => box(l.src, '#e879f9', l.name || 'кусок кадра', true));    /* остальные — пунктиром */
  if (on) box(on.src, '#e879f9', on.name || 'кусок кадра');     /* с ручками — только тот, с которым работаешь */
}

/* ---- шкала клипа: обрезка, масштаб, прокрутка ---- */
const e2x = t => (t - E.view[0]) / (E.view[1] - E.view[0]) * et.clientWidth;
const ex2t = x => E.view[0] + x / et.clientWidth * (E.view[1] - E.view[0]);
function setTrimView(v0, len) { const d = S.cur.duration; len = clamp(len, 4, d); v0 = clamp(v0, 0, d - len); E.view = [v0, v0 + len]; }
function zoomTrim(k, at) { const [v0, v1] = E.view, t = at ?? (E.start + E.end) / 2, len = (v1 - v0) * k; setTrimView(t - (t - v0) * (len / (v1 - v0)), len); }
/* кадры видео на шкале: шаг подбирается под масштаб, кадры качаются по 3 штуки и кэшируются */
const THUMBS = new Map(), TH_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]; let thumbBusy = 0;
function thumbFor(t) {
  const key = `${S.pid}|${t.toFixed(2)}`; let th = THUMBS.get(key);
  if (!th) { if (THUMBS.size > 3000) THUMBS.clear(); th = { t, img: null, state: 'new' }; THUMBS.set(key, th); }
  return th;
}
function pumpThumbs(list) {
  for (const th of list) {
    if (thumbBusy >= 3) break; if (th.state !== 'new') continue;
    th.state = 'loading'; thumbBusy++;
    const im = new Image();
    im.onload = () => { th.img = im; th.state = 'ok'; thumbBusy--; };
    im.onerror = () => { th.state = 'err'; thumbBusy--; };
    im.src = `/api/projects/${S.pid}/thumb?t=${th.t.toFixed(2)}&q=${S.cur.width}x${S.cur.height}x${S.cur.fps}`;
  }
}
function drawThumbs(g, W, TH) {
  const [sw, sh] = srcSize(), tileW = TH * sw / sh, len = E.view[1] - E.view[0];
  const step = TH_STEPS.find(s => s >= len * tileW / W) || 600, list = [];
  g.fillStyle = '#07080b'; g.fillRect(0, 0, W, TH);
  for (let t = Math.floor(E.view[0] / step) * step; t < E.view[1]; t += step) {
    if (t < 0 || t > S.cur.duration) continue;
    const th = thumbFor(+t.toFixed(2)), x = e2x(t), x1 = e2x(t + step); list.push(th);
    if (th.img) { g.save(); g.beginPath(); g.rect(x, 0, x1 - x, TH); g.clip(); g.drawImage(th.img, x, 0, tileW, TH); g.restore(); }
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x1 - 1, 0, 1, TH);
  }
  const ph = e2x(ev.currentTime); list.sort((a, b) => Math.abs(e2x(a.t) - ph) - Math.abs(e2x(b.t) - ph));     /* сначала — возле ползунка */
  pumpThumbs(list);
}
function drawTrim() {
  const [g, W, H] = prepCanvas(et), TH = 50;
  drawThumbs(g, W, TH);
  drawCurve(g, S.sig?.score, S.sigMax, 'rgba(139,92,246,.45)', true, W, TH + 4, H - 30, ex2t);
  for (const c of S.cur.clips) if (c.id !== E.id) { const x = e2x(c.start); g.fillStyle = 'rgba(139,92,246,.5)'; g.fillRect(x, 2, Math.max(2, e2x(c.end) - x), 4); }
  const xa = e2x(E.start), xb = e2x(E.end);
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, xa, H); g.fillRect(xb, 0, W - xb, H);
  g.fillStyle = 'rgba(34,211,238,.14)'; g.fillRect(xa, 0, xb - xa, H);
  g.fillStyle = '#22d3ee'; g.fillRect(xa - 4, 0, 5, H); g.fillRect(xb - 1, 0, 5, H);
  g.fillStyle = '#0e0f13'; g.fillRect(xa - 2.5, H / 2 - 8, 2, 16); g.fillRect(xb + 0.5, H / 2 - 8, 2, 16);
  g.font = '11px Segoe UI'; g.textBaseline = 'middle';
  for (const w of E.words) {        /* слова прямо на шкале — видно, где начинается и кончается фраза */
    const x = e2x(w.s), x1 = e2x(w.e); if (x1 < 0 || x > W) continue;
    const inside = w.e > E.start && w.s < E.end;
    g.fillStyle = inside ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.3)'; g.fillRect(x, H - 27, Math.max(2, x1 - x - 1), 3);
    if ((E.view[1] - E.view[0]) / W < 0.035) { g.save(); g.beginPath(); g.rect(x, H - 50, Math.max(0, e2x(w.e) - x + 30), 22); g.clip(); g.fillText(w.w, x, H - 38); g.restore(); }
  }
  g.textBaseline = 'alphabetic';
  drawTicks(g, E.view[0], E.view[1], W, H, e2x);
  g.fillStyle = '#fff'; g.fillRect(e2x(ev.currentTime) - 1, 0, 2, H);
}
et.addEventListener('mousedown', e => {
  const x = e.offsetX, near = t => Math.abs(e2x(t) - x) < 9, pan = e.altKey || e.button === 1;
  const edge = pan ? null : near(E.start) ? 'start' : near(E.end) ? 'end' : null;
  E.tdrag = { edge, pan, x, v0: E.view[0], moved: false };
  if (!pan && !edge) scrubTo(x);         /* обычное нажатие — ползунок прыгает сюда, дальше тянется за мышью */
  e.preventDefault();
});
function scrubTo(x) { const t = clamp(ex2t(clamp(x, 0, et.clientWidth)), 0, S.cur.duration); if (ev.fastSeek && Math.abs(ev.currentTime - t) > 2) ev.fastSeek(t); else ev.currentTime = t; }
et.addEventListener('mousemove', e => { if (!E.tdrag) et.style.cursor = e.altKey ? 'grab' : Math.abs(e2x(E.start) - e.offsetX) < 9 || Math.abs(e2x(E.end) - e.offsetX) < 9 ? 'ew-resize' : 'col-resize'; });
et.addEventListener('auxclick', e => e.preventDefault());
window.addEventListener('mousemove', e => {
  const d = E.tdrag; if (!d) return;
  const W = et.clientWidth, x = e.clientX - et.getBoundingClientRect().left, len = E.view[1] - E.view[0];
  if (!d.moved && Math.abs(x - d.x) < 3) return;
  d.moved = true;
  if (d.pan) { setTrimView(d.v0 - (x - d.x) / W * len, len); return; }      /* Alt / средняя кнопка — прокрутка шкалы */
  if (!d.edge) {                                                              /* перемотка; у края шкала едет следом */
    if (x < 12) setTrimView(E.view[0] - len * 0.015, len); else if (x > W - 12) setTrimView(E.view[0] + len * 0.015, len);
    scrubTo(x); return;
  }
  if (x < 24) setTrimView(E.view[0] - len * 0.02, len); else if (x > W - 24) setTrimView(E.view[0] + len * 0.02, len);   /* край тянется за пределы — шкала едет следом */
  const t = clamp(ex2t(clamp(x, 0, W)), 0, S.cur.duration);
  if (d.edge === 'start') { setTrim(Math.min(t, E.end - 1), E.end, false); ev.currentTime = E.start; }
  else { setTrim(E.start, Math.max(t, E.start + 1), false); ev.currentTime = E.end; }
});
window.addEventListener('mouseup', e => {
  const d = E.tdrag; if (!d) return; E.tdrag = null;
  if (!d.moved && d.edge) ev.currentTime = clamp(ex2t(d.x), 0, S.cur.duration);
  else if (d.moved && !d.edge && !d.pan) ev.currentTime = clamp(ex2t(clamp(e.clientX - et.getBoundingClientRect().left, 0, et.clientWidth)), 0, S.cur.duration);   /* точная позиция после быстрой перемотки */
  else if (d.edge === 'end') ev.currentTime = Math.max(E.start, E.end - 2);
});
et.addEventListener('wheel', e => {
  e.preventDefault(); const len = E.view[1] - E.view[0];
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) setTrimView(E.view[0] + len * 0.15 * Math.sign(e.deltaY || e.deltaX), len);
  else zoomTrim(e.deltaY > 0 ? 1.25 : 0.8, ex2t(e.offsetX));
}, { passive: false });
$('#trimIn').onclick = () => zoomTrim(0.6); $('#trimOut').onclick = () => zoomTrim(1.7);
$('#trimFit').onclick = () => fitTrimView(); $('#trimAll').onclick = () => { E.view = [0, S.cur.duration]; };

/* ---- звуковая дорожка: выделение куска, пик / вырезать звук / громкость, линия громкости ---- */
const ea = $('#edAudio'); let AC = null, acG = null, acB = null;
E.audio = { vol: 1, regions: [] }; E.asel = null; E.arange = null; E.adrag = null; E.playTo = null;
const BAD = /^(?:(?:на|по|ни|до|а|о|от|при|за|вы|не)?ху[йеёяюи]|хул[иь]$|(?:за|на|по|вы|у|до|про|разъ|съ|отъ|объ|недо|пере|при|подъ|долбо|зло|мозго)?[её]б|бля|сук[аиуе]?$|суч[кь]|сучар|(?:на|по|ни)?хер(?:а|у|ня|ни|ов|ово)?$)|пизд|пезд|выбляд|муда[кч]|мудил|мудозв|пид[оа]р|пидр|г[ао]ндон|шлюх|залуп|дроч|говн|жоп|\b(?:fuck|shit|bitch|cunt|asshole)/i;
const isBad = w => BAD.test(w.toLowerCase().replace(/[^a-zа-яё]/g, ''));
const bleeped = w => { const m = (w.s + w.e) / 2; return E.audio.regions.some(r => r.type === 'bleep' && m >= r.s && m <= r.e); };
const A_COLOR = { bleep: '#f87171', mute: '#94a3b8', gain: '#fbbf24' };
const A_NAME = { bleep: 'пик', mute: 'звук вырезан', gain: 'громкость' };
const pct = g => Math.round(g * 100) + '%';
function gainAt(t) {
  let g = E.audio.vol ?? 1, bleep = false;
  for (const r of E.audio.regions) if (t >= r.s && t < r.e) { if (r.type === 'gain') g *= r.gain ?? 1; else { g = 0; bleep = bleep || r.type === 'bleep'; } }
  return { g, bleep };
}
const regionAt = t => { for (let i = E.audio.regions.length - 1; i >= 0; i--) { const r = E.audio.regions[i]; if (t >= r.s && t < r.e) return i; } return -1; };
function markBleeps() { $$('#subEdit input').forEach(el => { const w = E.words.find(w => w.s.toFixed(2) === el.dataset.k); el.classList.toggle('bleep', !!w && bleeped(w)); }); }

/* геометрия дорожки: волна сверху, полоска слов снизу; громкость рисуется на шкале sqrt (100% — посередине) */
const AG = () => { const H = ea.clientHeight, top = 6, bot = H - 22; return { H, top, bot, mid: (top + bot) / 2 }; };
const g2y = g => { const a = AG(); return a.bot - Math.sqrt(clamp(g, 0, 4) / 4) * (a.bot - a.top); };
const y2g = y => { const a = AG(), f = clamp((a.bot - y) / (a.bot - a.top), 0, 1); return f * f * 4; };
const amp = p => clamp((20 * Math.log10(Math.max(p, 1e-5)) + 54) / 54, 0, 1);     /* дБ-шкала: тихий стрим тоже видно */

function selRange() { const r = E.audio.regions[E.asel]; return r ? { s: r.s, e: r.e, r } : E.arange; }
function syncAud() {
  const sel = selRange(), r = sel?.r, bar = $('#audSel');
  bar.classList.toggle('on', !!sel);
  $('#audSelInfo').textContent = sel ? `${r ? A_NAME[r.type] + (r.type === 'gain' ? ' ' + pct(r.gain ?? 1) : '') + ' · ' : 'выделено · '}${fmt(sel.s, true)} – ${fmt(sel.e, true)} (${(sel.e - sel.s).toFixed(2)} с)`
    : 'Ничего не выделено — протяни мышкой по дорожке, чтобы выделить кусок';
  $$('#audSel [data-a]').forEach(b => b.classList.toggle('on', !!r && b.dataset.a === r.type));
  $('#audSel [data-a=del]').hidden = !r;
  const g = r ? (r.type === 'gain' ? r.gain ?? 1 : 0) : 1;
  if (document.activeElement !== $('#audGain')) $('#audGain').value = Math.round(g * 100);
  $('#audGainVal').textContent = pct(g);
  $('#audVol').value = Math.round((E.audio.vol ?? 1) * 100); $('#audVolVal').textContent = pct(E.audio.vol ?? 1);
}
function audChanged() { refreshWords(); markBleeps(); syncAud(); touch(); }

/* применить действие к выделению: к выбранной правке или создать новую */
function audApply(type, gain) {
  let r = E.audio.regions[E.asel];
  if (!r) {
    if (!E.arange) return;
    const { s, e } = E.arange;
    E.audio.regions = E.audio.regions.filter(x => x.e <= s || x.s >= e || (x.s < s || x.e > e));   /* правки целиком внутри выделения заменяются */
    r = { s, e, type }; E.audio.regions.push(r); E.asel = E.audio.regions.length - 1; E.arange = null;
  }
  r.type = type; if (type === 'gain') r.gain = +clamp(gain ?? r.gain ?? 1, 0, 4).toFixed(2); else delete r.gain;
  audChanged();
}
function audRemove() { if (E.asel == null) return; const r = E.audio.regions.splice(E.asel, 1)[0]; E.asel = null; E.arange = r ? { s: r.s, e: r.e } : null; audChanged(); }
$('#audSel').addEventListener('click', e => {
  const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
  const sel = selRange(); if (!sel) return;
  const cur = sel.r?.type === 'gain' ? sel.r.gain ?? 1 : sel.r ? 0 : 1;
  if (a === 'play') { ev.currentTime = Math.max(0, sel.s - 0.3); E.playTo = sel.e + 0.3; initAudio(); ev.play().catch(() => { }); }
  else if (a === 'bleep' || a === 'mute') audApply(a);
  else if (a === 'down') audApply('gain', Math.max(cur || 1, 0.05) * 0.5);
  else if (a === 'up') audApply('gain', Math.max(cur || 1, 0.1) * 1.5);
  else if (a === 'del') audRemove();
});
$('#audGain').oninput = e => audApply('gain', e.target.value / 100);
$('#audVol').oninput = e => { E.audio.vol = e.target.value / 100; syncAud(); touch(); };

/* живое прослушивание: громкость и «пик» накладываются прямо в плеере редактора */
function initAudio() {
  if (AC) { AC.resume(); return; }
  try {
    AC = new AudioContext(); acG = AC.createGain(); AC.createMediaElementSource(ev).connect(acG).connect(AC.destination);
    const o = AC.createOscillator(); o.frequency.value = 1000; acB = AC.createGain(); acB.gain.value = 0; o.connect(acB).connect(AC.destination); o.start();
  } catch { }
}
ev.addEventListener('play', initAudio);
function liveAudio() {
  if (E.playTo != null && (ev.paused || ev.currentTime >= E.playTo)) { if (!ev.paused) ev.pause(); E.playTo = null; }
  if (!acG || !acB) return; const f = gainAt(ev.currentTime); acG.gain.value = f.g; acB.gain.value = f.bleep && !ev.paused ? 0.1 : 0;
}

function needWave() {
  const key = E.view[0].toFixed(2) + '-' + E.view[1].toFixed(2) + '-' + ea.clientWidth + '-' + E.id;
  if (key === E.waveKey) return; E.waveKey = key; clearTimeout(E.waveT);
  E.waveT = setTimeout(async () => {
    try { const w = await api(`/api/projects/${S.pid}/wave?start=${E.view[0].toFixed(2)}&end=${E.view[1].toFixed(2)}&n=${Math.round(ea.clientWidth * Math.min(2, devicePixelRatio || 1))}`); if (E.waveKey === key) E.wave = w; } catch { }
  }, 120);
}
function drawAudio() {
  const [g, W] = prepCanvas(ea), a = AG(), H = a.H, w = E.wave, half = (a.bot - a.top) / 2; needWave();
  const xa = e2x(E.start), xb = e2x(E.end);
  g.fillStyle = 'rgba(34,211,238,.05)'; g.fillRect(xa, 0, xb - xa, a.bot + 2);
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(0, a.mid + .5); g.lineTo(W, a.mid + .5); g.stroke();
  /* правки — цветные блоки под волной */
  E.audio.regions.forEach((r, i) => {
    const x = e2x(r.s), x1 = e2x(r.e); if (x1 < 0 || x > W) return;
    g.fillStyle = A_COLOR[r.type] + (i === E.asel ? '40' : '22'); g.fillRect(x, 0, Math.max(2, x1 - x), a.bot + 2);
  });
  /* волна: бледная — как в исходнике, яркая — как будет в шортсе */
  if (w?.peaks.length) {
    const dt = (w.end - w.start) / w.peaks.length;
    for (let pass = 0; pass < 2; pass++) w.peaks.forEach((p, i) => {
      const t = w.start + i * dt, x = e2x(t), x1 = e2x(t + dt); if (x1 < 0 || x > W) return;
      const inClip = t >= E.start && t < E.end, f = gainAt(t + dt / 2);
      if (pass === 0) { if (f.g >= 0.999 && f.g <= 1.001) return; g.fillStyle = 'rgba(148,163,184,.22)'; const h = amp(p) * half; g.fillRect(x, a.mid - h, Math.max(1, x1 - x), h * 2); return; }
      if (f.g <= 0) { if (f.bleep) { g.fillStyle = 'rgba(248,113,113,.85)'; g.fillRect(x, a.mid - half * .35, Math.max(1, x1 - x), half * .7); } return; }
      const h = amp(Math.min(1, p * f.g)) * half;
      g.fillStyle = !inClip ? '#3a4152' : f.g > 1.001 ? '#fbbf24' : f.g < 0.999 ? '#7c8aa5' : '#5eead4';
      g.fillRect(x, a.mid - h, Math.max(1, x1 - x - .3), h * 2);
    });
  } else { g.fillStyle = '#555'; g.font = '12px Segoe UI'; g.fillText('Загружаю звук…', 10, a.mid); }
  /* выделение */
  const sel = selRange();
  if (sel) {
    const x = e2x(sel.s), x1 = e2x(sel.e);
    g.fillStyle = 'rgba(56,189,248,.16)'; g.fillRect(x, 0, x1 - x, a.bot + 2);
    g.fillStyle = '#38bdf8'; g.fillRect(x - 1, 0, 2, a.bot + 2); g.fillRect(x1 - 1, 0, 2, a.bot + 2);
    g.fillRect(x - 4, a.mid - 10, 4, 20); g.fillRect(x1, a.mid - 10, 4, 20);
  }
  /* подписи правок */
  g.font = '700 11px Segoe UI'; g.textBaseline = 'top';
  E.audio.regions.forEach(r => {
    const x = e2x(r.s), bw = e2x(r.e) - x, label = r.type === 'bleep' ? 'ПИК' : r.type === 'mute' ? 'ВЫРЕЗАН' : pct(r.gain ?? 1);
    if (bw > g.measureText(label).width + 8 && x + bw > 0 && x < W) { g.fillStyle = A_COLOR[r.type]; g.fillText(label, Math.max(x, 0) + 4, a.top + 1); }
  });
  /* линия громкости (огибающая): тянется мышкой */
  g.strokeStyle = '#facc15'; g.lineWidth = 1.5; g.beginPath();
  for (let x = 0; x <= W; x += 1) { const y = g2y(gainAt(ex2t(x)).g); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  if (E.adrag?.mode === 'level' || E.adrag?.mode === 'vol') {
    const gv = E.adrag.mode === 'vol' ? E.audio.vol : E.audio.regions[E.adrag.i]?.gain ?? 0;
    g.fillStyle = '#facc15'; g.font = '700 12px Segoe UI'; g.fillText(pct(gv), clamp(E.adrag.x + 8, 0, W - 50), clamp(g2y(gainAt(ex2t(E.adrag.x)).g) - 18, 0, a.bot - 14));
  }
  /* слова снизу — видно, где какое слово, чтобы точно выделить мат */
  g.fillStyle = '#12141a'; g.fillRect(0, a.bot + 2, W, H - a.bot - 2);
  g.font = '11px Segoe UI'; g.textBaseline = 'middle';
  for (const wd of E.words) {
    const x = e2x(wd.s), x1 = e2x(wd.e); if (x1 < 0 || x > W) continue;
    const bad = bleeped(wd) ? '#f87171' : isBad(wd.w) ? '#fb923c' : null;
    g.fillStyle = bad || 'rgba(255,255,255,.18)'; g.fillRect(x, a.bot + 3, Math.max(1, x1 - x - 1), 2);
    if (x1 - x > 14 || (E.view[1] - E.view[0]) / W < 0.03) { g.save(); g.beginPath(); g.rect(x, a.bot + 4, Math.max(14, x1 - x + 24), H - a.bot - 4); g.clip(); g.fillStyle = bad || 'rgba(255,255,255,.6)'; g.fillText(wd.w, x + 1, (a.bot + H) / 2 + 2); g.restore(); }
  }
  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, xa, H); g.fillRect(xb, 0, W - xb, H);
  g.fillStyle = '#fff'; g.fillRect(e2x(ev.currentTime) - 1, 0, 2, H);
}

/* мышь: края выделения/правки — тянуть, линия громкости — тянуть вверх-вниз, правка — двигать, пусто — выделять */
function audHit(x, y) {
  const t = ex2t(x), T = 6, sel = selRange();
  if (sel) { if (Math.abs(x - e2x(sel.s)) <= T) return { mode: 's' }; if (Math.abs(x - e2x(sel.e)) <= T) return { mode: 'e' }; }
  for (let i = E.audio.regions.length - 1; i >= 0; i--) {
    const r = E.audio.regions[i]; if (i === E.asel) continue;
    if (Math.abs(x - e2x(r.s)) <= T) return { mode: 's', i }; if (Math.abs(x - e2x(r.e)) <= T) return { mode: 'e', i };
  }
  const i = regionAt(t);
  if (Math.abs(y - g2y(gainAt(t).g)) <= 7 && y < AG().bot) return i >= 0 ? { mode: 'level', i } : { mode: 'vol' };
  if (i >= 0) return { mode: 'move', i };
  return { mode: 'new' };
}
const A_CURSOR = { s: 'ew-resize', e: 'ew-resize', level: 'ns-resize', vol: 'ns-resize', move: 'grab', new: 'crosshair' };
ea.addEventListener('mousedown', e => {
  const h = audHit(e.offsetX, e.offsetY), t = ex2t(e.offsetX);
  if (h.i != null && (h.mode === 's' || h.mode === 'e' || h.mode === 'move' || h.mode === 'level')) { E.asel = h.i; E.arange = null; syncAud(); }
  const sel = selRange();
  E.adrag = { ...h, x: e.offsetX, y: e.offsetY, t, orig: sel ? { s: sel.s, e: sel.e } : null, gain0: h.mode === 'vol' ? E.audio.vol : null, moved: false };
  e.preventDefault();
});
ea.addEventListener('mousemove', e => { if (!E.adrag) ea.style.cursor = A_CURSOR[audHit(e.offsetX, e.offsetY).mode]; });
window.addEventListener('mousemove', e => {
  const d = E.adrag; if (!d) return;
  const rc = ea.getBoundingClientRect(), x = clamp(e.clientX - rc.left, 0, ea.clientWidth), y = e.clientY - rc.top, dur = S.cur.duration, t = clamp(ex2t(x), 0, dur), r3 = v => +v.toFixed(3);
  if (!d.moved && Math.abs(x - d.x) + Math.abs(y - d.y) < 3) return;
  d.moved = true; d.x = x;
  const r = E.audio.regions[E.asel], tgt = r || E.arange;
  if (d.mode === 'new') { E.asel = null; E.arange = { s: r3(Math.min(d.t, t)), e: r3(Math.max(d.t, t)) }; }
  else if (d.mode === 'vol') E.audio.vol = +clamp(y2g(y), 0, 2).toFixed(2);
  else if (d.mode === 'level' && r) { const gv = +y2g(y).toFixed(2); if (gv < 0.02) { r.type = 'mute'; delete r.gain; } else { r.type = 'gain'; r.gain = gv; } }
  else if (d.mode === 's' && tgt) tgt.s = r3(clamp(t, 0, d.orig.e - 0.03));
  else if (d.mode === 'e' && tgt) tgt.e = r3(clamp(t, d.orig.s + 0.03, dur));
  else if (d.mode === 'move' && r) { const len = d.orig.e - d.orig.s, s = clamp(d.orig.s + t - d.t, 0, dur - len); r.s = r3(s); r.e = r3(s + len); }
  if (d.mode !== 'new') refreshWords();
  syncAud();
});
window.addEventListener('mouseup', () => {
  const d = E.adrag; if (!d) return; E.adrag = null;
  if (!d.moved) {
    if (d.mode === 'new' || d.mode === 'vol') { E.asel = null; E.arange = null; ev.currentTime = clamp(d.t, 0, S.cur.duration); }
    syncAud(); return;
  }
  if (E.arange && E.arange.e - E.arange.s < 0.03) E.arange = null;
  if (d.mode === 'new') { syncAud(); return; }
  audChanged();
});
ea.addEventListener('dblclick', e => {          /* двойной щелчок — выделить слово под курсором */
  const t = ex2t(e.offsetX), w = E.words.find(w => t >= w.s - 0.05 && t <= w.e + 0.05); if (!w) return;
  E.asel = null; E.arange = { s: +Math.max(0, w.s - 0.04).toFixed(3), e: +(w.e + 0.04).toFixed(3) }; syncAud();
});
document.addEventListener('keydown', e => {
  if (!E.open || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && E.asel != null) { e.preventDefault(); audRemove(); }
  else if (e.key === 'Escape' && (E.asel != null || E.arange)) { E.asel = null; E.arange = null; syncAud(); }
});
$('#audAuto').onclick = () => {
  const bad = E.words.filter(w => w.e > E.start && w.s < E.end && isBad(w.w) && !bleeped(w));
  for (const w of bad) E.audio.regions.push({ s: +Math.max(0, w.s - 0.04).toFixed(3), e: +(w.e + 0.04).toFixed(3), type: 'bleep' });
  if (bad.length) { E.asel = null; E.arange = null; audChanged(); }
  toast(bad.length ? `Запикано слов: ${bad.length} — проверь на дорожке, лишнее убери` : 'Мата в расшифровке не нашлось. Если он есть — выдели кусок на дорожке (двойной щелчок по слову) и нажми «Пик»');
};
$('#subEdit').addEventListener('contextmenu', e => {       /* правый клик по слову — запикать / снять пик */
  const k = e.target.dataset?.k; if (!k) return; e.preventDefault();
  const w = E.words.find(w => w.s.toFixed(2) === k); if (!w) return;
  const m = (w.s + w.e) / 2, i = E.audio.regions.findIndex(r => r.type === 'bleep' && m >= r.s && m <= r.e);
  if (i >= 0) E.audio.regions.splice(i, 1); else E.audio.regions.push({ s: +Math.max(0, w.s - 0.04).toFixed(3), e: +(w.e + 0.04).toFixed(3), type: 'bleep' });
  E.asel = null; E.arange = null; audChanged();
});
const trimWheel = e => {
  e.preventDefault(); const len = E.view[1] - E.view[0];
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) setTrimView(E.view[0] + len * 0.15 * Math.sign(e.deltaY || e.deltaX), len);
  else zoomTrim(e.deltaY > 0 ? 1.25 : 0.8, ex2t(e.offsetX));
};
ea.addEventListener('wheel', trimWheel, { passive: false });

/* ---- превью шортса: окна вебки и игры двигаются, масштабируются за углы и обрезаются за стороны ---- */
function fitPreview() {
  OW = even(clamp(E.L.out_w || 1080, 240, 3840)); OH = even(clamp(E.L.out_h || 1920, 240, 3840)); PW = OW * K; PH = OH * K;
  if (pv.width !== PW || pv.height !== PH) { pv.width = PW; pv.height = PH; }
  const sc = Math.min((innerHeight - 150) / OH, Math.max(260, innerWidth * 0.36) / OW);
  pv.style.width = Math.round(OW * sc) + 'px'; pv.style.height = Math.round(OH * sc) + 'px';
}
window.addEventListener('resize', () => { if (E.open) fitPreview(); });
const pvPos = e => { const rc = pv.getBoundingClientRect(); return [(e.clientX - rc.left) / rc.width * OW, (e.clientY - rc.top) / rc.height * OH]; };
const zoneAt = (x, y) => {      /* выбранный блок хватается первым, даже если поверх лежит другой */
  const T = 16, hit = z => x >= z.x - (z.block ? T : 0) && x <= z.x + z.w + (z.block ? T : 0) && y >= z.y - (z.block ? T : 0) && y <= z.y + z.h + (z.block ? T : 0);
  return (E.sel && E.zones.find(z => z.kind === E.sel && hit(z))) || E.zones.find(hit);
};
function handleAt(z, x, y) {      /* углы — масштаб, стороны — обрезка, середина — перенос */
  if (!z.block) return 'move';
  const T = Math.min(34, z.w / 4, z.h / 4), n = y < z.y + T, s2 = y > z.y + z.h - T, w = x < z.x + T, e = x > z.x + z.w - T;
  return ((n ? 'n' : s2 ? 's' : '') + (w ? 'w' : e ? 'e' : '')) || 'move';
}
const itemKind = it => it.layer ? 'L' + it.layer : it.cam ? 'cam' : it.extra != null ? 'x' + it.extra : 'game';
function blockInfo(kind) {
  const L = effL(), W = ev.videoWidth, H = ev.videoHeight;
  const it = plan(L, W, H).items.find(i => itemKind(i) === kind); if (!it) return null;
  return { D: [...it.dst], S: it.src ? [...it.src] : [0, 0, 1, 1], img: !!it.img, M: kind === 'cam' ? camMask(L, W, H) : kind[0] === 'x' || kind[0] === 'L' ? [0, 0, W, H] : region(L.game || {}, W, H) };
}
function transform(d, dx, dy) {
  let [x, y, w, h] = d.D, [sx, sy, sw, sh] = d.S; const M = d.M, hd = d.handle, MINW = d.img ? 24 : 90, MINH = d.img ? 24 : 70;
  if (d.img && hd.length === 1) {          /* картинка: стороны просто растягивают */
    if (hd === 'e') w = clamp(w + dx, MINW, OW * 1.5); if (hd === 'w') { const nw = clamp(w - dx, MINW, OW * 1.5); x += w - nw; w = nw; }
    if (hd === 's') h = clamp(h + dy, MINH, OH * 1.5); if (hd === 'n') { const nh = clamp(h - dy, MINH, OH * 1.5); y += h - nh; h = nh; }
    return { D: [x, y, w, h], S: d.S };
  }
  if (hd === 'move') { x = clamp(x + dx, 0, OW - w); y = clamp(y + dy, 0, OH - h); }
  else if (hd.length === 2) {             /* угол: размер меняется пропорционально, картинка та же */
    const fw = (w + (hd.includes('e') ? dx : -dx)) / w, fh = (h + (hd.includes('s') ? dy : -dy)) / h;
    const f = clamp(Math.abs(fw - 1) > Math.abs(fh - 1) ? fw : fh, Math.max(MINW / w, MINH / h), Math.min(OW / w, OH / h));
    const nw = w * f, nh = h * f; if (hd.includes('w')) x += w - nw; if (hd.includes('n')) y += h - nh;
    w = nw; h = nh; x = clamp(x, 0, OW - w); y = clamp(y, 0, OH - h);
  } else if (hd === 'e' || hd === 'w') {  /* сторона: обрезка — масштаб картинки не меняется, меняется видимая часть */
    const sc = w / sw; let nw = clamp(w + (hd === 'e' ? dx : -dx), MINW, hd === 'e' ? OW - x : x + w);
    nw = Math.min(nw, (hd === 'e' ? M[0] + M[2] - sx : sx + sw - M[0]) * sc);
    const nsw = nw / sc; if (hd === 'w') { x += w - nw; sx += sw - nsw; } w = nw; sw = nsw;
  } else {
    const sc = h / sh; let nh = clamp(h + (hd === 's' ? dy : -dy), MINH, hd === 's' ? OH - y : y + h);
    nh = Math.min(nh, (hd === 's' ? M[1] + M[3] - sy : sy + sh - M[1]) * sc);
    const nsh = nh / sc; if (hd === 'n') { y += h - nh; sy += sh - nsh; } h = nh; sh = nsh;
  }
  return { D: [x, y, w, h], S: [sx, sy, sw, sh] };
}
function applyBlock(kind, D, S, M) {
  const L = E.L, r = v => +v.toFixed(4);
  if (kind[0] === 'L') {          /* слой: окно на шортсе (+ для куска кадра — какая часть исходника видна) */
    const lay = layerById(kind.slice(1)), W = ev.videoWidth, H = ev.videoHeight; if (!lay) return;
    lay.box = { x: r(D[0] / OW), y: r(D[1] / OH), w: r(D[2] / OW), h: r(D[3] / OH) };
    if (lay.kind === 'crop') lay.src = { x: r(S[0] / W), y: r(S[1] / H), w: r(S[2] / W), h: r(S[3] / H) };
    return;
  }
  if (kind[0] === 'x') {          /* кусок кадра: окно на шортсе + какая часть исходника в нём видна */
    const ex = L.extras[+kind.slice(1)], W = ev.videoWidth, H = ev.videoHeight;
    ex.box = { x: r(D[0] / OW), y: r(D[1] / OH), w: r(D[2] / OW), h: r(D[3] / OH) };
    ex.src = { x: r(S[0] / W), y: r(S[1] / H), w: r(S[2] / W), h: r(S[3] / H) };
    return;
  }
  L[kind + '_box'] ={ x: r(D[0] / OW), y: r(D[1] / OH), w: r(D[2] / OW), h: r(D[3] / OH) };
  L[kind + '_crop'] = { l: r(clamp((S[0] - M[0]) / M[2], 0, .9)), t: r(clamp((S[1] - M[1]) / M[3], 0, .9)), r: r(clamp((M[0] + M[2] - S[0] - S[2]) / M[2], 0, .9)), b: r(clamp((M[1] + M[3] - S[1] - S[3]) / M[3], 0, .9)) };
}
const PV_CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'grab' };
pv.addEventListener('mousemove', e => {
  if (E.pdrag) return;
  const [x, y] = pvPos(e), z = zoneAt(x, y); E.hover = z?.kind || null;
  pv.style.cursor = z ? PV_CURSOR[handleAt(z, x, y)] : 'default';
});
pv.addEventListener('mouseleave', () => { if (!E.pdrag) E.hover = null; });
pv.addEventListener('mousedown', e => {
  const [x, y] = pvPos(e), z = zoneAt(x, y); E.sel = z?.kind || null; if (!z) return;
  const L = E.L, info = z.block ? blockInfo(z.kind) : null;
  E.pdrag = { kind: z.kind, handle: handleAt(z, x, y), x, y, zone: z, sub: L.sub_pos, box0: { x: z.x, y: z.y, w: z.w, h: z.h }, ...(info || {}) };
  const tl = z.kind[0] === 'L' && layerById(z.kind.slice(1)); if (tl?.kind === 'text') E.pdrag.text0 = { pos: { ...(tl.pos || { x: .5, y: .3 }) }, size: tl.size || 80 };
  pv.style.cursor = E.pdrag.handle === 'move' ? 'grabbing' : pv.style.cursor; e.preventDefault();
});
window.addEventListener('mousemove', e => {
  const d = E.pdrag; if (!d) return;
  const [x, y] = pvPos(e), dx = x - d.x, dy = y - d.y, L = E.L;
  if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  d.moved = true;
  if (d.kind === 'sub') L.sub_pos = +clamp(d.sub + dy / OH, 0.03, 0.97).toFixed(4);
  else if (d.kind === 'title') L.title_pos = +clamp((d.zone.y + dy) / OH, 0, 0.95).toFixed(4);
  else if (d.kind === 'chat') {          /* окно чата: перенос и свободный размер за любую сторону */
    let { x, y, w, h } = d.box0, r = x + w, b = y + h; const hd = d.handle, MW = OW * .15, MH = OH * .05;
    if (hd === 'move') { x = clamp(x + dx, 0, OW - w); y = clamp(y + dy, 0, OH - h); r = x + w; b = y + h; }
    else {
      if (hd.includes('w')) x = clamp(x + dx, 0, r - MW); if (hd.includes('e')) r = clamp(r + dx, x + MW, OW);
      if (hd.includes('n')) y = clamp(y + dy, 0, b - MH); if (hd.includes('s')) b = clamp(b + dy, y + MH, OH);
    }
    const q = v => +v.toFixed(4); L.chat_box = { x: q(x / OW), y: q(y / OH), w: q((r - x) / OW), h: q((b - y) / OH) };
  }
  else if (d.text0) {                   /* текстовый слой: середина — перенос, углы и стороны — размер шрифта */
    const lay = layerById(d.kind.slice(1)); if (!lay) return;
    if (d.handle === 'move') lay.pos = { x: +clamp(d.text0.pos.x + dx / OW, 0, 1).toFixed(4), y: +clamp(d.text0.pos.y + dy / OH, 0, 1).toFixed(4) };
    else {
      const hx = d.handle.includes('e') ? 1 : d.handle.includes('w') ? -1 : 0, hy = d.handle.includes('s') ? 1 : d.handle.includes('n') ? -1 : 0;
      const f = 1 + ((hx * dx * 2) / d.zone.w + (hy * dy * 2) / d.zone.h) / ((hx && hy) ? 2 : 1);
      lay.size = Math.round(clamp(d.text0.size * f, 8, 400));
    }
  }
  else if (d.D) { const r = transform(d, dx, dy); applyBlock(d.kind, r.D, r.S, d.M); }
});
window.addEventListener('mouseup', () => { const d = E.pdrag; if (d) { E.pdrag = null; if (d.moved) { touch(); syncEd(); } } });
pv.addEventListener('dblclick', e => {
  const z = zoneAt(...pvPos(e)); if (!z) return;
  if (z.kind === 'chat') return change({ chat_box: { x: .04, y: .56, w: .66, h: .17 } });
  if (z.kind[0] === 'x') { fitExtraBox(E.L.extras[+z.kind.slice(1)]); return change({}); }
  if (z.kind[0] === 'L') { const lay = layerById(z.kind.slice(1)); if (lay?.kind === 'crop') fitExtraBox(lay); else if (lay?.kind === 'image') fitImageBox(lay); return change({}); }
  change(z.kind === 'sub' ? { sub_pos: .75 } : z.kind === 'title' ? { title_pos: null }
    : z.kind === 'cam' ? { cam_box: null, cam_crop: null, cam_dy: 0, pip_x: .5, pip_y: .05 } : { game_box: null, game_crop: null, game_dy: 0, focus_x: .5, focus_y: .5 });
});
pv.addEventListener('wheel', e => {
  const z = zoneAt(...pvPos(e)); if (!z) return; e.preventDefault();
  const L = E.L, up = e.deltaY < 0 ? 1 : -1;
  if (z.kind === 'sub') return change({ sub_size: clamp((L.sub_size || 78) + up * 4, 36, 150) });
  if (z.kind === 'title') return change({ title_size: clamp((L.title_size || 56) + up * 4, 30, 110) });
  if (z.kind === 'chat') return change({ chat_size: clamp((L.chat_size || 34) + up * 2, 16, 90) });
  const tl = z.kind[0] === 'L' && layerById(z.kind.slice(1));
  if (tl?.kind === 'text') { tl.size = clamp((tl.size || 80) + up * 4, 8, 400); E.sel = z.kind; return change({}); }
  const d = blockInfo(z.kind); if (!d) return;       /* окно: масштаб от центра */
  let [x, y, w, h] = d.D; const f = clamp(up > 0 ? 1.06 : 1 / 1.06, Math.max(90 / w, 70 / h), Math.min(OW / w, OH / h));
  const nw = w * f, nh = h * f; x = clamp(x - (nw - w) / 2, 0, OW - nw); y = clamp(y - (nh - h) / 2, 0, OH - nh);
  applyBlock(z.kind, [x, y, nw, nh], d.S, d.M); E.sel = z.kind; touch(); syncEd();
}, { passive: false });
/* ---- чат стрима на шортсе (то же самое считает clipper/render.py) ---- */
const CHAT_COLORS = ['#FF6B6B', '#FFB347', '#FFE066', '#7CFC9A', '#5EEAD4', '#7DD3FC', '#A78BFA', '#F472B6', '#FDA4AF', '#C4F25D'];
const NO_GLYPH = /[\u{10000}-\u{10FFFF}️‍]/gu;
const chatColor = u => CHAT_COLORS[[...u].reduce((n, c, i) => n + c.codePointAt(0) * (i + 1), 0) % CHAT_COLORS.length];
const chatKey = m => `${(+m.t).toFixed(2)}|${m.user || ''}`;
E.chat = []; E.chatHidden = [];
function chatWrap(text, width) {
  const lines = []; let cur = '';
  for (let word of text.split(' ').filter(Boolean)) {
    while (word.length > width) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, width)); word = word.slice(width); }
    if (cur && cur.length + 1 + word.length > width) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word;
  }
  if (cur) lines.push(cur);
  return lines;
}
function chatGeo(L) {
  const k = Math.min(OW, OH) / 1080, b = L.chat_box || {};
  const w = clamp(b.w ?? .66, .15, 1) * OW, h = clamp(b.h ?? .17, .05, 1) * OH;
  const x = clamp((b.x ?? .04) * OW, 0, OW - w), y = clamp((b.y ?? .56) * OH, 0, OH - h);
  const size = Math.max(10, Math.trunc(clamp(L.chat_size ?? 34, 16, 90) * k)), pad = Math.trunc(size * .45);
  return { x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h), size, pad, k,
    chars: Math.max(8, Math.trunc((w - 2 * pad) / (size * .6))), lines: Math.max(1, Math.trunc((h - 2 * pad) / (size * 1.25))) };
}
function chatBlock(m, width) {
  const user = (m.user || '').replace(NO_GLYPH, '').trim() || '?', text = (m.text || '').replace(NO_GLYPH, '').replace(/\s+/g, ' ').trim();
  const all = chatWrap(`${user}: ${text}`, width), lines = all.slice(0, 3);
  if (!lines.length) lines.push(user + ':');
  if (all.length > 3) lines[2] = lines[2].slice(0, Math.max(1, width - 1)) + '…';
  return { user, lines };
}
const visibleChat = () => E.chat.filter(m => !E.chatHidden.includes(m.key) && (m.text || '').trim());
function chatNow(L, geo, t) {          /* что видно в окне чата в момент t (секунды от начала клипа) */
  const shift = +L.chat_shift || 0, seen = visibleChat().filter(m => { const r = m.t - shift - E.start; return r >= -90 && r <= Math.max(0, t) + 1e-6; });
  const show = []; let used = 0;
  for (let i = seen.length - 1; i >= 0; i--) { const b = chatBlock(seen[i], geo.chars); if (used + b.lines.length > geo.lines) break; show.unshift({ m: seen[i], ...b }); used += b.lines.length; }
  return show;
}
function drawChat(g, zones, ts) {
  const L = E.L, geo = chatGeo(L), x = geo.x * K, y = geo.y * K, w = geo.w * K, h = geo.h * K;
  const bg = clamp(L.chat_bg ?? .45, 0, 1);
  if (bg > .01) { g.fillStyle = `rgba(0,0,0,${bg})`; g.fillRect(x, y, w, h); }
  const size = geo.size * K, lh = size * 1.17, show = chatNow(L, geo, ev.currentTime - E.start);
  g.save(); g.font = `700 ${size}px Arial, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
  g.lineWidth = Math.max(1, 2.2 * geo.k) * 2 * K; g.strokeStyle = '#000';
  const rows = []; for (const b of show) b.lines.forEach((ln, i) => rows.push({ ln, name: i === 0 && ln.startsWith(b.user + ':') ? b.user + ':' : '', color: chatColor(b.m.user || '') }));
  let yy = y + h - geo.pad * K - size * .22 - (rows.length - 1) * lh;
  for (const r of rows) {
    let xx = x + geo.pad * K;
    if (r.name) { g.strokeText(r.name, xx, yy); g.fillStyle = r.color; g.fillText(r.name, xx, yy); xx += g.measureText(r.name).width; }
    const rest = r.name ? r.ln.slice(r.name.length) : r.ln;
    g.strokeText(rest, xx, yy); g.fillStyle = '#fff'; g.fillText(rest, xx, yy); yy += lh;
  }
  if (!rows.length) { g.font = `600 ${Math.max(11, 14 * ts / K * K)}px Segoe UI`; g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(E.chat.length ? 'чат: сообщений пока нет' : 'чат (у стрима нет сообщений)', x + 10, y + h / 2); }
  g.restore();
  zones.unshift({ kind: 'chat', block: true, x: geo.x, y: geo.y, w: geo.w, h: geo.h });
}
async function loadChat() {
  const id = E.id;
  try { const c = await api(`/api/projects/${S.pid}/chat?start=${E.start.toFixed(2)}&end=${E.end.toFixed(2)}`); if (E.id === id) { E.chat = c; renderChatList(); } } catch { }
}
function renderChatList() {
  const shift = +E.L.chat_shift || 0, list = E.chat.filter(m => m.t - shift >= E.start - 20 && m.t - shift <= E.end);
  $('#chatInfo').textContent = !E.chat.length ? 'В этом месте стрима чата нет' : `Сообщений рядом с клипом: ${list.length}${E.chatHidden.length ? ` · скрыто: ${E.chatHidden.length}` : ''}`;
  $('#chatList').innerHTML = list.map(m => `<div class="cmsg${E.chatHidden.includes(m.key) ? ' off' : ''}" data-k="${esc(m.key)}" title="Щёлкни — скрыть или вернуть сообщение"><span class="mono">${fmt(Math.max(0, m.t - shift - E.start), true)}</span><b style="color:${chatColor(m.user || '')}">${esc(m.user || '?')}</b> ${esc(m.text || '')}</div>`).join('')
    || '<div class="muted">Нет сообщений в этом отрезке</div>';
}
$('#chatList').addEventListener('click', e => {
  const k = e.target.closest('.cmsg')?.dataset.k; if (!k) return;
  E.chatHidden = E.chatHidden.includes(k) ? E.chatHidden.filter(x => x !== k) : [...E.chatHidden, k];
  renderChatList(); touch();
});
$('#chatFetch').onclick = run(async () => {
  const b = $('#chatFetch'); b.disabled = true; b.textContent = 'Качаю чат…';
  try { const r = await api(`/api/projects/${S.pid}/fetch_chat`, 'POST'); toast(r.count ? `Чат скачан: ${r.count} сообщений` : 'У этого стрима на площадке нет сохранённого чата'); await loadChat(); }
  finally { b.disabled = false; b.textContent = 'Подтянуть чат'; }
});

/* ================================================================ слои: текст, картинки, куски кадра */
const LAY_COLOR = { text: '#60a5fa', image: '#f59e0b', crop: '#e879f9' };
const LAY_ICON = { text: 'T', image: '🖼', crop: '▣' };
const newLayerId = () => Math.random().toString(36).slice(2, 9);
const layerById = id => (E.L?.layers || []).find(l => l.id === id);
const selLayer = () => (E.sel && E.sel[0] === 'L') ? layerById(E.sel.slice(1)) : null;
const cropLayers = () => (E.L?.layers || []).filter(l => l.kind === 'crop' && l.src);
const clipDur = () => E.end - E.start;
const IMG = {};
function getImg(a) { if (!IMG[a]) { IMG[a] = new Image(); IMG[a].src = `/api/assets/${a}`; } return IMG[a]; }
function migrateExtras(L) {          /* старые «куски кадра» → слои */
  L.layers = L.layers || [];
  for (const ex of L.extras || []) L.layers.push({ id: newLayerId(), kind: 'crop', name: 'Кусок кадра', s: 0, e: null, src: ex.src, box: ex.box, opacity: 1, fade: 0 });
  L.extras = [];
}
function layerAlpha(lay, t) {        /* видимость слоя в момент t (секунды от начала клипа), с плавным появлением */
  if (!lay || lay.hidden) return 0;
  const [s0, e0] = layerTime(lay), e = Math.min(clipDur(), e0 ?? 1e9);
  if (t < s0 || t > e) return 0;
  const f = clamp(lay.fade || 0, 0, 5), fd = Math.min(f, Math.max(.05, (e - s0) / 2));
  let a = clamp(lay.opacity ?? 1, 0, 1);
  if (f > .01) a *= Math.min(1, (t - s0) / fd, (e - t) / fd);
  return clamp(a, 0, 1);
}
function fitImageBox(lay) {          /* окно картинки — по её пропорциям */
  const im = getImg(lay.asset), aw = lay.aw || im.naturalWidth || 1, ah = lay.ah || im.naturalHeight || 1, b = lay.box || { x: .6, y: .03, w: .3, h: .1 };
  const h = b.w * OW / (aw / ah) / OH; lay.box = { ...b, h: +Math.min(1, h).toFixed(4) };
}

/* ---- текстовые слои в превью (в рендере это ASS-субтитры с теми же размерами) ---- */
function textMetrics(lay) {
  const k = Math.min(OW, OH) / 1080, size = clamp(lay.size || 80, 8, 400) * k, lines = String(lay.text || '').split('\n');
  const font = `${lay.bold === false ? 400 : 900} ${size}px "${lay.font || E.L.font || 'Arial Black'}", Arial, sans-serif`;
  const g = pv.getContext('2d'); g.save(); g.font = font; const ws = lines.map(l => g.measureText(l).width); g.restore();
  const lh = size * 1.18, pad = lay.style === 'box' ? Math.max(2, size * .28) : (lay.style === 'outline' ? (lay.outline ?? 5) * k : 0);
  const cx = clamp(lay.pos?.x ?? .5, 0, 1) * OW, cy = clamp(lay.pos?.y ?? .3, 0, 1) * OH, tw = Math.max(10, ...ws), th = lines.length * lh;
  return { k, size, lines, ws, font, lh, pad, cx, cy, x: cx - tw / 2 - pad, y: cy - th / 2 - pad, w: tw + pad * 2, h: th + pad * 2 };
}
function drawTextLayers(g, zones, t) {
  for (const lay of E.L.layers || []) {
    if (lay.kind !== 'text' || !String(lay.text || '').trim()) continue;
    const a = layerAlpha(lay, t); if (a <= 0) continue;
    const m = textMetrics(lay), sz = m.size * K;
    g.save(); g.globalAlpha = a; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.font = m.font.replace(`${m.size}px`, `${sz}px`);
    m.lines.forEach((ln, i) => {
      const y = (m.cy - (m.lines.length * m.lh) / 2 + m.lh * (i + .5)) * K, x = m.cx * K;
      if (lay.style === 'box') { g.globalAlpha = a * clamp(lay.bg_op ?? .85, 0, 1); g.fillStyle = lay.bg || '#000'; g.fillRect(x - (m.ws[i] / 2 + m.pad) * K, y - (m.lh / 2 + m.pad * .6) * K, (m.ws[i] + m.pad * 2) * K, (m.lh + m.pad * 1.2) * K); g.globalAlpha = a; }
      if (lay.style === 'outline' && (lay.outline ?? 5) > 0) { g.lineWidth = (lay.outline ?? 5) * m.k * 2 * K; g.strokeStyle = lay.bg || '#000'; g.strokeText(ln, x, y); }
      g.fillStyle = lay.color || '#fff'; g.fillText(ln, x, y);
    });
    g.restore();
    zones.unshift({ kind: 'L' + lay.id, block: true, x: m.x, y: m.y, w: m.w, h: m.h });
  }
}

/* ---- дорожка слоёв под шкалой клипа ---- */
const elay = $('#edLayers'), ROW = 24;
function drawLayersTrack() {
  const lays = E.L.layers || [], wantH = Math.max(34, lays.length * ROW + 8);
  if (Math.abs(elay.clientHeight - wantH) > 1) elay.style.height = wantH + 'px';
  const [g, W, H] = prepCanvas(elay), dur = clipDur();
  g.font = '600 11.5px Segoe UI'; g.textBaseline = 'middle';
  if (!lays.length) { g.fillStyle = '#6b7280'; g.fillText('Слоёв нет — добавь текст, картинку или кусок кадра в панели «Слои» справа', 10, H / 2); }
  lays.forEach((lay, i) => {
    const y = 4 + i * ROW, [s0, e0] = layerTime(lay), e = Math.min(dur, e0 ?? dur), x0 = e2x(E.start + s0), x1 = e2x(E.start + e), sel = E.sel === 'L' + lay.id;
    if (sel) { g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, y - 1, W, ROW - 2); }
    const c = LAY_COLOR[lay.kind] || '#999';
    g.fillStyle = c + (lay.hidden ? '30' : sel ? 'e0' : '90'); g.fillRect(x0, y + 1, Math.max(3, x1 - x0), ROW - 6);
    if (sel) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(x0 + .5, y + 1.5, Math.max(3, x1 - x0) - 1, ROW - 7); }
    g.fillStyle = '#fff'; g.fillRect(x0, y + 1, 3, ROW - 6); g.fillRect(x1 - 3, y + 1, 3, ROW - 6);
    g.save(); g.beginPath(); g.rect(x0 + 5, y, Math.max(0, x1 - x0 - 10), ROW); g.clip();
    g.fillStyle = '#0b0c10'; g.fillText(`${LAY_ICON[lay.kind] || ''} ${lay.name || (lay.kind === 'text' ? lay.text : 'слой')}`, x0 + 7, y + (ROW - 4) / 2);
    g.restore();
  });
  const xa = e2x(E.start), xb = e2x(E.end);
  g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, xa, H); g.fillRect(xb, 0, W - xb, H);
  g.fillStyle = '#fff'; g.fillRect(e2x(ev.currentTime) - 1, 0, 2, H);
}
function layerHit(x, y) {
  const i = Math.floor((y - 4) / ROW), lay = (E.L.layers || [])[i]; if (!lay) return null;
  const [s0, e0] = layerTime(lay), e = Math.min(clipDur(), e0 ?? clipDur()), x0 = e2x(E.start + s0), x1 = e2x(E.start + e);
  if (Math.abs(x - x0) <= 6) return { lay, mode: 's' };
  if (Math.abs(x - x1) <= 6) return { lay, mode: 'e' };
  return { lay, mode: x > x0 && x < x1 ? 'move' : 'pick' };
}
elay.addEventListener('mousedown', e => {
  const h = layerHit(e.offsetX, e.offsetY);
  if (!h || h.mode === 'pick') {          /* мимо полоски — перемотка (тянуть можно) */
    if (!h) E.sel = null; else E.sel = 'L' + h.lay.id;
    E.ldrag = { scrub: true, x: e.offsetX, moved: false }; scrubTo(e.offsetX); e.preventDefault(); return;
  }
  E.sel = 'L' + h.lay.id;
  const [s0, e0] = layerTime(h.lay);
  E.ldrag = { lay: h.lay, mode: h.mode, t0: ex2t(e.offsetX), s0, e0: Math.min(clipDur(), e0 ?? clipDur()), toEnd: e0 == null, moved: false, x: e.offsetX };
  e.preventDefault();
});
elay.addEventListener('mousemove', e => { if (!E.ldrag) { const h = layerHit(e.offsetX, e.offsetY); elay.style.cursor = !h ? 'default' : h.mode === 's' || h.mode === 'e' ? 'ew-resize' : h.mode === 'move' ? 'grab' : 'pointer'; } });
window.addEventListener('mousemove', e => {
  const d = E.ldrag; if (!d) return;
  const x = e.clientX - elay.getBoundingClientRect().left; if (!d.moved && Math.abs(x - d.x) < 3) return; d.moved = true;
  if (d.scrub) return scrubTo(x);
  const dur = clipDur(), dt = ex2t(x) - d.t0, r2 = v => +v.toFixed(2), lay = d.lay;
  if (d.mode === 's') lay.s = r2(clamp(d.s0 + dt, 0, d.e0 - .1));
  else if (d.mode === 'e') { const ne = clamp(d.e0 + dt, d.s0 + .1, dur); lay.e = ne >= dur - .03 ? null : r2(ne); }
  else if (d.mode === 'move') { const len = d.e0 - d.s0, ns = clamp(d.s0 + dt, 0, dur - len); lay.s = r2(ns); lay.e = d.toEnd && ns + len >= dur - .03 ? null : r2(ns + len); }
  syncLayerProps();
});
window.addEventListener('mouseup', () => {
  const d = E.ldrag; if (!d) return; E.ldrag = null;
  if (d.scrub) return;
  if (d.moved) { touch(); renderLayers(); return; }
  const t = E.start + layerTime(d.lay)[0]; if (layerAlpha({ ...d.lay, hidden: false }, ev.currentTime - E.start) <= 0) ev.currentTime = t + .05;
});
elay.addEventListener('wheel', trimWheel, { passive: false });

/* ---- список слоёв и свойства выбранного ---- */
function layerTimeText(lay) { const [s0, e0] = layerTime(lay); return s0 < .01 && e0 == null ? 'весь клип' : `${s0.toFixed(1)}–${e0 == null ? 'конец' : e0.toFixed(1)} с`; }
function renderLayers() {
  if (!E.open) return;
  const lays = E.L.layers || [];
  $('#layerList').innerHTML = [...lays].reverse().map(l => `<div class="lyr${E.sel === 'L' + l.id ? ' on' : ''}${l.hidden ? ' off' : ''}" data-id="${l.id}"><b style="color:${LAY_COLOR[l.kind]}">${LAY_ICON[l.kind]}</b><span class="nm">${esc(l.name || l.text || 'слой')}</span><span class="tm">${layerTimeText(l)}</span><button class="eye" data-eye="${l.id}" title="Скрыть / показать">${l.hidden ? '◌' : '👁'}</button></div>`).join('')
    || '<div class="muted small">Добавь текст, логотип или кусок кадра — у каждого слоя своё время показа на дорожке «Слои».</div>';
  syncLayerProps();
}
function syncLayerProps() {
  const lay = selLayer(), box = $('#layerProps'); box.hidden = !lay; if (!lay) return;
  if ($('#layerFont').options.length !== $('#fontSel').options.length) $('#layerFont').innerHTML = $('#fontSel').innerHTML;
  $$('#layerProps [data-kind]').forEach(el => el.hidden = el.dataset.kind !== lay.kind);
  $$('#layerProps [data-style]').forEach(el => el.hidden = el.dataset.style !== (lay.style || 'box'));
  const def = { size: 80, style: 'box', color: '#ffffff', bg: '#000000', outline: 5, bg_op: .85, opacity: 1, fade: 0, bold: true, font: E.L.font || 'Arial Black' };
  $$('#layerProps [data-y]').forEach(el => {
    if (document.activeElement === el) return;
    const k = el.dataset.y, v = lay[k] ?? def[k];
    if (el.type === 'checkbox') el.checked = v !== false; else el.value = k === 'e' ? (lay.e == null ? '' : (+lay.e).toFixed(1)) : k === 's' ? (+lay.s || 0).toFixed(1) : (v ?? '');
  });
  if (lay.kind === 'image') $('#layerImgInfo').textContent = lay.aw ? `${lay.aw}×${lay.ah} px` : '';
}
$$('#layerProps [data-y]').forEach(el => {
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    const lay = selLayer(); if (!lay) return; const k = el.dataset.y;
    let v = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number') ? parseFloat(el.value) : el.value;
    if (k === 'e') v = el.value === '' ? null : Math.max(+lay.s || 0, parseFloat(el.value) || 0) + 0;
    if (k === 's') v = clamp(v || 0, 0, clipDur() - .1);
    lay[k] = v; touch();
    if (k === 'name' || k === 'text' || k === 's' || k === 'e') { const keep = document.activeElement; renderLayers(); keep?.focus?.(); }
    if (k === 'style') syncLayerProps();
  });
});
$('#layerList').addEventListener('click', e => {
  const eye = e.target.dataset.eye; if (eye) { const l = layerById(eye); l.hidden = !l.hidden; touch(); return renderLayers(); }
  const id = e.target.closest('.lyr')?.dataset.id; if (!id) return;
  E.sel = 'L' + id; const lay = layerById(id);
  if (layerAlpha({ ...lay, hidden: false }, ev.currentTime - E.start) <= 0) ev.currentTime = E.start + layerTime(lay)[0] + .05;
  renderLayers();
});
function addLayer(lay) { E.L.layers = [...(E.L.layers || []), lay]; E.sel = 'L' + lay.id; touch(); syncEd(); }
$('#addText').onclick = () => {
  const t = clamp(ev.currentTime - E.start, 0, Math.max(0, clipDur() - 1));
  addLayer({ id: newLayerId(), kind: 'text', name: 'Текст', text: 'ТЕКСТ', s: +t.toFixed(2), e: +Math.min(clipDur(), t + 3).toFixed(2), pos: { x: .5, y: .3 }, size: 80, style: 'box', color: '#ffffff', bg: '#000000', bg_op: .8, outline: 5, bold: true, font: E.L.font || 'Arial Black', opacity: 1, fade: .2 });
  setTimeout(() => { const ta = $('#layerProps textarea'); ta.focus(); ta.select(); }, 50);
};
$('#addCrop').onclick = () => {
  const lay = { id: newLayerId(), kind: 'crop', name: 'Кусок кадра', s: 0, e: null, src: { x: .3, y: .72, w: .4, h: .26 }, box: { x: .1, y: .06, w: .8, h: .2 }, opacity: 1, fade: 0 };
  fitExtraBox(lay); addLayer(lay); toast('Розовая рамка на исходном кадре — что вырезать, окно на шортсе — куда поставить');
};
let assetMode = 'add';
$('#addImage').onclick = () => { assetMode = 'add'; $('#assetFile').value = ''; $('#assetFile').click(); };
$('#replaceImg').onclick = () => { assetMode = 'replace'; $('#assetFile').value = ''; $('#assetFile').click(); };
$('#assetFile').onchange = run(async e => {
  const file = e.target.files[0]; if (!file) return;
  const r = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Не удалось загрузить картинку');
  const im = getImg(j.asset); await (im.decode ? im.decode().catch(() => { }) : sleep(300));
  const aw = im.naturalWidth || 1, ah = im.naturalHeight || 1, name = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
  if (assetMode === 'replace' && selLayer()?.kind === 'image') { const l = selLayer(); Object.assign(l, { asset: j.asset, aw, ah, name }); fitImageBox(l); touch(); return syncEd(); }
  const w = .3, lay = { id: newLayerId(), kind: 'image', name, asset: j.asset, aw, ah, s: 0, e: null, box: { x: .66, y: .03, w, h: +Math.min(1, w * OW / (aw / ah) / OH).toFixed(4) }, opacity: 1, fade: 0 };
  addLayer(lay); toast('Картинка добавлена: тяни её в превью, углы — размер');
});
const layerAct = fn => () => { const lay = selLayer(); if (!lay) return; fn(lay, E.L.layers.indexOf(lay)); touch(); syncEd(); };
$('#layerHere').onclick = layerAct(l => { const t = clamp(ev.currentTime - E.start, 0, clipDur() - .1), e0 = layerTime(l)[1]; l.s = +t.toFixed(2); if (e0 != null && e0 <= t) l.e = +Math.min(clipDur(), t + 3).toFixed(2); });
$('#layerToEnd').onclick = layerAct(l => { l.e = null; });
$('#layerAll').onclick = layerAct(l => { l.s = 0; l.e = null; });
$('#layerUp').onclick = layerAct((l, i) => { const a = E.L.layers; if (i < a.length - 1) [a[i], a[i + 1]] = [a[i + 1], a[i]]; });
$('#layerDown').onclick = layerAct((l, i) => { const a = E.L.layers; if (i > 0) [a[i], a[i - 1]] = [a[i - 1], a[i]]; });
$('#layerDup').onclick = layerAct((l, i) => { const c = JSON.parse(JSON.stringify(l)); c.id = newLayerId(); c.name = (l.name || 'слой') + ' копия'; if (c.pos) c.pos = { x: Math.min(1, c.pos.x + .03), y: Math.min(1, c.pos.y + .03) }; if (c.box) c.box = { ...c.box, x: c.box.x + .03, y: c.box.y + .03 }; E.L.layers.splice(i + 1, 0, c); E.sel = 'L' + c.id; });
$('#layerDel').onclick = layerAct((l, i) => { E.L.layers.splice(i, 1); E.sel = null; });
document.addEventListener('keydown', e => {
  if (!E.open || !selLayer() || E.asel != null || E.arange || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'Delete') { e.preventDefault(); $('#layerDel').click(); }
});

/* ================================================================ пресеты */
const presetOf = L => { const p = JSON.parse(JSON.stringify(L)); if (p.cam_source !== 'manual') delete p.cam; return p; };
async function loadPresets(selectName) {
  try { S.cfg = await api('/api/config'); } catch { return; }
  const ps = S.cfg.presets || [], sel = $('#presetSel'), keep = selectName ?? sel.selectedOptions[0]?.textContent;
  sel.innerHTML = ps.length ? ps.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('') : '<option value="">— пресетов пока нет —</option>';
  const i = ps.findIndex(p => p.name === keep); if (i >= 0) sel.value = String(i);
  $('#presetApply').disabled = $('#presetAll').disabled = $('#presetDel').disabled = !ps.length;
}
const curPreset = () => (S.cfg?.presets || [])[+$('#presetSel').value];
$('#presetSave').onclick = run(async () => {
  const name = prompt('Название пресета (тот же — перезапишет):', curPreset()?.name || 'Мой пресет'); if (!name?.trim()) return;
  const p = presetOf(E.L), cfg = await api('/api/config'), ps = cfg.presets || [], i = ps.findIndex(x => x.name === name.trim());
  if (i >= 0) ps[i] = { name: name.trim(), layout: p }; else ps.push({ name: name.trim(), layout: p });
  cfg.presets = ps; await api('/api/config', 'PUT', cfg);
  await api(`/api/projects/${S.pid}/apply_layout`, 'POST', { layout: p });        /* основной для новых клипов */
  S.cur.layout = JSON.parse(JSON.stringify(p)); await loadPresets(name.trim());
  toast(`Пресет «${name.trim()}» сохранён — новые клипы будут с ним. Чтобы применить к уже найденным — «На все клипы»`);
});
function applyPresetHere(p) {
  const det = E.det; E.L = { ...JSON.parse(JSON.stringify(p.layout)) }; migrateExtras(E.L);
  if (E.L.cam_source === 'auto') E.L.cam = det || null;
  E.sel = null; refreshWords(); touch(); syncEd(); if (usesCam() && E.L.cam_source === 'auto' && det === undefined) detect();
}
$('#presetApply').onclick = () => { const p = curPreset(); if (!p) return; applyPresetHere(p); toast(`Пресет «${p.name}» применён к этому клипу`); };
$('#presetAll').onclick = run(async () => {
  const p = curPreset(); if (!p) return;
  if (!confirm(`Применить пресет «${p.name}» ко всем ${S.cur.clips.length} клипам стрима?\nИх собственные настройки (окна, слои, экспорт) заменятся. Текст субтитров, звук и длина клипов останутся.`)) return;
  await save(); await api(`/api/projects/${S.pid}/apply_layout`, 'POST', { layout: p.layout, all: true });
  applyPresetHere(p); await save(); await pollProject(); toast('Пресет применён ко всем клипам');
});
$('#presetDel').onclick = run(async () => {
  const p = curPreset(); if (!p || !confirm(`Удалить пресет «${p.name}»?`)) return;
  const cfg = await api('/api/config'); cfg.presets = (cfg.presets || []).filter(x => x.name !== p.name); await api('/api/config', 'PUT', cfg); await loadPresets('');
});

function drawPreview() {
  const g = pv.getContext('2d');
  g.filter = 'none'; g.fillStyle = '#000'; g.fillRect(0, 0, PW, PH);
  if (ev.readyState < 2) { g.fillStyle = '#555'; g.font = '22px Segoe UI'; g.textAlign = 'center'; g.fillText('Загрузка видео…', PW / 2, PH / 2); return; }
  const L = effL(), pl = E.plan = plan(L, ev.videoWidth, ev.videoHeight), zones = [], ts = Math.min(OW, OH) / 1080 * K;   /* ts — масштаб текста */
  if (pl.bg) { g.filter = `blur(16px) brightness(${(1 - pl.bg_dim * 1.8).toFixed(2)}) saturate(1.15)`; g.drawImage(ev, ...pl.bg, -20, -20, PW + 40, PH + 40); g.filter = 'none'; }
  const tc = ev.currentTime - E.start;
  for (const it of pl.items) {
    const a = it.layer ? layerAlpha(layerById(it.layer), tc) : 1; if (a <= 0) continue;
    const [x, y, w, h] = it.dst.map(v => v * K), b = (it.border || 0) * K;
    if (b) { g.fillStyle = '#fff'; g.fillRect(x - b, y - b, w + 2 * b, h + 2 * b); }
    g.globalAlpha = a;
    if (it.img) { const im = getImg(it.img); if (im.complete && im.naturalWidth) g.drawImage(im, x, y, w, h); else { g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(x, y, w, h); } }
    else g.drawImage(ev, ...it.src, x, y, w, h);
    g.globalAlpha = 1;
    zones.unshift({ kind: itemKind(it), block: true, x: it.dst[0], y: it.dst[1], w: it.dst[2], h: it.dst[3] });
  }
  if (L.chat) drawChat(g, zones, ts);
  const font = `"${L.font || 'Arial Black'}", "Arial Black", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (L.title_overlay && E.title.trim()) {
    const fs = (L.title_size || 56) * ts; g.font = `900 ${fs}px ${font}`;
    const lines = wrapText(g, E.title.trim(), PW - 140 * ts), lh = fs * 1.5; let y = pl.title_y * K + lh / 2, mw = 0;
    for (const ln of lines) { const w = g.measureText(ln).width + 28 * ts; mw = Math.max(mw, w); g.fillStyle = L.title_bg || '#fff'; g.fillRect(PW / 2 - w / 2, y - lh / 2, w, lh + 1); g.fillStyle = L.title_fg || '#101010'; g.fillText(ln, PW / 2, y); y += lh; }
    zones.unshift({ kind: 'title', x: (PW / 2 - mw / 2) / K, y: pl.title_y, w: mw / K, h: lines.length * lh / K });
  }
  if (L.subtitles) {
    const size = (L.sub_size || 78) * ts, t = ev.currentTime, groups = E.groups, y = PH * L.sub_pos;
    const gi = groups.findIndex((gr, i) => t >= gr[0].s && t < Math.min(gr[gr.length - 1].e + .25, groups[i + 1]?.[0].s ?? 1e9));
    zones.unshift({ kind: 'sub', x: OW * .04, y: L.sub_pos * OH - size / K * .75, w: OW * .92, h: size / K * 1.5 });
    if (gi >= 0) {
      const gr = groups[gi], up = L.uppercase !== false, nch = gr.reduce((n, w) => n + w.w.length, 0) + gr.length - 1;
      g.font = `900 ${size * Math.min(1, 0.9 * PW / (Math.max(1, nch) * size))}px ${font}`;
      const texts = gr.map(w => up ? w.w.toUpperCase() : w.w), sp = g.measureText(' ').width, widths = texts.map(x => g.measureText(x).width);
      let x = PW / 2 - (widths.reduce((a, b) => a + b, 0) + sp * (texts.length - 1)) / 2;
      let act = 0; gr.forEach((w, i) => { if (t >= w.s) act = i; });
      g.textAlign = 'left'; g.lineJoin = 'round'; g.lineWidth = (L.sub_outline ?? 7) * 2 * ts; g.strokeStyle = '#000';
      texts.forEach((tx, i) => { if (g.lineWidth > 0) g.strokeText(tx, x, y); g.fillStyle = i === act ? (L.sub_hi || '#FFE500') : (L.sub_color || '#fff'); g.fillText(tx, x, y); x += widths[i] + sp; });
    } else if (E.hover === 'sub' || E.pdrag?.kind === 'sub') { g.font = '600 15px Segoe UI'; g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText('здесь будут субтитры', PW / 2, y); }
  }
  drawTextLayers(g, zones, tc);
  E.zones = zones;
  const hz = zones.find(z => z.kind === (E.pdrag?.kind || E.hover || E.sel));      /* рамка и ручки блока под курсором или выбранного */
  if (hz) {
    const x = hz.x * K, y = hz.y * K, w = hz.w * K, h = hz.h * K;
    g.lineWidth = 2; g.strokeStyle = '#22d3ee'; g.setLineDash(hz.block ? [] : [6, 4]); g.strokeRect(x + 1, y + 1, w - 2, h - 2); g.setLineDash([]);
    if (hz.block) {
      g.fillStyle = '#22d3ee';
      for (const [hx, hy, corner] of [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1], [.5, 0, 0], [.5, 1, 0], [0, .5, 0], [1, .5, 0]]) {
        const cx = clamp(x + w * hx, 6, PW - 6), cy = clamp(y + h * hy, 6, PH - 6);
        if (corner) g.fillRect(cx - 6, cy - 6, 12, 12); else if (hx === .5) g.fillRect(cx - 14, cy - 3, 28, 6); else g.fillRect(cx - 3, cy - 14, 6, 28);
      }
    }
  }
  const cur = $('#subEdit input.now'), nowK = E.eff.find(w => ev.currentTime >= w.s && ev.currentTime < w.e)?.s.toFixed(2);
  if (cur?.dataset.k !== nowK) { cur?.classList.remove('now'); if (nowK) $(`#subEdit input[data-k="${nowK}"]`)?.classList.add('now'); }
}
function edStatus() {
  const c = clip(E.id); if (!c) return;
  const jobs = (S.cur.jobs || []).filter(j => j.kind === 'render' && j.cid === E.id), j = jobs.find(j => !j.plain), jp = jobs.find(j => j.plain);
  const busy = j || c.status === 'queued' || c.status === 'rendering';
  $('#edStatus').textContent = busy ? `Рендер… ${((j?.progress || 0) * 100).toFixed(0)}%` : jp ? `Вырезаю без оформления… ${(jp.progress * 100).toFixed(0)}%`
    : E.dirty || E.saving ? 'Сохраняю…' : c.status === 'error' ? 'Ошибка рендера: ' + (c.error || '').slice(0, 60) : c.status === 'rendered' ? (c.stale ? 'Изменён после рендера' : 'Шортс готов' + (c.encoded ? ' · ' + c.encoded : '')) : 'Сохранено';
  $('#edRender').disabled = !!busy; $('#edRender').textContent = c.status === 'rendered' ? 'Отрендерить заново' : 'Сделать шортс';
  $('#edView').hidden = c.status !== 'rendered' || !!busy;
  $('#edPlain').disabled = !!jp;
  const dl = $('#edPlainDl'); dl.hidden = !c.file_plain || !!jp; if (c.file_plain) dl.href = `/api/projects/${S.pid}/clips/${E.id}/file?plain=1&download=1`;
}
$('#edPlain').onclick = run(async () => { await save(); await api(`/api/projects/${S.pid}/clips/${E.id}/render?plain=1`, 'POST'); await pollProject(); toast('Вырезаю отрезок как есть — файл появится в папке с клипами'); });
/* ---- экспорт: совместимость контейнера и кодека, примерный размер файла ---- */
const CODECS = { mp4: ['h264', 'hevc', 'av1'], mov: ['h264', 'hevc', 'prores'], mkv: ['h264', 'hevc', 'av1', 'vp9'], webm: ['vp9', 'av1'] };
function syncExport() {
  const L = E.L, cont = CODECS[L.container] ? L.container : 'mp4', ok = CODECS[cont];
  if (!ok.includes(L.vcodec)) { L.vcodec = ok[0]; touch(); }
  $$('#vcodecSel option').forEach(o => o.disabled = !ok.includes(o.value)); $('#vcodecSel').value = L.vcodec;
  const pr = L.vcodec === 'prores', byRate = L.rate === 'bitrate';
  $$('#editor [data-rate]').forEach(el => el.hidden = pr || el.dataset.rate !== (byRate ? 'bitrate' : 'quality'));
  $('#editor [data-seg=rate]').hidden = pr;
  const dur = E.end - E.start, ab = +L.abitrate || 192, notes = [];
  if (pr) notes.push(`ProRes HQ — для монтажа, файл огромный (≈${Math.round(dur * 220 * (OW * OH) / (1920 * 1080) / 8)} МБ на этот клип)`);
  else if (byRate) { const mb = ((+L.bitrate || 12) * 1000 + ab) * dur / 8 / 1000; notes.push(`Файл ≈ ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ. Для шортсов обычно хватает 8–16 Мбит/с в 1080p, 30–45 в 4K`); }
  if (+L.fps > (S.cur.fps || 30) + 1) notes.push(`Стрим скачан в ${Math.round(S.cur.fps || 30)} fps — ${L.fps} fps даст только повтор кадров. Для настоящих 60 fps перекачай стрим (⬇ Качество видео), если у него есть 60`);
  if (L.vcodec === 'vp9') notes.push('VP9 кодируется только процессором — медленнее');
  if (L.vcodec === 'av1') notes.push('AV1 на видеокарте — только RTX 40/50, иначе процессор (медленно)');
  if (L.vcodec === 'hevc') notes.push('H.265 не везде играет в браузере, но YouTube и TikTok его принимают');
  if (cont === 'mkv' || cont === 'mov') notes.push('В окне просмотра может не проиграться — открой файл из папки');
  $('#exportInfo').textContent = notes.join(' · ');
}
$('#fmtSel').onchange = e => { if (e.target.value !== 'custom') { const [w, h] = e.target.value.split('x').map(Number); change({ out_w: w, out_h: h }); } };

function frame() {
  if (S.cur && E.open) {
    if (!ev.paused && (ev.currentTime >= E.end || ev.currentTime < E.start - 0.3)) ev.currentTime = E.start;
    $('#edTime').textContent = fmt(Math.max(0, ev.currentTime - E.start), true) + ' / ' + fmt(E.end - E.start, true);
    $('#edPlay').textContent = ev.paused ? '▶' : '❚❚';
    if (E.sel !== E.lastSel) { E.lastSel = E.sel; renderLayers(); }
    drawMasks(); drawTrim(); drawLayersTrack(); drawAudio(); liveAudio(); drawPreview(); edStatus();
  } else if (S.cur) {
    if (S.loop && S.a != null && S.b != null && !video.paused && (video.currentTime >= S.b || video.currentTime < S.a - 0.3)) video.currentTime = S.a;
    $('#curTime').textContent = fmt(video.currentTime, true) + ' / ' + fmt(S.cur.duration || 0);
    $('#playBtn').textContent = video.paused ? '▶' : '❚❚';
    drawTimeline();
  }
  requestAnimationFrame(frame);
}

/* ================================================================ шапка и настройки */
$('#addForm').onsubmit = run(async e => {
  e.preventDefault();
  const source = $('#source').value.trim(); if (!source) return;
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Проверяю…';
  try { const p = await api('/api/projects', 'POST', { source, auto_render: $('#autoRender').checked }); $('#source').value = ''; await openProject(p.id); }
  finally { btn.disabled = false; btn.textContent = 'Нарезать'; }
});
$('#renderAllBtn').onclick = run(async () => {
  const stale = S.cur.clips.some(c => c.status === 'rendered' && c.stale);
  const force = stale && confirm('Часть готовых шортсов изменена после рендера. Перерендерить и их тоже?');
  const r = await api(`/api/projects/${S.pid}/render_all`, 'POST', { force }); toast(r.queued ? `В очереди на рендер: ${r.queued}` : 'Все клипы уже отрендерены'); pollProject();
});
$('#reanalyzeBtn').onclick = run(async () => { if (!confirm('Найти моменты заново? Неотрендеренные авто-клипы будут заменены, ручные и готовые останутся.')) return; await api(`/api/projects/${S.pid}/reanalyze`, 'POST'); pollProject(); });
$('#openBtn').onclick = run(() => api(`/api/projects/${S.pid}/open`, 'POST'));
$('#deleteBtn').onclick = run(async () => {
  if (!confirm(`Удалить «${S.cur.title}» вместе со скачанным видео и всеми клипами?`)) return;
  await api('/api/projects/' + S.pid, 'DELETE'); S.pid = null; S.cur = null; $('#work').hidden = true; $('#empty').hidden = false; refreshList();
});

const getK = (o, k) => k.split('.').reduce((a, p) => a?.[p], o);
const setK = (o, k, v) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((a, p) => a[p] ??= {}, o)[last] = v; };
const readForm = () => { const cfg = JSON.parse(JSON.stringify(S.cfg)); $$('#settings [data-k]').forEach(el => setK(cfg, el.dataset.k, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim())); return cfg; };
$('#settingsBtn').onclick = run(async () => {
  S.cfg = await api('/api/config'); $('#llmResult').textContent = '';
  $$('#settings [data-k]').forEach(el => { const v = getK(S.cfg, el.dataset.k); el.type === 'checkbox' ? el.checked = !!v : el.value = v ?? ''; });
  $('#settings').showModal();
});
$('#settingsCancel').onclick = () => $('#settings').close();
$('#settingsSave').onclick = run(async () => { S.cfg = await api('/api/config', 'PUT', readForm()); $('#settings').close(); toast('Настройки сохранены'); });
$('#llmTest').onclick = run(async () => {
  $('#llmResult').textContent = 'Проверяю…';
  const r = await api('/api/llm/test', 'POST', readForm().llm);
  $('#llmResult').textContent = r.ok ? `✓ ${r.model}` : '✗ ' + r.error;
});

/* ---- качество скачивания и перекачка ---- */
function setQSel(sel, dl) { const v = `${dl?.max_height ?? 1080}/${dl?.fps ?? 60}`; if (![...sel.options].some(o => o.value === v)) sel.add(new Option(`${+dl.max_height ? dl.max_height + 'p' : 'лучшее'} ${dl.fps}fps`, v)); sel.value = v; }
$('#dlQ').onchange = run(async e => {
  const [h, f] = e.target.value.split('/').map(Number), cfg = await api('/api/config');
  cfg.download = { ...cfg.download, max_height: h, fps: f }; S.cfg = await api('/api/config', 'PUT', cfg);
  toast(`Новые стримы будут качаться в ${h ? h + 'p' : 'лучшем качестве'}, ${f} fps`);
});
$('#redlBtn').onclick = () => {
  const p = S.cur; setQSel($('#redlQ'), S.cfg?.download); $('#redlCodec').value = S.cfg?.download?.codec || 'auto';
  $('#redlNow').textContent = `Сейчас: ${p.width}×${p.height}, ${Math.round(p.fps || 30)} fps.`; $('#redlDlg').showModal();
};
$('#redlCancel').onclick = () => $('#redlDlg').close();
$('#redlGo').onclick = run(async () => {
  const [h, f] = $('#redlQ').value.split('/').map(Number);
  video.pause(); video.removeAttribute('src'); video.load(); ev.pause(); ev.removeAttribute('src'); ev.load();     /* отпускаем файл, чтобы его можно было заменить */
  await api(`/api/projects/${S.pid}/redownload`, 'POST', { max_height: h, fps: f, codec: $('#redlCodec').value });
  $('#redlDlg').close(); S.redl = true; if (E.open) await closeEditor(); await pollProject();
});

(async () => {
  try { S.cfg = await api('/api/config'); } catch { }
  setQSel($('#dlQ'), S.cfg?.download);
  try { $('#fontSel').innerHTML = (await api('/api/fonts')).map(f => `<option>${esc(f)}</option>`).join(''); } catch { }
  await refreshList().catch(e => toast(e.message));
  setInterval(() => { refreshList().catch(() => { }); pollProject().catch(() => { }); }, 1500);
  requestAnimationFrame(frame);
})();

/* ---- язык интерфейса ---- */
$('#langBtn').textContent = (window.LANG || 'ru').toUpperCase();
$('#langBtn').title = window.LANG === 'en' ? 'Переключить на русский' : 'Switch to English';
$('#langBtn').onclick = () => setLang(window.LANG === 'en' ? 'ru' : 'en');
$('#langSel').value = window.LANG || 'ru';
$('#langSel').onchange = e => setLang(e.target.value);
