'use strict';

/* =========================================================
   Stockage local (IndexedDB) — tout reste sur l'appareil
   Dossier : { id, name, created }
   Paquet  : { id, name, description, folderId, created, updated,
               images: { clé: dataURL }, cards: [Carte] }
   Carte   : { id, front, back, created, due, interval, ease, reps, lapses }
   ========================================================= */
const APP_NAME = 'Flash’Agreg';
const DB_NAME = 'flashcards', STORE = 'decks', FOLDERS = 'folders';
let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(FOLDERS)) d.createObjectStore(FOLDERS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const getAll = () => tx(STORE, 'readonly', s => s.getAll());
const getDeck = id => tx(STORE, 'readonly', s => s.get(id));
// kind : 'content' (cartes, nom… → à synchroniser), 'progress' (révisions), 'raw' (écriture par la synchro)
function putDeck(deck, kind = 'content') {
  if (kind === 'content') { deck.updated = deck.editedAt = Date.now(); deck.dirty = true; }
  else if (kind === 'progress') { deck.updated = Date.now(); deck.progressDirty = true; }
  if (kind !== 'raw') scheduleSync();
  return tx(STORE, 'readwrite', s => s.put(deck));
}
const delDeck = id => tx(STORE, 'readwrite', s => s.delete(id));
const getFolders = () => tx(FOLDERS, 'readonly', s => s.getAll());
const getFolder = id => tx(FOLDERS, 'readonly', s => s.get(id));
function putFolder(f, raw = false) {
  if (!raw) { f.updated = Date.now(); f.dirty = true; scheduleSync(); }
  return tx(FOLDERS, 'readwrite', s => s.put(f));
}
const delFolder = id => tx(FOLDERS, 'readwrite', s => s.delete(id));
const byName = (a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true });

/* =========================================================
   Utilitaires
   ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DAY = 864e5;
const state = { deck: null, session: null, folderId: null };

// Icônes (traits simples, couleur héritée du texte)
const svg = (d, extra = '') => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICON = {
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  deck: svg('<rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  import: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  cycle: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>'),
  book: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 9"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  cut: svg('<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M8.5 15.5L19 4M15.5 15.5L5 4"/>'),
  paste: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.6 3 2.4 3 5.2"/>'),
  user: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>'),
  spark: svg('<path d="M4 20L14 10"/><path d="M16 3l1 2.5L19.5 6.5 17 7.5 16 10l-1-2.5L12.5 6.5 15 5.5z"/>'),
};

const settings = (() => { try { return JSON.parse(localStorage.getItem('fc-settings')) || {}; } catch { return {}; } })();
function saveSettings() { try { localStorage.setItem('fc-settings', JSON.stringify(settings)); } catch { /* stockage indisponible */ } }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'paquet';
}
function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Copié dans le presse-papiers');
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const isDue = (c, now = Date.now()) => !c.due || c.due <= now;

/* =========================================================
   Mise en forme des cartes (mini-Markdown + images)
   **gras**, *italique*, `code`, listes "- " / "1. ", titres "# ",
   images ![légende](img:clé) | ![](https://...) | ![](data:image/...)
   ========================================================= */
function resolveImg(src, deck) {
  const images = deck?.images || {};
  if (src.startsWith('img:')) return images[src.slice(4)] || null;
  if (/^(https?:|data:image\/)/i.test(src)) return src;
  return images[src] || null;
}
function inline(s, deck) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      const url = resolveImg(src.replace(/&amp;/g, '&'), deck);
      return url
        ? `<img src="${esc(url)}" alt="${alt}" loading="lazy">`
        : `<span class="missing">[image introuvable : ${alt || src}]</span>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function md(text, deck) {
  const lines = esc(text).split(/\r?\n/);
  let html = '', list = null, para = [];
  const flushP = () => { if (para.length) { html += '<p>' + para.map(l => inline(l, deck)).join('<br>') + '</p>'; para = []; } };
  const flushL = () => { if (list) { html += `</${list}>`; list = null; } };
  const openL = tag => { flushP(); if (list !== tag) { flushL(); html += `<${tag}>`; list = tag; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { openL('ul'); html += '<li>' + inline(m[1], deck) + '</li>'; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { openL('ol'); html += '<li>' + inline(m[1], deck) + '</li>'; }
    else if ((m = l.match(/^#{1,6}\s+(.*)/))) { flushP(); flushL(); html += '<h4>' + inline(m[1], deck) + '</h4>'; }
    else if (!l.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(l); }
  }
  flushP(); flushL();
  return html;
}
function plain(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s*(#+|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}
// Supprime les images qui ne sont plus utilisées par aucune carte
function gcImages(deck) {
  const used = new Set();
  for (const c of deck.cards) {
    for (const m of `${c.front}\n${c.back}`.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) used.add(m[1].replace(/^img:/, ''));
  }
  for (const k of Object.keys(deck.images || {})) if (!used.has(k)) delete deck.images[k];
}

/* =========================================================
   Répétition espacée (inspirée de SM-2 / Anki)
   0 = À revoir, 1 = Difficile, 2 = Bien, 3 = Facile
   ========================================================= */
function nextState(card, r) {
  let { interval = 0, ease = 2.5, reps = 0, lapses = 0 } = card;
  const now = Date.now();
  if (r === 0) {
    if (reps > 0) lapses++;
    return { interval: 0, ease: Math.max(1.3, ease - 0.2), reps: 0, lapses, due: now + 60e3, rev: now };
  }
  if (r === 1) { interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2)); ease = Math.max(1.3, ease - 0.15); }
  else if (r === 2) { interval = reps === 0 ? 2 : Math.max(interval + 1, Math.round(interval * ease)); }
  else { interval = reps === 0 ? 4 : Math.max(interval + 2, Math.round(interval * ease * 1.3)); ease += 0.15; }
  return { interval, ease, reps: reps + 1, lapses, due: now + interval * DAY, rev: now }; // rev : date de révision (synchro)
}
function fmtInterval(card, r) {
  const ms = nextState(card, r).due - Date.now();
  if (ms < 3600e3) return `${Math.max(1, Math.round(ms / 60e3))} min`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d} j`;
  if (d < 365) return `${Math.round(d / 30)} mois`;
  return `${(d / 365).toFixed(1).replace('.', ',')} an`;
}

/* =========================================================
   Import / export
   ========================================================= */
const FRONT_KEYS = ['front', 'recto', 'term', 'terme', 'concept', 'notion', 'question', 'q', 'name', 'nom'];
const BACK_KEYS = ['back', 'verso', 'definition', 'définition', 'answer', 'reponse', 'réponse', 'explication', 'a'];
const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; };

function normCard(c) {
  if (Array.isArray(c)) c = { front: c[0], back: c[1] };
  if (!c || typeof c !== 'object') return null;
  const front = pick(c, FRONT_KEYS);
  if (front == null) return null;
  let back = String(pick(c, BACK_KEYS) ?? '').trim();
  const extra = [].concat(c.image || [], c.images || []).filter(x => typeof x === 'string');
  for (const src of extra) back += `\n\n![](${src})`;
  return { front: String(front).trim(), back: back.trim() };
}
function normImages(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    const val = v.trim();
    const key = k.replace(/[^\w-]/g, '_');
    if (/^<svg[\s>]/i.test(val)) out[key] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(val);
    else if (/^(https?:|data:image\/)/i.test(val)) out[key] = val;
  }
  return out;
}
function normalize(data) {
  if (data && data.format === 'flashcards-backup' && Array.isArray(data.decks)) return { backup: data.decks, folders: Array.isArray(data.folders) ? data.folders : [] };
  let decks;
  if (Array.isArray(data)) decks = data.length && data.every(x => x && Array.isArray(x.cards || x.cartes)) ? data : [{ cards: data }];
  else if (data && Array.isArray(data.decks)) decks = data.decks;
  else decks = [data];
  return {
    decks: decks.map(d => ({
      name: String(d.deck || d.name || d.title || d.nom || d.titre || 'Paquet importé').trim(),
      description: String(d.description || '').trim(),
      folder: String(d.folder || d.dossier || data.folder || data.dossier || '').trim(),
      images: normImages(d.images),
      cards: (d.cards || d.cartes || []).map(normCard).filter(Boolean),
    })).filter(d => d.cards.length),
  };
}
function parseInput(text) {
  let t = text.replace(/^﻿/, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start >= 0) {
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    try { return normalize(JSON.parse(t.slice(start, end + 1))); }
    catch (e) { if (start === 0) throw new Error('JSON invalide : ' + e.message); }
  }
  // Format texte : une carte par ligne, "terme<TAB>définition" ou "terme :: définition"
  const cards = t.split(/\r?\n/).map(l => l.split(/\t| :: /)).filter(p => p.length >= 2 && p[0].trim())
    .map(p => ({ front: p[0].trim(), back: p.slice(1).join(' ').trim().replace(/\\n/g, '\n') }));
  if (!cards.length) throw new Error('Format non reconnu. Attendu : JSON, ou une carte par ligne « terme :: définition ».');
  return { decks: [{ name: 'Paquet importé', description: '', images: {}, cards }] };
}

// Ajoute des cartes dans un paquet, en évitant doublons et collisions de noms d'images
function mergeInto(deck, src) {
  deck.images ||= {};
  const rename = {};
  for (const [k, v] of Object.entries(src.images)) {
    let key = k;
    if (deck.images[key] && deck.images[key] !== v) { key = `${k}-${uid()}`; rename[k] = key; }
    deck.images[key] = v;
  }
  const seen = new Set(deck.cards.map(c => c.front + '\u0000' + c.back));
  let added = 0;
  for (const c of src.cards) {
    let back = c.back, front = c.front;
    for (const [from, to] of Object.entries(rename)) {
      const re = new RegExp(`\\]\\((img:)?${from}\\)`, 'g');
      back = back.replace(re, `](img:${to})`);
      front = front.replace(re, `](img:${to})`);
    }
    const sig = front + '\u0000' + back;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deck.cards.push({ id: uid(), front, back, created: Date.now(), updated: Date.now() });
    added++;
  }
  return added;
}

// Retrouve un dossier par son nom, ou le crée
async function folderByName(name) {
  const f = (await getFolders()).find(x => x.name.toLowerCase() === name.toLowerCase() && folderCanWrite(x));
  if (f) return f.id;
  const nf = { id: uid(), name, created: Date.now() };
  await putFolder(nf);
  return nf.id;
}

// intoId : ajouter à ce paquet · folderId : dossier des nouveaux paquets (par défaut : dossier affiché)
async function importText(text, intoId, folderId = state.folderId) {
  const data = parseInput(text);
  if (data.backup) {
    if (!confirm(`Restaurer cette sauvegarde (${plural(data.folders.length, 'dossier')}, ${plural(data.backup.length, 'paquet')}) ?\nLes éléments identiques présents sur cet appareil seront remplacés par ceux de la sauvegarde.`)) return;
    // Les infos de synchro de la sauvegarde ne sont pas reprises : tout est renvoyé comme neuf
    for (const f of data.folders) {
      if (!f || !f.id || !f.name) continue;
      for (const k of ['remote', 'role', 'owner', 'ownerEmail', 'members']) delete f[k];
      await putFolder(f);
    }
    for (const d of data.backup) {
      if (!d || !Array.isArray(d.cards)) continue;
      d.id ||= uid(); d.name ||= 'Paquet'; d.images ||= {};
      delete d.remoteAt; delete d.owner;
      await putDeck(d);
    }
    toast('Sauvegarde restaurée');
    return go('#/');
  }
  if (!data.decks.length) throw new Error('Aucune carte trouvée dans ce contenu.');

  const existing = await getAll();
  let lastId = null, total = 0;
  for (const src of data.decks) {
    let deck = intoId ? existing.find(d => d.id === intoId) : null;
    if (!deck) {
      const same = existing.find(d => d.name.toLowerCase() === src.name.toLowerCase() && (!d.owner || d.owner === me()?.id));
      if (same && confirm(`Un paquet « ${same.name} » existe déjà.\nOK = y ajouter les cartes · Annuler = créer un nouveau paquet`)) deck = same;
    }
    if (!deck) {
      const fid = src.folder ? await folderByName(src.folder) : folderId || null;
      deck = { id: uid(), name: src.name, description: src.description, folderId: fid, created: Date.now(), images: {}, cards: [] };
      existing.push(deck);
    }
    total += mergeInto(deck, src);
    await putDeck(deck);
    lastId = deck.id;
  }
  toast(`${plural(total, 'carte')} importée${total > 1 ? 's' : ''}`);
  go(data.decks.length === 1 || intoId ? `#/deck/${lastId}` : folderId ? `#/folder/${folderId}` : '#/');
}

function exportDeck(deck) {
  download(`${slug(deck.name)}.json`, {
    format: 'flashcards-v1', deck: deck.name, description: deck.description || '',
    cards: deck.cards.map(({ front, back }) => ({ front, back })), images: deck.images || {},
  });
}
async function exportBackup() {
  const [decks, folders] = await Promise.all([getAll(), getFolders()]);
  const date = new Date().toISOString().slice(0, 10);
  download(`flashagreg-sauvegarde-${date}.json`, { format: 'flashcards-backup', version: 2, exported: new Date().toISOString(), folders, decks });
  toast('Sauvegarde téléchargée');
}

/* =========================================================
   Images : réduction avant stockage (économise la place)
   ========================================================= */
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}
async function compressImage(file, max = 1400) {
  if (/svg|gif/.test(file.type)) return readAsDataURL(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Image illisible')); img.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

/* =========================================================
   Vues
   ========================================================= */
function setHeader(title, backHash, actionsHtml = '', { brand = false, crumb = '' } = {}) {
  $('#title').innerHTML = brand
    ? `<span class="brand-mark">FA</span><span class="brand-name">Flash<span>’</span>Agreg</span>`
    : `${crumb ? `<small class="crumb">${esc(crumb)}</small>` : ''}<span class="title-text">${esc(title)}</span>`;
  document.title = brand ? APP_NAME : `${title} · ${APP_NAME}`;
  const back = $('#back');
  back.hidden = !backHash;
  back.onclick = () => go(backHash);
  $('#actions').innerHTML = actionsHtml;
}

const dueCount = (d, now = Date.now()) => d.cards.filter(c => isDue(c, now)).length;

function deckRow(d, now) {
  const due = dueCount(d, now);
  return `<li><a class="row-item" href="#/deck/${d.id}">
    <span class="row-icon">${ICON.deck}</span>
    <span class="row-main"><span class="row-name">${esc(d.name)}</span><span class="row-meta">${plural(d.cards.length, 'carte')}</span></span>
    ${due ? `<span class="badge">${due} à réviser</span>` : '<span class="badge ok">à jour</span>'}
    <span class="row-chevron">${ICON.chevron}</span>
  </a></li>`;
}
function sharedLabel(f) {
  if (f.role && f.role !== 'owner') return `partagé par ${esc(f.ownerEmail || 'un camarade')}${f.role === 'read' ? ' (lecture seule)' : ''}`;
  if (f.members?.length) return `partagé avec ${plural(f.members.length, 'personne')}`;
  return '';
}
function folderRow(f, decks, now) {
  const inside = decks.filter(d => d.folderId === f.id);
  const due = inside.reduce((n, d) => n + dueCount(d, now), 0);
  const cards = inside.reduce((n, d) => n + d.cards.length, 0);
  return `<li><a class="row-item folder" href="#/folder/${f.id}">
    <span class="row-icon">${f.role && f.role !== 'owner' ? ICON.users : ICON.folder}</span>
    <span class="row-main"><span class="row-name">${esc(f.name)}</span><span class="row-meta">${plural(inside.length, 'paquet')} · ${plural(cards, 'carte')}${sharedLabel(f) ? ` · <span class="shared">${sharedLabel(f)}</span>` : ''}</span></span>
    ${due ? `<span class="badge">${due} à réviser</span>` : ''}
    <span class="row-chevron">${ICON.chevron}</span>
  </a></li>`;
}

async function renderHome() {
  state.deck = null;
  state.folderId = null;
  const [decks, folders] = await Promise.all([getAll(), getFolders()]);
  const ids = new Set(folders.map(f => f.id));
  const loose = decks.filter(d => !d.folderId || !ids.has(d.folderId)).sort(byName);
  setHeader(APP_NAME, null,
    `<button class="icon-btn" data-act="import" aria-label="Importer" title="Importer">${ICON.import}</button><button class="icon-btn" data-act="menu" aria-label="Menu" title="Menu">${ICON.more}</button>`,
    { brand: true });
  const now = Date.now();
  const totalDue = decks.reduce((n, d) => n + dueCount(d, now), 0);
  if (!decks.length && !folders.length) {
    app.innerHTML = `<div class="empty">
      <h2>Bienvenue sur Flash’Agreg</h2>
      <p>Range tes paquets de cartes par dossier (une matière, une épreuve…), crée tes cartes à la main ou fais-les générer par Claude à partir de ton cours.</p>
      <div class="row">
        <button class="btn primary" data-act="new-folder">${ICON.folder} Nouveau dossier</button>
        <button class="btn" data-act="new-deck">${ICON.plus} Nouveau paquet</button>
        <button class="btn" data-act="import">${ICON.import} Importer</button>
      </div>
      <p class="empty-links"><button class="link" data-act="help">Générer des cartes avec Claude</button> · <button class="link" data-act="example">Charger un paquet d’exemple</button></p>
    </div>`;
    return;
  }
  app.innerHTML = `
    <section class="hero">
      <div><span class="hero-num">${totalDue}</span><span class="hero-label">carte${totalDue > 1 ? 's' : ''} à réviser aujourd’hui</span></div>
      <div class="hero-sub">${plural(folders.length, 'dossier')} · ${plural(decks.length, 'paquet')}</div>
    </section>
    <div class="row">
      <button class="btn primary" data-act="new-folder">${ICON.folder} Nouveau dossier</button>
      <button class="btn" data-act="new-deck">${ICON.plus} Nouveau paquet</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="help">${ICON.spark} Générer avec Claude</button>
    </div>
    ${folders.length ? `<h3 class="section">Dossiers</h3><ul class="list">${folders.sort(byName).map(f => folderRow(f, decks, now)).join('')}</ul>` : ''}
    ${loose.length ? `<h3 class="section">${folders.length ? 'Paquets hors dossier' : 'Paquets'}</h3><ul class="list">${loose.map(d => deckRow(d, now)).join('')}</ul>` : ''}`;
}

async function renderFolder(id) {
  const folder = await getFolder(id);
  if (!folder) return go('#/');
  state.deck = null;
  state.folderId = id;
  const decks = (await getAll()).filter(d => d.folderId === id).sort(byName);
  const now = Date.now();
  const due = decks.reduce((n, d) => n + dueCount(d, now), 0);
  const writable = folderCanWrite(folder);
  const isOwner = !folder.role || folder.role === 'owner';
  setHeader(folder.name, '#/',
    `${isOwner ? `<button class="icon-btn" data-act="share-folder" aria-label="Partager" title="Partager">${ICON.users}</button>` : ''}<button class="icon-btn" data-act="folder-menu" aria-label="Options du dossier" title="Options">${ICON.more}</button>`,
    { crumb: isOwner ? 'Dossier' : 'Dossier partagé' });
  app.innerHTML = `
    ${sharedLabel(folder) ? `<p class="notice">${ICON.users}<span>Dossier ${sharedLabel(folder)}.</span></p>` : ''}
    <div class="stats">
      <div><b>${decks.length}</b><span>paquet${decks.length > 1 ? 's' : ''}</span></div>
      <div><b>${decks.reduce((n, d) => n + d.cards.length, 0)}</b><span>cartes</span></div>
      <div><b>${due}</b><span>à réviser</span></div>
    </div>
    ${writable ? `<div class="row">
      <button class="btn primary" data-act="new-deck">${ICON.plus} Nouveau paquet</button>
      <button class="btn" data-act="import">${ICON.import} Importer ici</button>
      ${isOwner ? `<span class="spacer"></span><button class="btn ghost" data-act="share-folder">${ICON.users} Partager</button>` : ''}
    </div>` : ''}
    ${decks.length
      ? `<ul class="list">${decks.map(d => deckRow(d, now)).join('')}</ul>`
      : `<p class="muted empty-inline">Ce dossier est vide.${writable ? ' Crée un paquet, importe-en un, ou déplace un paquet existant ici (menu ⋯ du paquet → « Déplacer vers un dossier »).' : ''}</p>`}`;
}

async function renderDeck(id) {
  const deck = await getDeck(id);
  if (!deck) return go('#/');
  state.deck = deck;
  const folder = deck.folderId ? await getFolder(deck.folderId) : null;
  state.folderId = folder ? folder.id : null;
  state.canEdit = canEditDeck(deck, folder);
  const now = Date.now();
  const due = dueCount(deck, now);
  const fresh = deck.cards.filter(c => !c.reps).length;
  setHeader(deck.name, folder ? `#/folder/${folder.id}` : '#/',
    `<button class="icon-btn" data-act="deck-menu" aria-label="Options du paquet" title="Options">${ICON.more}</button>`,
    { crumb: folder ? folder.name : 'Paquet' });
  const off = deck.cards.length ? '' : 'disabled';
  app.innerHTML = `
    ${state.canEdit ? '' : `<p class="notice">${ICON.users}<span>Paquet partagé en <b>lecture seule</b> : tu peux le réviser (ta progression est personnelle) mais pas le modifier. Menu ⋯ → « Copier dans mes paquets » pour en faire ta propre version.</span></p>`}
    ${deck.description ? `<p class="desc">${esc(deck.description)}</p>` : ''}
    <div class="stats">
      <div><b>${deck.cards.length}</b><span>cartes</span></div>
      <div><b>${due}</b><span>à réviser</span></div>
      <div><b>${fresh}</b><span>jamais vues</span></div>
    </div>
    <h3 class="section">Mode d’apprentissage</h3>
    <div class="modes">
      <a class="mode-card ${off}" href="#/study/${id}/due">
        <span class="mode-icon">${ICON.cycle}</span>
        <b>Révision espacée</b>
        <span>Tu notes chaque carte, de « À revoir » à « Facile » ; elle revient au bon moment.</span>
        <em>${due ? `${due} à réviser` : 'À jour'}</em>
      </a>
      <a class="mode-card ${off}" href="#/study/${id}/browse">
        <span class="mode-icon">${ICON.book}</span>
        <b>Parcourir</b>
        <span>Passe d’une carte à l’autre avec les flèches ← → ou en glissant, sans noter.</span>
        <em>${plural(deck.cards.length, 'carte')}</em>
      </a>
    </div>
    <div class="options">
      <label class="switch"><input type="checkbox" data-setting="typing" ${settings.typing ? 'checked' : ''}><span>Taper ma réponse avant de retourner la carte</span></label>
      <label class="switch"><input type="checkbox" data-setting="reverse" ${settings.reverse ? 'checked' : ''}><span>Sens inversé : afficher la définition en premier</span></label>
      <label class="switch"><input type="checkbox" data-setting="shuffle" ${settings.shuffle ? 'checked' : ''}><span>Ordre aléatoire en mode Parcourir</span></label>
    </div>
    <h3 class="section">Cartes</h3>
    <div class="row">
      ${state.canEdit ? `<button class="btn" data-act="new-card">${ICON.plus} Carte</button>` : ''}
      <input type="search" id="search" placeholder="Rechercher une carte…" aria-label="Rechercher une carte">
    </div>
    <div id="card-tools"></div>
    <ul class="card-list" id="cards"></ul>`;
  state.selection = null;
  renderCardList();
  $('#search').oninput = renderCardList;
  app.querySelectorAll('[data-setting]').forEach(el => {
    el.onchange = () => { settings[el.dataset.setting] = el.checked; saveSettings(); };
  });
}

function renderCardList() {
  const deck = state.deck;
  const q = ($('#search')?.value || '').toLowerCase().trim();
  const list = deck.cards.filter(c => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
  const sel = state.selection;
  // L'ordre ne se modifie que sur la liste complète (pas pendant une recherche ni une sélection)
  const draggable = state.canEdit && !q && !sel && deck.cards.length > 1;
  $('#cards').innerHTML = list.length
    ? list.map(c => `<li data-id="${c.id}" class="${sel?.has(c.id) ? 'selected' : ''}">
        ${draggable ? `<button class="drag-handle" aria-label="Déplacer la carte (glisser, ou flèches haut / bas)" title="Glisser pour déplacer">${ICON.grip}</button>` : ''}
        <button class="card-item" data-act="${sel ? 'toggle-card' : 'edit-card'}" data-id="${c.id}">
          ${sel ? `<span class="tick" aria-hidden="true">${sel.has(c.id) ? ICON.check : ''}</span>` : ''}
          <span class="txt"><span class="front">${esc(plain(c.front))}</span>
          <span class="back">${esc(plain(c.back)) || '<i>(pas de définition)</i>'}</span></span>
          ${/!\[/.test(c.back) ? `<span class="has-img" title="Contient une image">${ICON.image}</span>` : ''}
        </button></li>`).join('')
    : `<li class="muted">${deck.cards.length ? 'Aucun résultat.' : 'Aucune carte. Ajoute-en une, colle des cartes copiées ou importe un fichier.'}</li>`;
  renderCardTools();
  if (draggable) enableCardDrag($('#cards'));
}

/* ---------- Copier / couper / coller des cartes entre paquets ----------
   Presse-papiers propre à l'appli (localStorage) : il survit au changement de paquet
   et au rechargement, pour coller dans n'importe quel autre paquet. */
const cardClipboard = {
  get() { try { return JSON.parse(localStorage.getItem('fa-clipboard')); } catch { return null; } },
  set(v) {
    try { v ? localStorage.setItem('fa-clipboard', JSON.stringify(v)) : localStorage.removeItem('fa-clipboard'); }
    catch { toast('Presse-papiers trop volumineux (images) : copie impossible'); return false; }
    return true;
  },
};

function renderCardTools() {
  const box = $('#card-tools');
  if (!box) return;
  const sel = state.selection;
  const clip = cardClipboard.get();
  if (sel) {
    box.innerHTML = `<div class="select-bar">
      <span class="select-count">${sel.size ? plural(sel.size, 'carte') + ' sélectionnée' + (sel.size > 1 ? 's' : '') : 'Touche les cartes à sélectionner'}</span>
      <span class="spacer"></span>
      <button class="btn ghost" data-act="select-all">Tout</button>
      <button class="btn" data-act="copy-cards" ${sel.size ? '' : 'disabled'}>${ICON.copy} Copier</button>
      ${state.canEdit ? `<button class="btn" data-act="cut-cards" ${sel.size ? '' : 'disabled'}>${ICON.cut} Couper</button>` : ''}
      <button class="btn ghost" data-act="select-cancel">Annuler</button>
    </div>`;
    return;
  }
  const canPaste = clip?.cards?.length && state.canEdit;
  box.innerHTML = state.deck.cards.length || canPaste ? `<div class="row card-tools">
    ${state.deck.cards.length ? `<button class="btn ghost" data-act="select-start">${ICON.check} Sélectionner</button>` : ''}
    ${canPaste ? `<span class="paste-group"><button class="btn" data-act="paste-cards">${ICON.paste} Coller ${plural(clip.cards.length, 'carte')}${clip.cut ? ' (déplacer)' : ''}</button><button class="icon-btn small" data-act="clear-clipboard" aria-label="Vider le presse-papiers" title="Vider le presse-papiers">×</button></span>` : ''}
    ${state.canEdit && state.deck.cards.length > 1 ? `<span class="hint drag-hint">Glisse ${ICON.grip} pour réordonner</span>` : ''}
  </div>` : '';
}

// Place des cartes dans le presse-papiers (avec les images qu'elles utilisent)
function copyToClipboard(ids, cut = false) {
  const deck = state.deck;
  const cards = deck.cards.filter(c => ids.includes(c.id));
  const images = {};
  for (const c of cards) {
    for (const m of `${c.front}\n${c.back}`.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const key = m[1].replace(/^img:/, '');
      if (deck.images?.[key]) images[key] = deck.images[key];
    }
  }
  const ok = cardClipboard.set({
    cards: cards.map(({ front, back }) => ({ front, back })), images,
    cut, from: deck.id, fromName: deck.name, ids: cards.map(c => c.id), at: Date.now(),
  });
  if (!ok) return;
  toast(`${plural(cards.length, 'carte')} ${cut ? 'coupée' : 'copiée'}${cards.length > 1 ? 's' : ''} — ouvre un autre paquet et touche « Coller »`);
}

async function pasteCards() {
  const clip = cardClipboard.get();
  const deck = state.deck;
  if (!clip?.cards?.length || !state.canEdit) return;
  if (clip.cut && clip.from === deck.id) return toast('Ces cartes sont déjà dans ce paquet : glisse-les pour les réordonner');
  // Images : éviter les collisions de noms avec celles du paquet de destination
  deck.images ||= {};
  const rename = {};
  for (const [k, v] of Object.entries(clip.images || {})) {
    let key = k;
    if (deck.images[key] && deck.images[key] !== v) { key = `${k}-${uid()}`; rename[k] = key; }
    deck.images[key] = v;
  }
  const now = Date.now();
  for (const c of clip.cards) {
    let { front, back } = c;
    for (const [from, to] of Object.entries(rename)) {
      const re = new RegExp(`\\]\\((img:)?${from}\\)`, 'g');
      front = front.replace(re, `](img:${to})`);
      back = back.replace(re, `](img:${to})`);
    }
    deck.cards.push({ id: uid(), front, back, created: now, updated: now });
  }
  await putDeck(deck);
  // Couper = déplacer : on retire les cartes du paquet d'origine
  if (clip.cut) {
    const src = await getDeck(clip.from);
    if (src) {
      src.cards = src.cards.filter(c => !clip.ids.includes(c.id));
      src.deletedCards ||= {};
      for (const id of clip.ids) src.deletedCards[id] = now;
      gcImages(src);
      await putDeck(src);
    }
    cardClipboard.set(null);
  }
  toast(`${plural(clip.cards.length, 'carte')} ${clip.cut ? 'déplacée' : 'collée'}${clip.cards.length > 1 ? 's' : ''} à la fin du paquet`);
  await renderDeck(deck.id);
  const last = $('#cards li:last-child');
  last?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- Réordonner les cartes par glisser-déposer (souris et tactile) ---------- */
function enableCardDrag(list) {
  list.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', e => startCardDrag(e, handle, list));
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const li = handle.closest('li');
      const other = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
      if (!other) return;
      e.key === 'ArrowUp' ? other.before(li) : other.after(li);
      handle.focus();
      saveCardOrder(list);
    });
  });
}

function startCardDrag(e, handle, list) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  const li = handle.closest('li');
  const rect = li.getBoundingClientRect();
  const offsetY = e.clientY - rect.top;
  const placeholder = document.createElement('li');
  placeholder.className = 'drag-placeholder';
  placeholder.style.height = rect.height + 'px';
  li.after(placeholder);
  Object.assign(li.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', zIndex: 30 });
  li.classList.add('dragging');
  try { handle.setPointerCapture(e.pointerId); } catch { /* capture indisponible : le suivi reste possible */ }
  let y = e.clientY, raf = 0;

  const place = () => {
    li.style.top = (y - offsetY) + 'px';
    const siblings = [...list.children].filter(x => x !== li && x !== placeholder);
    const before = siblings.find(x => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
    before ? before.before(placeholder) : list.append(placeholder);
  };
  // Défilement automatique près des bords de l'écran
  const tick = () => {
    const edge = 70;
    if (y < edge) scrollBy(0, -Math.ceil((edge - y) / 5));
    else if (y > innerHeight - edge) scrollBy(0, Math.ceil((y - innerHeight + edge) / 5));
    place();
    raf = requestAnimationFrame(tick);
  };
  const move = ev => { y = ev.clientY; place(); };
  const end = () => {
    cancelAnimationFrame(raf);
    place();
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    placeholder.replaceWith(li);
    li.removeAttribute('style');
    li.classList.remove('dragging');
    saveCardOrder(list);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  raf = requestAnimationFrame(tick);
}

async function saveCardOrder(list) {
  const deck = state.deck;
  const order = [...list.querySelectorAll('li[data-id]')].map(li => li.dataset.id);
  if (order.join() === deck.cards.map(c => c.id).join()) return;
  const pos = new Map(order.map((id, i) => [id, i]));
  deck.cards.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  await putDeck(deck);
}

/* ---------- Révision ----------
   Modes : 'due'    = révision espacée (on note chaque carte, progression enregistrée)
           'browse' = parcourir librement avec ← → / glissement, sans notation
   Options indépendantes (settings) : typing (taper sa réponse), reverse (sens inversé), shuffle */
async function startStudy(id, mode) {
  const deck = await getDeck(id);
  if (!deck) return go('#/');
  state.deck = deck;
  const base = { deckId: id, mode, flipped: false, typed: '', reverse: !!settings.reverse, typing: !!settings.typing };
  if (mode === 'browse') {
    const order = deck.cards.map(c => c.id);
    state.session = { ...base, order: settings.shuffle ? shuffle(order) : order, index: 0 };
  } else {
    const now = Date.now();
    const pool = deck.cards.filter(c => isDue(c, now));
    state.session = { ...base, queue: shuffle(pool.map(c => c.id)), total: pool.length, done: 0, again: 0 };
  }
  setHeader(deck.name, `#/deck/${id}`);
  renderStudy();
}

// Mots-clés d'une réponse (sans accents, sans mots courants) pour comparer avec la réponse tapée
const STOP_WORDS = new Set(('avec dans pour par sur sous entre sont leur leurs cette ceux celle elle elles ils mais donc ainsi plus moins '
  + 'tout tous toute toutes etre avoir fait font comme dont vers chez selon aussi tres meme autre autres quand alors sans lors elles '
  + 'deux trois quatre etc').split(' '));
const normWords = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function keywords(text) {
  const words = normWords(text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[*`#]/g, ' '));
  let kws = words.filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  if (!kws.length) kws = words.filter(w => w.length >= 2);
  return [...new Set(kws)];
}
function compareAnswer(typed, answer) {
  const kws = keywords(answer);
  const typedWords = normWords(typed);
  const has = kw => { const stem = kw.slice(0, Math.max(4, kw.length - 2)); return typedWords.some(w => w.startsWith(stem)); };
  const missed = kws.filter(k => !has(k));
  return { pct: kws.length ? Math.round((kws.length - missed.length) / kws.length * 100) : 0, missed };
}

function currentCard(s) {
  const id = s.mode === 'browse' ? s.order[s.index] : s.queue[0];
  return state.deck.cards.find(c => c.id === id);
}

function renderStudy(anim = '') {
  const s = state.session, deck = state.deck;
  const pending = s.mode === 'browse' ? s.order : s.queue;
  if (!pending.length || s.finished) return renderStudyEnd();
  const card = currentCard(s);
  if (!card) { // carte supprimée entre-temps
    if (s.mode === 'browse') { s.order.splice(s.index, 1); s.index = Math.max(0, Math.min(s.index, s.order.length - 1)); }
    else s.queue.shift();
    return renderStudy();
  }
  const [q, a] = s.reverse ? [card.back, card.front] : [card.front, card.back];
  const [pos, total] = s.mode === 'browse' ? [s.index + 1, s.order.length] : [s.done, s.total];
  const pct = total ? Math.round(pos / total * 100) : 0;
  const face = s.flipped
    ? `<div class="face-q md">${md(q, deck)}</div><div class="face md">${md(a, deck) || '<p class="muted">(vide)</p>'}</div>`
    : `<div class="face md">${md(q, deck)}</div>`;

  let typedBox = '';
  if (s.typing && s.flipped) {
    const cmp = s.typed.trim() ? compareAnswer(s.typed, a) : null;
    const level = !cmp ? '' : cmp.pct >= 70 ? 'hi' : cmp.pct >= 35 ? 'mid' : 'lo';
    typedBox = `<div class="typed">
      <div class="typed-head"><span>Ta réponse</span>${cmp ? `<span class="score ${level}">≈ ${cmp.pct} % des mots-clés</span>` : ''}</div>
      <div class="typed-text">${s.typed.trim() ? esc(s.typed).replace(/\n/g, '<br>') : '<i class="muted">(aucune réponse tapée)</i>'}</div>
      ${cmp && cmp.missed.length ? `<div class="missed">Manquants : ${cmp.missed.slice(0, 10).map(esc).join(', ')}${cmp.missed.length > 10 ? '…' : ''}</div>` : ''}
    </div>`;
  }
  const answerInput = s.typing && !s.flipped
    ? `<textarea id="answer" rows="3" enterkeyhint="done" placeholder="Tape ta réponse… (Entrée pour valider, Maj+Entrée pour aller à la ligne)">${esc(s.typed)}</textarea>`
    : '';

  let controls;
  if (s.mode === 'browse') {
    controls = `<div class="nav">
      <button class="btn" data-act="prev" ${s.index === 0 ? 'disabled' : ''} aria-label="Carte précédente">←<span class="lbl"> Précédente</span></button>
      <button class="btn primary" data-act="flip">${s.flipped ? 'Voir la question' : s.typing ? 'Vérifier' : 'Retourner'}</button>
      <button class="btn" data-act="next" aria-label="Carte suivante"><span class="lbl">${s.index === s.order.length - 1 ? 'Terminer' : 'Suivante'} </span>→</button>
    </div>`;
  } else if (s.flipped) {
    controls = `<div class="rate">${[[0, 'À revoir', 'again'], [1, 'Difficile', 'hard'], [2, 'Bien', 'good'], [3, 'Facile', 'easy']].map(([r, label, cls]) =>
      `<button class="btn rate-${cls}" data-act="rate" data-r="${r}"><span>${label}</span><small>${fmtInterval(card, r)}</small></button>`).join('')}</div>`;
  } else {
    controls = `<div class="study-cta"><button class="btn primary big wide" data-act="flip">${s.typing ? 'Vérifier ma réponse' : 'Voir la réponse'}</button></div>`;
  }

  app.innerHTML = `
    <div class="progress"><div style="width:${pct}%"></div></div>
    <p class="muted center study-info">${pos} / ${total} · ${s.mode === 'browse' ? 'Parcourir · sans notation' : 'Révision espacée'}</p>
    <div class="flashcard ${s.flipped ? 'is-back' : 'is-front'} ${anim}" id="fc" tabindex="0" data-act="flip" role="button" aria-label="Retourner la carte">
      ${face}
      <p class="flip-hint">${s.flipped ? 'Touchez pour revoir la question' : s.typing ? 'Réponds ci-dessous, ou touchez pour retourner' : 'Touchez pour retourner'}</p>
    </div>
    ${typedBox}${answerInput}${controls}
    ${s.mode === 'browse' ? '<p class="hint center keys-hint">Clavier : ← → pour naviguer · Espace pour retourner</p>' : ''}`;

  const input = $('#answer');
  if (input) {
    input.addEventListener('input', () => { s.typed = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); flip(); }
      else if (e.key === 'Escape') input.blur();
    });
    input.focus({ preventScroll: true });
  }
  if (s.mode === 'browse') enableSwipe($('#fc'));
}

// Glisser la carte vers la gauche / droite sur téléphone (mode Parcourir)
function enableSwipe(el) {
  let x0 = null, y0 = 0;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      state.session.swipeAt = Date.now(); // évite que le « clic » qui suit ne retourne la carte
      move(dx < 0 ? 1 : -1);
    }
  });
}

function move(delta) {
  const s = state.session;
  if (!s || s.mode !== 'browse') return;
  const i = s.index + delta;
  if (i < 0) return;
  if (i >= s.order.length) { s.finished = true; return renderStudy(); }
  Object.assign(s, { index: i, flipped: false, typed: '' });
  renderStudy(delta > 0 ? 'slide-next' : 'slide-prev');
}

function flip() {
  const s = state.session;
  if (!s || Date.now() - (s.swipeAt || 0) < 500) return;
  const input = $('#answer');
  if (input) s.typed = input.value;
  const el = $('#fc');
  if (el) el.classList.add('flip-out');
  setTimeout(() => { s.flipped = !s.flipped; renderStudy('flip-in'); }, 140);
}

async function rate(r) {
  const s = state.session, deck = state.deck;
  if (!s || !s.flipped) return;
  const id = s.queue.shift();
  const card = deck.cards.find(c => c.id === id);
  if (r === 0) { s.queue.splice(Math.min(s.queue.length, 3), 0, id); s.again++; }
  else s.done++;
  s.flipped = false;
  s.typed = '';
  renderStudy();
  if (s.mode === 'due' && card) {
    Object.assign(card, nextState(card, r));
    await putDeck(deck, 'progress');
  }
}

function renderStudyEnd() {
  const s = state.session;
  if (s.mode === 'browse') {
    app.innerHTML = `<div class="empty">
      <h2>${s.order.length ? 'Fin du paquet' : 'Aucune carte'}</h2>
      <p>${s.order.length ? `Tu as parcouru les ${plural(s.order.length, 'carte')}.` : 'Ce paquet ne contient pas encore de carte.'}</p>
      <div class="row">
        <a class="btn primary" href="#/deck/${s.deckId}">Retour au paquet</a>
        ${s.order.length ? '<button class="btn" data-act="restart-browse">Recommencer</button>' : ''}
      </div></div>`;
    return;
  }
  app.innerHTML = `<div class="empty">
    <h2>${s.total ? 'Session terminée' : 'Rien à réviser pour le moment'}</h2>
    <p>${s.total
      ? `${plural(s.total, 'carte')} revue${s.total > 1 ? 's' : ''}${s.again ? `, dont ${s.again} passage${s.again > 1 ? 's' : ''} en « À revoir »` : ''}.`
      : 'Toutes les cartes sont à jour. Reviens plus tard, ou parcours le paquet librement.'}</p>
    <div class="row">
      <a class="btn primary" href="#/deck/${s.deckId}">Retour au paquet</a>
      <button class="btn" data-act="restart-browse">Parcourir les cartes</button>
    </div></div>`;
}

/* =========================================================
   Fenêtres (modales)
   ========================================================= */
const modal = $('#modal');
function openModal(html) {
  modal.innerHTML = `<div class="modal-body">${html}</div>`;
  if (!modal.open) modal.showModal();
  return modal;
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

function openEditor(cardId) {
  const deck = state.deck;
  const card = cardId ? deck.cards.find(c => c.id === cardId) : null;
  if (!state.canEdit) { // paquet partagé en lecture seule : simple aperçu
    if (!card) return;
    openModal(`<div class="card-view"><div class="face-q md">${md(card.front, deck)}</div><div class="md">${md(card.back, deck)}</div></div>
      <div class="row end"><button class="btn" data-act="copy-one" data-id="${card.id}">${ICON.copy} Copier la carte</button><button class="btn ghost" data-act="close">Fermer</button></div>`);
    return;
  }
  const m = openModal(`
    <h2>${card ? 'Modifier la carte' : 'Nouvelle carte'}</h2>
    <div class="field"><span>Recto — théorie / concept</span>
      <textarea name="front" rows="2" placeholder="Ex. : Théorème de Pythagore">${esc(card?.front || '')}</textarea></div>
    <div class="field"><span>Verso — définition</span>
      <div class="md-tools">
        <button type="button" data-tool="bold"><b>G</b> gras</button>
        <button type="button" data-tool="italic"><i>I</i> italique</button>
        <button type="button" data-tool="list">• liste</button>
        <button type="button" data-tool="image">${ICON.image} Ajouter une image</button>
      </div>
      <textarea name="back" rows="8" placeholder="La définition… (tu peux coller une image avec Ctrl+V)">${esc(card?.back || '')}</textarea></div>
    <p class="hint">Images : bouton ci-dessus (galerie ou appareil photo sur téléphone), copier-coller ou glisser-déposer.</p>
    <details id="prev-wrap" open><summary>Aperçu</summary><div class="preview md" id="preview"></div></details>
    <input type="file" accept="image/*" multiple hidden id="img-input">
    <div class="row end">
      ${card ? `<button type="button" class="btn danger" data-ed="delete">Supprimer</button>
      <button type="button" class="btn ghost" data-act="copy-one" data-id="${card.id}">${ICON.copy} Copier</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-ed="cancel">Annuler</button>
      ${card ? '' : '<button type="button" class="btn" data-ed="save-new">Enregistrer + suivante</button>'}
      <button type="button" class="btn primary" data-ed="save">Enregistrer</button>
    </div>`);
  const front = $('[name=front]', m), back = $('[name=back]', m), preview = $('#preview', m), input = $('#img-input', m);
  const refresh = () => { preview.innerHTML = md(back.value, deck) || '<span class="muted">…</span>'; };
  refresh();
  back.addEventListener('input', refresh);
  (card ? back : front).focus();

  const insert = (before, after = '', placeholder = '') => {
    const { selectionStart: a, selectionEnd: b, value } = back;
    const sel = value.slice(a, b) || placeholder;
    back.value = value.slice(0, a) + before + sel + after + value.slice(b);
    back.focus();
    back.selectionStart = a + before.length;
    back.selectionEnd = a + before.length + sel.length;
    refresh();
  };
  const addImages = async files => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const key = 'img-' + uid();
        (deck.images ||= {})[key] = await compressImage(f);
        const pos = back.selectionStart;
        const prefix = pos > 0 && back.value[pos - 1] !== '\n' ? '\n' : '';
        insert(`${prefix}![](img:${key})\n`);
      } catch (e) { toast(e.message); }
    }
  };
  $('.md-tools', m).addEventListener('click', e => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    if (t === 'bold') insert('**', '**', 'texte');
    if (t === 'italic') insert('*', '*', 'texte');
    if (t === 'list') insert('\n- ', '', 'élément');
    if (t === 'image') input.click();
  });
  input.addEventListener('change', () => { addImages([...input.files]); input.value = ''; });
  back.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  back.addEventListener('dragover', e => e.preventDefault());
  back.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); addImages(files); }
  });

  const save = async again => {
    const f = front.value.trim(), b = back.value.trim();
    if (!f) { front.focus(); return toast('Le recto est vide'); }
    if (card) Object.assign(card, { front: f, back: b, updated: Date.now() });
    else deck.cards.push({ id: uid(), front: f, back: b, created: Date.now(), updated: Date.now() });
    gcImages(deck);
    await putDeck(deck);
    toast('Carte enregistrée');
    await renderDeck(deck.id);
    if (again) openEditor(); else closeModal();
  };
  m.querySelector('.row.end').addEventListener('click', async e => {
    const a = e.target.closest('[data-ed]')?.dataset.ed;
    if (a === 'cancel') closeModal();
    if (a === 'save') save(false);
    if (a === 'save-new') save(true);
    if (a === 'delete' && confirm('Supprimer cette carte ?')) {
      deck.cards = deck.cards.filter(c => c.id !== card.id);
      (deck.deletedCards ||= {})[card.id] = Date.now(); // pour propager la suppression aux autres appareils
      gcImages(deck);
      await putDeck(deck);
      closeModal();
      renderDeck(deck.id);
      toast('Carte supprimée');
    }
  });
  m.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(false); });
}

function openImport(intoId) {
  const m = openModal(`
    <h2>Importer des cartes</h2>
    <p class="hint">Choisis un fichier <b>.json</b> (généré par Claude, exporté, ou une sauvegarde), ou colle directement la réponse de Claude ci-dessous.</p>
    <div class="row"><button class="btn" id="pick">${ICON.import} Choisir un fichier…</button></div>
    <input type="file" id="file" accept=".json,.txt,.csv,.tsv,application/json,text/plain" multiple hidden>
    <textarea id="paste" rows="8" class="prompt-box" placeholder='{"deck": "Mon cours", "cards": [{"front": "…", "back": "…"}]}'></textarea>
    ${intoId ? `<label class="check"><input type="checkbox" id="into" checked> Ajouter au paquet « ${esc(state.deck?.name)} »</label>` : ''}
    <div class="row end">
      <button class="btn ghost" id="cancel">Annuler</button>
      <button class="btn primary" id="go">Importer le texte collé</button>
    </div>`);
  const target = () => ($('#into', m)?.checked ? intoId : null);
  const run = async text => {
    try { closeModal(); await importText(text, target()); }
    catch (e) { console.error(e); openImport(intoId); $('#paste').value = text; toast(e.message); }
  };
  $('#pick', m).onclick = () => $('#file', m).click();
  $('#file', m).onchange = async e => {
    const into = target();
    closeModal();
    for (const f of e.target.files) {
      try { await importText(await f.text(), into); }
      catch (err) { toast(`${f.name} : ${err.message}`); }
    }
  };
  $('#cancel', m).onclick = closeModal;
  $('#go', m).onclick = () => { const t = $('#paste', m).value.trim(); if (t) run(t); else toast('Rien à importer'); };
}

const CLAUDE_PROMPT = `Crée des flash cards de révision à partir du cours ci-dessous.

Règles :
- Une carte par notion importante (théorie, concept, définition, théorème, loi, formule, auteur, date clé…).
- "front" : le nom de la notion, court (quelques mots).
- "back" : la définition / explication, claire et fidèle au cours, 2 à 6 lignes. Mise en forme autorisée : **gras**, *italique*, listes avec "- ", retours à la ligne (\\n).
- Images (seulement si un schéma aide vraiment) : dessine un SVG simple dans "images" (clé → code SVG, avec des apostrophes ' pour les attributs, fond blanc, texte noir), puis insère-le dans la définition avec ![légende](img:clé).
- N'invente rien qui ne soit pas dans le cours.

Réponds UNIQUEMENT avec un bloc JSON valide, au format :
{
  "format": "flashcards-v1",
  "folder": "Nom du dossier (matière)",
  "deck": "Nom du paquet",
  "description": "Matière — chapitre",
  "cards": [
    { "front": "Notion", "back": "Définition…" }
  ],
  "images": {
    "schema1": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 200'>…</svg>"
  }
}

Voici mon cours :
`;

function openHelp() {
  const m = openModal(`
    <h2>Générer des cartes avec Claude</h2>
    <ol class="steps">
      <li>Copie la consigne ci-dessous.</li>
      <li>Dans Claude (appli, site ou Claude Code), colle-la, puis ajoute ton cours : texte, PDF, photos de tes notes…</li>
      <li>Copie le bloc JSON de la réponse (ou télécharge le fichier).</li>
      <li>Ici : <b>Importer</b> → colle le texte ou choisis le fichier.</li>
    </ol>
    <textarea readonly rows="10" class="prompt-box">${esc(CLAUDE_PROMPT)}</textarea>
    <div class="row end">
      <button class="btn ghost" id="close">Fermer</button>
      <button class="btn" id="imp">Importer…</button>
      <button class="btn primary" id="copy">Copier la consigne</button>
    </div>
    <p class="hint">Format texte simple aussi accepté : une carte par ligne, <code>terme :: définition</code>.</p>`);
  $('#copy', m).onclick = () => copyText(CLAUDE_PROMPT);
  $('#close', m).onclick = closeModal;
  $('#imp', m).onclick = () => openImport(state.deck?.id);
}

function openMenu() {
  openModal(`
    <h2>Menu</h2>
    <ul class="menu-list">
      <li><button class="btn" data-act="account">${ICON.user} ${me() ? 'Mon compte' : 'Se connecter / synchroniser'}</button></li>
      <li><button class="btn" data-act="new-folder">Nouveau dossier</button></li>
      <li><button class="btn" data-act="help">Générer des cartes avec Claude</button></li>
      <li><button class="btn" data-act="import">Importer un paquet</button></li>
      <li><button class="btn" data-act="backup">Sauvegarder tous mes dossiers et paquets</button></li>
      <li><button class="btn" data-act="import">Restaurer une sauvegarde</button></li>
    </ul>
    <p class="hint">${me()
      ? 'Tes cartes sont synchronisées avec ton compte. La sauvegarde reste utile comme copie de sécurité.'
      : 'Sans compte, tes cartes sont enregistrées uniquement sur cet appareil. Connecte-toi pour les retrouver sur ton PC et ton téléphone et les partager.'}</p>
    <div class="row end"><button class="btn ghost" data-act="close">Fermer</button></div>`);
}

function openDeckMenu() {
  const deck = state.deck;
  const edit = state.canEdit;
  openModal(`
    <h2>${esc(deck.name)}</h2>
    <ul class="menu-list">
      ${edit ? `<li><button class="btn" data-act="move-deck">Déplacer vers un dossier…</button></li>
      <li><button class="btn" data-act="import-into">Importer des cartes dans ce paquet</button></li>
      <li><button class="btn" data-act="help">Générer des cartes avec Claude</button></li>` : ''}
      <li><button class="btn" data-act="copy-deck">Copier dans mes paquets</button></li>
      <li><button class="btn" data-act="export-deck">Exporter le paquet (.json)</button></li>
      ${edit ? '<li><button class="btn" data-act="rename-deck">Renommer / modifier la description</button></li>' : ''}
      <li><button class="btn" data-act="reset-deck">Réinitialiser ma progression</button></li>
      ${edit ? '<li><button class="btn danger" data-act="delete-deck">Supprimer le paquet</button></li>' : ''}
    </ul>
    <div class="row end"><button class="btn ghost" data-act="close">Fermer</button></div>`);
}

async function openFolderMenu() {
  const folder = await getFolder(state.folderId);
  const isOwner = !folder.role || folder.role === 'owner';
  openModal(`
    <h2>${esc(folder.name)}</h2>
    ${isOwner ? '' : `<p class="hint">Dossier ${sharedLabel(folder)}.</p>`}
    <ul class="menu-list">
      ${folderCanWrite(folder) ? `<li><button class="btn" data-act="new-deck">Nouveau paquet dans ce dossier</button></li>
      <li><button class="btn" data-act="import">Importer un paquet dans ce dossier</button></li>` : ''}
      ${isOwner ? `<li><button class="btn" data-act="share-folder">${ICON.users} Partager avec des camarades…</button></li>
      <li><button class="btn" data-act="rename-folder">Renommer le dossier</button></li>
      <li><button class="btn danger" data-act="delete-folder">Supprimer le dossier</button></li>`
      : '<li><button class="btn danger" data-act="leave-folder">Quitter ce dossier partagé</button></li>'}
    </ul>
    <div class="row end"><button class="btn ghost" data-act="close">Fermer</button></div>`);
}

async function openMoveDeck() {
  const deck = state.deck;
  const folders = (await getFolders()).filter(folderCanWrite).sort(byName);
  openModal(`
    <h2>Déplacer « ${esc(deck.name)} »</h2>
    <ul class="menu-list">
      <li><button class="btn ${!deck.folderId ? 'current' : ''}" data-act="move-to" data-id="">Aucun dossier (accueil)</button></li>
      ${folders.map(f => `<li><button class="btn ${deck.folderId === f.id ? 'current' : ''}" data-act="move-to" data-id="${f.id}">${ICON.folder} ${esc(f.name)}</button></li>`).join('')}
      <li><button class="btn ghost" data-act="move-to-new">${ICON.plus} Nouveau dossier…</button></li>
    </ul>
    <div class="row end"><button class="btn ghost" data-act="close">Annuler</button></div>`);
}

/* =========================================================
   Actions (délégation des clics)
   ========================================================= */
const EXAMPLE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 160'><rect width='240' height='160' fill='#fff'/><polygon points='40,130 200,130 40,25' fill='#dde5f2' stroke='#14284b' stroke-width='3'/><rect x='40' y='115' width='15' height='15' fill='none' stroke='#14284b' stroke-width='2'/><g font-family='sans-serif' font-size='18' fill='#111'><text x='120' y='152' text-anchor='middle'>a</text><text x='22' y='84'>b</text><text x='128' y='70'>c</text></g></svg>`;

const actions = {
  close: closeModal,
  menu: openMenu,
  help: () => openHelp(),
  import: () => openImport(),
  'import-into': () => openImport(state.deck.id),
  backup: () => { closeModal(); exportBackup(); },
  async 'new-deck'() {
    closeModal();
    const name = prompt('Nom du paquet :')?.trim();
    if (!name) return;
    const deck = { id: uid(), name, description: '', folderId: state.folderId || null, created: Date.now(), images: {}, cards: [] };
    await putDeck(deck);
    go(`#/deck/${deck.id}`);
  },
  async 'new-folder'() {
    closeModal();
    const name = prompt('Nom du dossier (ex. : Théorie des organisations, Épreuve écrite 1…) :')?.trim();
    if (!name) return;
    const folder = { id: uid(), name, created: Date.now() };
    await putFolder(folder);
    go(`#/folder/${folder.id}`);
  },
  'folder-menu': openFolderMenu,
  async 'rename-folder'() {
    const folder = await getFolder(state.folderId);
    const name = prompt('Nom du dossier :', folder.name)?.trim();
    if (!name) return;
    folder.name = name;
    await putFolder(folder);
    closeModal();
    renderFolder(folder.id);
  },
  async 'delete-folder'() {
    const folder = await getFolder(state.folderId);
    const inside = (await getAll()).filter(d => d.folderId === folder.id);
    const msg = inside.length
      ? `Supprimer le dossier « ${folder.name} » ?\n\nSes ${plural(inside.length, 'paquet')} ne seront PAS supprimés : ils seront déplacés à l’accueil.`
      : `Supprimer le dossier vide « ${folder.name} » ?`;
    if (!confirm(msg)) return;
    for (const d of inside) {
      if (d.owner && d.owner !== me()?.id) { await delDeck(d.id); continue; } // paquet d'un camarade : il le garde chez lui
      d.folderId = null;
      await putDeck(d);
    }
    await delFolder(folder.id);
    if (folder.remote) queueDelete('folders', folder.id);
    closeModal();
    toast('Dossier supprimé');
    go('#/');
  },
  'move-deck': openMoveDeck,
  async 'move-to'(el) {
    const deck = state.deck;
    deck.folderId = el.dataset.id || null;
    await putDeck(deck);
    closeModal();
    toast(deck.folderId ? 'Paquet déplacé' : 'Paquet déplacé à l’accueil');
    renderDeck(deck.id);
  },
  async 'move-to-new'() {
    const name = prompt('Nom du nouveau dossier :')?.trim();
    if (!name) return;
    const deck = state.deck;
    deck.folderId = await folderByName(name);
    await putDeck(deck);
    closeModal();
    toast('Paquet déplacé');
    renderDeck(deck.id);
  },
  async example() {
    await importText(JSON.stringify({
      deck: 'Exemple', description: 'Un petit paquet pour découvrir l’appli',
      images: { triangle: EXAMPLE_SVG },
      cards: [
        { front: 'Théorème de Pythagore', back: 'Dans un triangle **rectangle**, le carré de l’hypoténuse est égal à la somme des carrés des deux autres côtés :\n\n**c² = a² + b²**\n\n![Triangle rectangle](img:triangle)' },
        { front: 'Photosynthèse', back: 'Processus par lequel les plantes produisent de la matière organique à partir de :\n- dioxyde de carbone (CO₂)\n- eau (H₂O)\n- énergie lumineuse\n\nElle libère du *dioxygène* (O₂).' },
        { front: 'Loi de l’offre et de la demande', back: 'Le prix d’un bien s’ajuste jusqu’à ce que la quantité **offerte** égale la quantité **demandée** (prix d’équilibre).' },
      ],
    }));
  },
  'new-card': () => openEditor(),
  'edit-card': el => openEditor(el.dataset.id),
  'select-start': () => { state.selection = new Set(); renderCardList(); },
  'select-cancel': () => { state.selection = null; renderCardList(); },
  'select-all': () => {
    const q = ($('#search')?.value || '').toLowerCase().trim();
    const visible = state.deck.cards.filter(c => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
    const all = visible.every(c => state.selection.has(c.id));
    visible.forEach(c => (all ? state.selection.delete(c.id) : state.selection.add(c.id)));
    renderCardList();
  },
  'toggle-card': el => {
    const s = state.selection;
    s.has(el.dataset.id) ? s.delete(el.dataset.id) : s.add(el.dataset.id);
    renderCardList();
  },
  'copy-cards': () => { copyToClipboard([...state.selection]); state.selection = null; renderCardList(); },
  'cut-cards': () => { copyToClipboard([...state.selection], true); state.selection = null; renderCardList(); },
  'paste-cards': () => pasteCards(),
  'clear-clipboard': () => { cardClipboard.set(null); renderCardTools(); toast('Presse-papiers vidé'); },
  'copy-one': el => { copyToClipboard([el.dataset.id]); closeModal(); renderCardTools(); },
  'deck-menu': openDeckMenu,
  'export-deck': () => { closeModal(); exportDeck(state.deck); },
  async 'rename-deck'() {
    const deck = state.deck;
    const name = prompt('Nom du paquet :', deck.name)?.trim();
    if (!name) return;
    const description = prompt('Description (facultatif) :', deck.description || '');
    Object.assign(deck, { name, description: (description ?? deck.description ?? '').trim() });
    await putDeck(deck);
    closeModal();
    renderDeck(deck.id);
  },
  async 'reset-deck'() {
    const deck = state.deck;
    if (!confirm('Remettre toutes les cartes à zéro (comme jamais vues) ?')) return;
    const now = Date.now();
    for (const c of deck.cards) {
      for (const k of ['due', 'interval', 'ease', 'reps', 'lapses']) delete c[k];
      c.rev = now; // la remise à zéro se propage aux autres appareils
    }
    await putDeck(deck, 'progress');
    closeModal();
    renderDeck(deck.id);
  },
  async 'delete-deck'() {
    const deck = state.deck;
    if (!confirm(`Supprimer définitivement « ${deck.name} » et ses ${deck.cards.length} cartes ?\n\nConseil : exporte-le d’abord si tu veux le garder.`)) return;
    await delDeck(deck.id);
    if (deck.remoteAt) queueDelete('decks', deck.id);
    closeModal();
    toast('Paquet supprimé');
    go(state.folderId ? `#/folder/${state.folderId}` : '#/');
  },
  async 'copy-deck'() {
    const src = state.deck;
    const now = Date.now();
    const deck = {
      id: uid(), name: `${src.name} (copie)`, description: src.description || '', folderId: null, created: now,
      images: { ...(src.images || {}) },
      cards: src.cards.map(c => ({ id: uid(), front: c.front, back: c.back, created: now, updated: now })),
    };
    await putDeck(deck);
    closeModal();
    toast('Copie créée dans tes paquets');
    go(`#/deck/${deck.id}`);
  },
  account: () => openAccount(),
  'share-folder': () => openShare(state.folderId),
  'leave-folder': () => leaveFolder(state.folderId),
  flip,
  rate: el => rate(+el.dataset.r),
  'restart-browse': () => startStudy(state.session.deckId, 'browse'),
  prev: () => move(-1),
  next: () => move(1),
};

document.addEventListener('click', e => {
  const img = e.target.closest('.flashcard img, .preview img');
  if (img) {
    const lb = $('#lightbox');
    $('img', lb).src = img.src;
    lb.hidden = false;
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
$('#lightbox').addEventListener('click', e => { e.currentTarget.hidden = true; });

document.addEventListener('keydown', e => {
  if (!state.session || !location.hash.startsWith('#/study') || modal.open) return;
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (!$('#lightbox').hidden) { if (e.key === 'Escape') $('#lightbox').hidden = true; return; }
  const s = state.session;
  if (e.key === ' ' || e.key === 'Enter') {
    if (/^(BUTTON|A)$/.test(e.target.tagName)) return; // le bouton focalisé gère déjà la touche
    e.preventDefault(); flip();
  }
  else if (s.mode === 'browse' && e.key === 'ArrowRight') { e.preventDefault(); move(1); }
  else if (s.mode === 'browse' && e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
  else if (s.mode === 'due' && s.flipped && /^[1-4]$/.test(e.key)) rate(+e.key - 1);
});

/* =========================================================
   Routeur (#/, #/folder/ID, #/deck/ID, #/study/ID/due|browse)
   ========================================================= */
async function route() {
  closeModal();
  $('#lightbox').hidden = true;
  const [, view, id, mode] = (location.hash.slice(1) || '/').split('/');
  try {
    if (view === 'deck' && id) { state.session = null; return await renderDeck(id); }
    if (view === 'folder' && id) { state.session = null; return await renderFolder(id); }
    if (view === 'study' && id) return await startStudy(id, mode === 'browse' || mode === 'all' ? 'browse' : 'due');
    state.session = null;
    await renderHome();
  } catch (e) {
    console.error(e);
    toast('Erreur : ' + e.message);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
$('#account').onclick = () => openAccount();
renderAccountButton();
// Retour d'un lien de connexion éventuel, puis affichage, puis synchronisation
handleAuthRedirect().finally(() => { route(); if (me()) sync(); });

// Hors connexion + installation (nécessite http/https, pas file://)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // Une nouvelle version vient d'être installée : proposer de recharger
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || $('.update-banner')) return;
    const b = document.createElement('div');
    b.className = 'update-banner';
    b.innerHTML = 'Nouvelle version de l’appli disponible <button class="btn primary">Recharger</button>';
    b.querySelector('button').onclick = () => location.reload();
    document.body.append(b);
  });
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker :', err));
}
// Demande au navigateur de ne pas effacer les données en cas de manque de place
navigator.storage?.persist?.().catch(() => {});
