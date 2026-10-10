'use strict';

/* =========================================================
   Mode vidéo : écran partagé façon TikTok
   - Moitié haute : la flash card (toucher = retourner, glisser ↑ = suivante, ↓ = précédente)
   - Moitié basse : une vidéo en boucle, sans le son, au choix (settings.videoSource) :
       'anim'    : petit jeu de course dessiné par l'appli (hors connexion, sans fichier)
       'file'    : vidéo choisie sur l'appareil (stockée localement, jamais envoyée ni publiée)
       'youtube' : lien YouTube, via le lecteur intégré officiel (nécessite internet)
   Chargé avant app.js : les fonctions d'app.js ne sont appelées qu'à l'exécution.
   ========================================================= */
const splitState = { timer: null, runner: null, url: null, cleanup: [] };

function teardownSplit() {
  clearTimeout(splitState.timer);
  stopVideo();
  document.body.classList.remove('split-mode');
}
function stopVideo() {
  splitState.runner?.stop();
  splitState.runner = null;
  if (splitState.url) URL.revokeObjectURL(splitState.url);
  splitState.url = null;
  splitState.cleanup.forEach(fn => fn());
  splitState.cleanup = [];
}

function buildSplitLayout() {
  document.body.classList.add('split-mode');
  app.innerHTML = `<div class="split">
    <section class="split-card" id="split-card"></section>
    <section class="split-video" id="split-video" aria-hidden="true"></section>
  </div>`;
  const root = $('.split');

  // Gestes tactiles sur tout l'écran (carte et vidéo)
  let x0 = null, y0 = 0, scroll0 = 0, body = null;
  root.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    body = $('#split-body'); scroll0 = body?.scrollTop ?? 0;
  }, { passive: true });
  root.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (body?.isConnected && Math.abs(body.scrollTop - scroll0) > 2) return; // lecture d'une longue définition
    const s = state.session;
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.3) { s.swipeAt = Date.now(); move(dy < 0 ? 1 : -1); }
    else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { s.swipeAt = Date.now(); move(dx < 0 ? 1 : -1); }
  });
  // Toucher / clic n'importe où = retourner la carte
  root.addEventListener('click', e => {
    const s = state.session;
    if (!s || s.finished || e.target.closest('button, a, input')) return;
    if (Date.now() - (s.swipeAt || 0) < 450) return;
    flip();
  });
  // Molette de la souris (PC) : carte suivante / précédente
  let wheelAt = 0;
  root.addEventListener('wheel', e => {
    const b = $('#split-body');
    if (b && b.contains(e.target)) {
      const canScroll = e.deltaY > 0 ? b.scrollTop + b.clientHeight < b.scrollHeight - 2 : b.scrollTop > 2;
      if (canScroll) return;
    }
    e.preventDefault();
    if (Math.abs(e.deltaY) < 20 || Date.now() - wheelAt < 650) return;
    wheelAt = Date.now();
    move(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  mountVideo();
  // Première utilisation : proposer de choisir la vidéo (l'animation tourne en attendant)
  if (!settings.videoAsked) {
    settings.videoAsked = true;
    saveSettings();
    setTimeout(openVideoPicker, 350);
  }
}

function renderSplit(anim = '') {
  const s = state.session, deck = state.deck;
  if (!$('.split')) buildSplitLayout();
  clearTimeout(splitState.timer);
  const pane = $('#split-card');
  const total = s.order.length;
  let card = null;
  if (total && !s.finished) {
    card = currentCard(s);
    if (!card) { // carte supprimée entre-temps
      s.order.splice(s.index, 1);
      s.index = Math.max(0, Math.min(s.index, s.order.length - 1));
      return renderSplit();
    }
  }
  const pos = s.finished ? total : Math.min(s.index + 1, total);
  const auto = settings.autoAdvance;
  const bar = `
    <div class="split-progress"><div style="width:${total ? Math.round(pos / total * 100) : 0}%"></div></div>
    <div class="split-bar">
      <button class="split-btn" data-act="exit-split" aria-label="Quitter le mode vidéo" title="Quitter">${ICON.close}</button>
      ${state.canEdit && card ? `<button class="split-btn" data-act="edit-current" aria-label="Modifier cette carte" title="Modifier (E)">${ICON.edit}</button>` : ''}
      <span class="split-count">${pos} / ${total}</span>
      <button class="split-btn ${auto ? 'on' : ''}" data-act="toggle-auto" title="Défilement automatique : touche pour changer la vitesse ou l'arrêter">${auto ? '' : ICON.play}<span>${auto ? `Auto ${settings.autoDelay || 5} s` : 'Auto'}</span></button>
      <button class="split-btn" data-act="video-source" aria-label="Changer de vidéo" title="Changer de vidéo">${ICON.film}</button>
    </div>`;

  if (!card) {
    pane.innerHTML = bar + `<div class="split-body" id="split-body"><div class="split-inner split-end ${anim}">
      <h2>${total ? 'Fin du paquet' : 'Aucune carte'}</h2>
      <p class="muted">${total ? `Tu as parcouru les ${plural(total, 'carte')}.` : 'Ce paquet ne contient pas encore de carte.'}</p>
      <div class="row center">
        ${total ? '<button class="btn primary" data-act="restart-video">Recommencer</button>' : ''}
        <button class="btn" data-act="exit-split">Quitter</button>
      </div>
      ${total ? '<p class="hint">Glisse vers le bas pour revenir à la dernière carte.</p>' : ''}
    </div></div>`;
    return;
  }

  const [q, a] = s.reverse ? [card.back, card.front] : [card.front, card.back];
  const content = s.flipped
    ? `<div class="face-q md">${md(q, deck)}</div><div class="md split-answer">${md(a, deck) || '<p class="muted">(vide)</p>'}</div>`
    : `<div class="md split-question">${md(q, deck)}</div>`;
  pane.innerHTML = bar + `
    <div class="split-body" id="split-body"><div class="split-inner ${s.flipped ? 'is-back' : 'is-front'} ${anim}" id="fc">${content}</div></div>
    <p class="split-hint">${s.flipped ? 'Glisse ↑ pour la carte suivante · ↓ pour la précédente' : 'Touche pour retourner · glisse ↑ pour la suivante'}</p>`;

  // Défilement automatique : recto N s, verso 1,6 × N s, puis carte suivante
  if (auto) {
    const d = (settings.autoDelay || 5) * 1000;
    const tick = () => {
      if (modal.open || document.hidden) { splitState.timer = setTimeout(tick, 1000); return; }
      s.flipped ? move(1) : flip();
    };
    splitState.timer = setTimeout(tick, s.flipped ? d * 1.6 : d);
  }
}

/* ---------- La vidéo ---------- */
function youtubeId(url) {
  const v = (url || '').trim();
  const m = v.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(v) ? v : null;
}

async function mountVideo() {
  const pane = $('#split-video');
  if (!pane) return;
  stopVideo();
  const src = settings.videoSource || 'anim';
  let note = '';
  if (src === 'file') {
    const rec = await getMedia('video').catch(() => null);
    if (!$('#split-video')) return; // l'utilisateur a quitté entre-temps
    if (rec?.blob) {
      splitState.url = URL.createObjectURL(rec.blob);
      pane.innerHTML = `<video muted loop playsinline autoplay preload="auto"></video>`;
      const v = pane.querySelector('video');
      v.muted = true;
      v.src = splitState.url;
      // Démarrer à un moment au hasard pour varier
      v.addEventListener('loadedmetadata', () => { if (isFinite(v.duration) && v.duration > 30) v.currentTime = Math.random() * (v.duration - 15); }, { once: true });
      // Les navigateurs bloquent parfois la lecture automatique (onglet masqué, mode économie d'énergie) :
      // relancer dès que l'appli redevient visible ou au premier toucher
      const resume = () => { if (v.paused && document.visibilityState === 'visible') v.play().catch(() => {}); };
      document.addEventListener('visibilitychange', resume);
      document.addEventListener('pointerdown', resume);
      splitState.cleanup.push(() => {
        document.removeEventListener('visibilitychange', resume);
        document.removeEventListener('pointerdown', resume);
      });
      resume();
      return;
    }
    note = 'Aucune vidéo enregistrée sur cet appareil';
  } else if (src === 'youtube') {
    const id = youtubeId(settings.youtubeUrl);
    if (id && navigator.onLine) {
      pane.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1" allow="autoplay; encrypted-media" title="Vidéo" tabindex="-1"></iframe>`;
      // Remplir toute la zone (comme object-fit: cover) avec une vidéo 16:9
      const fit = () => {
        const f = pane.querySelector('iframe');
        if (!f) return;
        const w = pane.clientWidth, h = pane.clientHeight;
        let fw = w, fh = w * 9 / 16;
        if (fh < h) { fh = h; fw = h * 16 / 9; }
        Object.assign(f.style, { width: fw + 'px', height: fh + 'px', left: (w - fw) / 2 + 'px', top: (h - fh) / 2 + 'px' });
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(pane);
      splitState.cleanup.push(() => ro.disconnect());
      return;
    }
    note = id ? 'Pas de réseau : vidéo YouTube indisponible' : 'Lien YouTube non reconnu';
  }
  pane.innerHTML = `<canvas></canvas>${note ? `<span class="video-note">${esc(note)} — animation affichée</span>` : ''}`;
  splitState.runner = createRunner(pane.querySelector('canvas'));
}

async function openVideoPicker() {
  const rec = await getMedia('video').catch(() => null);
  const cur = settings.videoSource || 'anim';
  const mb = n => Math.max(1, Math.round(n / 1048576)) + ' Mo';
  const m = openModal(`
    <h2>Vidéo du mode écran partagé</h2>
    <div class="vid-options">
      <label class="vid-opt"><input type="radio" name="vsrc" value="anim" ${cur === 'anim' ? 'checked' : ''}>
        <span><b>Animation intégrée</b><small>Mini jeu de course dessiné par l'appli. Hors connexion, aucun fichier.</small></span></label>
      <label class="vid-opt"><input type="radio" name="vsrc" value="file" ${cur === 'file' ? 'checked' : ''}>
        <span><b>Vidéo de mon appareil</b><small id="vid-info">${rec ? `${esc(rec.name)} · ${mb(rec.size)}` : 'Aucune vidéo choisie'}</small>
          <span class="row"><button type="button" class="btn" id="vid-pick">Choisir une vidéo…</button>${rec ? '<button type="button" class="btn ghost danger" id="vid-del">Supprimer</button>' : ''}</span></span></label>
      <label class="vid-opt"><input type="radio" name="vsrc" value="youtube" ${cur === 'youtube' ? 'checked' : ''}>
        <span><b>Lien YouTube</b><small>Nécessite internet. Si la vidéo refuse de s'afficher hors de YouTube, essaie-en une autre.</small>
          <input type="url" id="vid-yt" placeholder="https://www.youtube.com/watch?v=…" value="${esc(settings.youtubeUrl || '')}"></span></label>
    </div>
    <p class="hint">La vidéo de ton appareil reste <b>uniquement sur cet appareil</b> : elle n'est ni synchronisée ni publiée. Conseil : 3 à 10 minutes en 720p ; elle tourne en boucle et démarre à un moment au hasard.</p>
    <input type="file" accept="video/*" id="vid-input" hidden>
    <div class="row end"><button class="btn ghost" data-act="close">Annuler</button><button class="btn primary" id="vid-ok">Valider</button></div>`);
  const pick = v => { m.querySelector(`input[name=vsrc][value=${v}]`).checked = true; };
  let hasFile = !!rec;
  $('#vid-pick', m).onclick = () => $('#vid-input', m).click();
  $('#vid-input', m).onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 800 * 1048576 && !confirm(`Cette vidéo pèse ${mb(file.size)}. Elle va prendre beaucoup de place sur l'appareil.\nUne vidéo plus courte ou en 720p suffit. Continuer quand même ?`)) return;
    $('#vid-info', m).textContent = 'Enregistrement…';
    try {
      await putMedia({ key: 'video', blob: file, name: file.name, size: file.size, type: file.type, added: Date.now() });
      hasFile = true;
      $('#vid-info', m).textContent = `${file.name} · ${mb(file.size)}`;
      pick('file');
    } catch (err) {
      $('#vid-info', m).textContent = 'Impossible d’enregistrer la vidéo (espace insuffisant ?)';
      console.error(err);
    }
  };
  $('#vid-del', m)?.addEventListener('click', async () => {
    await delMedia('video');
    hasFile = false;
    $('#vid-info', m).textContent = 'Aucune vidéo choisie';
    $('#vid-del', m)?.remove();
    if (m.querySelector('input[name=vsrc][value=file]').checked) pick('anim');
  });
  $('#vid-yt', m).addEventListener('input', () => pick('youtube'));
  $('#vid-ok', m).onclick = () => {
    const src = m.querySelector('input[name=vsrc]:checked')?.value || 'anim';
    if (src === 'file' && !hasFile) return toast('Choisis d’abord une vidéo sur ton appareil');
    if (src === 'youtube') {
      const url = $('#vid-yt', m).value.trim();
      if (!youtubeId(url)) return toast('Lien YouTube non reconnu');
      settings.youtubeUrl = url;
    }
    settings.videoSource = src;
    saveSettings();
    closeModal();
    if ($('#split-video')) mountVideo();
  };
}

/* ---------- Animation intégrée : course infinie sur trois voies ----------
   Dessin en perspective sur un canvas : voies ferrées, murs colorés, trains, barrières
   et pièces ; le coureur esquive tout seul (changement de voie, saut). */
function createRunner(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 1, h = 1, raf = 0, last = performance.now(), time = 0;
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, canvas.clientWidth);
    h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);
  fit();

  const D = 1.6, FAR = 15, PZ = 0.75; // perspective, profondeur visible, position du coureur
  const TRAINS = ['#c0392b', '#2e64c9', '#e2a21d', '#2f9e6a', '#8a4fd1'];
  const WALLS = ['#f2c14e', '#f78154', '#4d9de0', '#7768ae', '#3bb273', '#e15554', '#57c4c4'];
  let travel = 0, speed = 7, score = 0, spawn = 3;
  let items = [];
  const runner = { lane: 0, x: 0, jump: 0, vy: 0 };
  let hor = 0, base = 0, cx = 0, lw = 0;
  const S = z => D / (D + Math.max(z, -D * 0.6));
  const X = (l, z) => cx + l * lw * S(z);
  const Y = z => hor + (base - hor) * S(z);
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const shade = (hex, amt) => {
    const n = parseInt(hex.slice(1), 16), t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (t - v) * p));
    return `rgb(${c.join(',')})`;
  };
  const quad = (...p) => { ctx.beginPath(); ctx.moveTo(p[0], p[1]); for (let i = 2; i < 8; i += 2) ctx.lineTo(p[i], p[i + 1]); ctx.closePath(); ctx.fill(); };
  const line = (a, b, c, d) => { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); };
  const disc = (x, y, rx, ry = rx) => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2); ctx.fill(); };

  function spawnRow(z0 = FAR) {
    const lanes = [-1, 0, 1].sort(() => Math.random() - 0.5);
    const r = Math.random();
    if (r < 0.55) {
      const n = Math.random() < 0.35 ? 2 : 1; // toujours au moins une voie libre
      for (let i = 0; i < n; i++) items.push({ kind: 'train', lane: lanes[i], z: z0, len: 4 + Math.random() * 3, color: TRAINS[Math.floor(Math.random() * TRAINS.length)] });
      for (let k = 0; k < 5; k++) items.push({ kind: 'coin', lane: lanes[2], z: z0 + k * 0.9 });
    } else if (r < 0.85) {
      items.push({ kind: 'barrier', lane: lanes[0], z: z0 });
      for (let k = 0; k < 4; k++) items.push({ kind: 'coin', lane: lanes[1], z: z0 + k * 0.9 });
    } else {
      for (let k = 0; k < 7; k++) items.push({ kind: 'coin', lane: lanes[0], z: z0 + k * 0.8 });
    }
  }
  for (let z = 5; z < FAR; z += 6) spawnRow(z);

  const blocked = (l, a, b) => items.some(it => it.kind === 'train' && it.lane === l && it.z < b && it.z + it.len > a);

  function update(dt) {
    time += dt;
    speed = Math.min(12, speed + dt * 0.06);
    const dz = speed * dt;
    travel += dz;
    for (const it of items) it.z -= dz;
    items = items.filter(it => !it.taken && it.z + (it.len || 0) > -1.5);
    spawn -= dz;
    if (spawn <= 0) { spawnRow(); spawn = 4.5 + Math.random() * 4; }
    // Esquive automatique : changer de voie devant un train, sauter une barrière
    if (blocked(runner.lane, PZ - 0.3, PZ + 4)) {
      const free = [runner.lane - 1, runner.lane + 1].filter(l => l >= -1 && l <= 1 && !blocked(l, PZ - 1, PZ + 5));
      if (free.length) runner.lane = free[Math.floor(Math.random() * free.length)];
    }
    if (runner.jump === 0 && items.some(it => it.kind === 'barrier' && it.lane === runner.lane && it.z > PZ && it.z < PZ + 1.3)) runner.vy = 3.4;
    runner.x += (runner.lane - runner.x) * Math.min(1, dt * 9);
    if (runner.vy || runner.jump > 0) {
      runner.jump += runner.vy * dt;
      runner.vy -= 9.5 * dt;
      if (runner.jump <= 0) { runner.jump = 0; runner.vy = 0; }
    }
    for (const it of items) {
      if (it.kind === 'coin' && Math.abs(it.z - PZ) < 0.35 && Math.abs(it.lane - runner.x) < 0.4) { it.taken = true; score++; }
    }
  }

  function drawWalls() {
    const seg = 3, off = travel % seg, first = Math.floor(travel / seg);
    for (let k = Math.ceil(FAR / seg) + 1; k >= 0; k--) {
      const z1 = k * seg - off, z2 = z1 + seg * 0.94;
      if (z2 < -1) continue;
      const idx = first + k;
      for (const side of [-1, 1]) {
        const col = WALLS[Math.floor(hash(idx * 3 + (side > 0 ? 1 : 0)) * WALLS.length)];
        const H = 1.4 + hash(idx * 7 + side * 3) * 1.8;
        const xw = side * 1.8;
        const za = Math.max(z1, -1);
        const xa = X(xw, za), xb = X(xw, z2), ya = Y(za), yb = Y(z2);
        const ha = H * lw * S(za), hb = H * lw * S(z2);
        ctx.fillStyle = col;
        quad(xa, ya, xb, yb, xb, yb - hb, xa, ya - ha);
        ctx.fillStyle = shade(col, -0.22); // bandeau sombre en haut du mur
        quad(xa, ya - ha, xb, yb - hb, xb, yb - hb * 0.86, xa, ya - ha * 0.86);
        ctx.fillStyle = shade(col, 0.35); // grande fenêtre
        const mid = (a, b, t) => a + (b - a) * t;
        quad(mid(xa, xb, 0.25), mid(ya - ha * 0.35, yb - hb * 0.35, 0.25), mid(xa, xb, 0.7), mid(ya - ha * 0.35, yb - hb * 0.35, 0.7),
          mid(xa, xb, 0.7), mid(ya - ha * 0.65, yb - hb * 0.65, 0.7), mid(xa, xb, 0.25), mid(ya - ha * 0.65, yb - hb * 0.65, 0.25));
      }
    }
  }

  function drawTrack() {
    ctx.fillStyle = '#7d705e';
    quad(X(-1.7, FAR), Y(FAR), X(1.7, FAR), Y(FAR), X(1.7, -0.9), Y(-0.9), X(-1.7, -0.9), Y(-0.9));
    const gap = 0.9, off = travel % gap;
    ctx.strokeStyle = '#5b4636';
    for (let i = 0; i <= FAR / gap + 1; i++) {
      const z = i * gap - off;
      if (z < -0.8 || z > FAR) continue;
      ctx.lineWidth = Math.max(1, 0.07 * lw * S(z));
      for (const l of [-1, 0, 1]) line(X(l - 0.42, z), Y(z), X(l + 0.42, z), Y(z));
    }
    ctx.strokeStyle = '#cfd3d8';
    for (const l of [-1, 0, 1]) for (const o of [-0.28, 0.28]) {
      ctx.lineWidth = Math.max(1, 0.025 * lw);
      line(X(l + o, FAR), Y(FAR), X(l + o, -0.8), Y(-0.8));
    }
  }

  function drawTrain(it) {
    const z1 = Math.max(it.z, -0.5), z2 = Math.min(it.z + it.len, FAR + 8);
    if (z2 < -0.5 || z1 > FAR) return;
    const hw = 0.44, th = 1.15, s1 = S(z1), s2 = S(z2);
    const fl = X(it.lane - hw, z1), fr = X(it.lane + hw, z1), fy = Y(z1), ft = fy - th * lw * s1;
    const bl = X(it.lane - hw, z2), br = X(it.lane + hw, z2), by = Y(z2), bt = by - th * lw * s2;
    ctx.fillStyle = shade(it.color, 0.3);
    quad(fl, ft, fr, ft, br, bt, bl, bt); // toit
    ctx.fillStyle = shade(it.color, -0.25);
    if (it.lane < 0) quad(fr, fy, br, by, br, bt, fr, ft); // flanc visible depuis le centre
    if (it.lane > 0) quad(fl, fy, bl, by, bl, bt, fl, ft);
    const fw = fr - fl, fh = fy - ft;
    ctx.fillStyle = it.color;
    ctx.fillRect(fl, ft, fw, fh);
    ctx.fillStyle = '#1d2733';
    ctx.fillRect(fl + fw * 0.14, ft + fh * 0.12, fw * 0.72, fh * 0.3);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(fl, ft + fh * 0.55, fw, fh * 0.06);
    ctx.fillStyle = '#ffe9a8';
    disc(fl + fw * 0.2, ft + fh * 0.78, fw * 0.07);
    disc(fr - fw * 0.2, ft + fh * 0.78, fw * 0.07);
  }

  function drawBarrier(it) {
    if (it.z > FAR || it.z < -0.6) return;
    const s = S(it.z), y = Y(it.z), x1 = X(it.lane - 0.4, it.z), x2 = X(it.lane + 0.4, it.z);
    const bh = 0.2 * lw * s, lift = 0.28 * lw * s, bw = x2 - x1;
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(x1 + bw * 0.08, y - lift, bw * 0.06, lift);
    ctx.fillRect(x2 - bw * 0.14, y - lift, bw * 0.06, lift);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#e03b2f';
      ctx.fillRect(x1 + (bw / 6) * i, y - lift - bh, bw / 6 + 0.5, bh);
    }
  }

  function drawCoin(it) {
    if (it.z > FAR || it.z < -0.5) return;
    const s = S(it.z), r = 0.1 * lw * s, x = X(it.lane, it.z), y = Y(it.z) - 0.38 * lw * s;
    const sx = Math.max(0.25, Math.abs(Math.cos(time * 4 + it.z)));
    ctx.fillStyle = '#f6c431';
    disc(x, y, r * sx, r);
    ctx.strokeStyle = '#c78f12';
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.beginPath(); ctx.ellipse(x, y, r * sx, r, 0, 0, Math.PI * 2); ctx.stroke();
  }

  function drawRunner() {
    const s = S(PZ), u = lw * s * 0.42;
    const x = cx + runner.x * lw * s, gy = Y(PZ), y = gy - runner.jump * lw * s;
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    disc(x, gy, u * 0.55, u * 0.14);
    const run = Math.sin(time * 14) * (runner.jump > 0 ? 0.25 : 1);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2b3a67';
    ctx.lineWidth = u * 0.22;
    line(x - u * 0.13, y - u * 0.95, x - u * 0.13 + run * u * 0.28, y - u * 0.12);
    line(x + u * 0.13, y - u * 0.95, x + u * 0.13 - run * u * 0.28, y - u * 0.12);
    ctx.fillStyle = '#f4f4f4';
    disc(x - u * 0.13 + run * u * 0.28, y - u * 0.08, u * 0.14, u * 0.08);
    disc(x + u * 0.13 - run * u * 0.28, y - u * 0.08, u * 0.14, u * 0.08);
    ctx.strokeStyle = '#e8463c';
    ctx.lineWidth = u * 0.18;
    line(x - u * 0.3, y - u * 1.6, x - u * 0.48 - run * u * 0.2, y - u * 1.1);
    line(x + u * 0.3, y - u * 1.6, x + u * 0.48 + run * u * 0.2, y - u * 1.1);
    ctx.fillStyle = '#e8463c';
    ctx.beginPath(); ctx.roundRect(x - u * 0.33, y - u * 1.78, u * 0.66, u * 0.9, u * 0.16); ctx.fill();
    ctx.fillStyle = '#5a3b26';
    disc(x, y - u * 2.02, u * 0.27);
    ctx.fillStyle = '#1e66d0';
    ctx.beginPath(); ctx.arc(x, y - u * 2.06, u * 0.28, Math.PI, 0); ctx.fill();
  }

  function draw() {
    hor = h * 0.36; base = h * 1.02; cx = w / 2; lw = Math.min(w * 0.3, h * 0.55);
    const g = ctx.createLinearGradient(0, 0, 0, hor);
    g.addColorStop(0, '#5fb4f0'); g.addColorStop(1, '#c4e8ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hor + 1);
    ctx.fillStyle = '#93b9d6';
    for (let i = 0; i < 22; i++) {
      const bw = w / 18, bh = (0.25 + hash(i) * 0.6) * hor * 0.55;
      ctx.fillRect(i * bw - bw * 0.5, hor - bh, bw * 0.9, bh);
    }
    ctx.fillStyle = '#9c8f7c';
    ctx.fillRect(0, hor, w, h - hor);
    drawWalls();
    drawTrack();
    let runnerDrawn = false;
    for (const it of [...items].sort((a, b) => b.z - a.z)) {
      if (!runnerDrawn && it.z < PZ) { drawRunner(); runnerDrawn = true; }
      if (it.kind === 'train') drawTrain(it);
      else if (it.kind === 'barrier') drawBarrier(it);
      else drawCoin(it);
    }
    if (!runnerDrawn) drawRunner();
    // Compteur de pièces
    const fs = Math.round(Math.max(14, Math.min(26, h * 0.07)));
    ctx.font = `800 ${fs}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillText(String(score), w - 11, fs * 0.9 + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(score), w - 12, fs * 0.9);
    const tw = ctx.measureText(String(score)).width;
    ctx.fillStyle = '#f6c431';
    disc(w - 12 - tw - fs * 0.55, fs * 0.9, fs * 0.36);
  }

  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { stop() { cancelAnimationFrame(raf); ro.disconnect(); } };
}
