'use strict';

/* =========================================================
   Comptes, synchronisation et partage (Supabase)
   Les données vivent d'abord sur l'appareil (IndexedDB). Une fois connecté,
   elles sont synchronisées avec le serveur ; les dossiers peuvent être partagés.
   Chargé avant app.js : les fonctions d'app.js (getAll, putDeck…) ne sont
   appelées qu'à l'exécution.
   ========================================================= */
const SB_URL = 'https://vfuuwhosxbksczdhswwd.supabase.co';
const SB_KEY = 'sb_publishable_sXbLO-T44PVkoIldUdcqSw_wIyJkViJ'; // clé publique (faite pour être dans l'appli)

const auth = { session: null, refreshing: null };
try { auth.session = JSON.parse(localStorage.getItem('fa-session')); } catch { /* pas de session */ }
const me = () => auth.session?.user || null;

function saveSession(s) {
  auth.session = s;
  try { s ? localStorage.setItem('fa-session', JSON.stringify(s)) : localStorage.removeItem('fa-session'); } catch { /* stockage indisponible */ }
  renderAccountButton();
}

async function sbRequest(path, { method = 'GET', body, prefer, token } = {}) {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(SB_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
  if (!res.ok) {
    const e = new Error(json?.msg || json?.message || json?.error_description || json?.error || `Erreur ${res.status}`);
    e.status = res.status;
    e.code = json?.code || json?.error_code;
    throw e;
  }
  return json;
}

function sessionFrom(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ? data.expires_at * 1000 : Date.now() + (data.expires_in || 3600) * 1000,
    user: { id: data.user.id, email: (data.user.email || '').toLowerCase() },
  };
}

async function accessToken() {
  const s = auth.session;
  if (!s) return null;
  if (Date.now() < s.expires_at - 60e3) return s.access_token;
  auth.refreshing ||= sbRequest('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })
    .then(data => saveSession(sessionFrom(data)))
    .catch(e => {
      if (e.status >= 400 && e.status < 500) { saveSession(null); toast('Session expirée : reconnecte-toi.'); }
      throw e;
    })
    .finally(() => { auth.refreshing = null; });
  await auth.refreshing;
  return auth.session?.access_token || null;
}
const api = async (path, opts = {}) => sbRequest(path, { ...opts, token: await accessToken() });
const q = v => encodeURIComponent(v);

/* ---------- Connexion par e-mail (code à 6 chiffres ou lien magique) ---------- */
async function sendLoginCode(email) {
  const redirect = location.protocol.startsWith('http') ? `?redirect_to=${q(location.origin + location.pathname)}` : '';
  await sbRequest(`/auth/v1/otp${redirect}`, { method: 'POST', body: { email, create_user: true } });
}
async function verifyLoginCode(email, token) {
  const data = await sbRequest('/auth/v1/verify', { method: 'POST', body: { type: 'email', email, token } });
  await onLogin(sessionFrom(data));
}
// Retour depuis le lien magique : #access_token=…&refresh_token=…
async function handleAuthRedirect() {
  const h = location.hash;
  if (!/[#&](access_token|error)=/.test(h)) return;
  const p = new URLSearchParams(h.slice(1));
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (p.get('error')) { toast('Connexion impossible : ' + (p.get('error_description') || p.get('error')).replace(/\+/g, ' ')); return; }
  try {
    const token = p.get('access_token');
    const user = await sbRequest('/auth/v1/user', { token });
    await onLogin(sessionFrom({
      access_token: token, refresh_token: p.get('refresh_token'),
      expires_at: +p.get('expires_at') || 0, expires_in: +p.get('expires_in') || 3600, user,
    }));
  } catch (e) { toast('Connexion impossible : ' + e.message); }
}
async function onLogin(session) {
  saveSession(session);
  toast(`Connecté : ${session.user.email}`);
  await sync();
}
async function logout() {
  await sync();
  const pendingWork = (await getAll()).some(d => d.dirty || d.progressDirty) || pendingDeletes.get().length;
  if (pendingWork && !confirm('Certaines modifications n’ont pas pu être envoyées (pas de connexion ?). Elles seront perdues si tu te déconnectes maintenant.\n\nSe déconnecter quand même ?')) return;
  api('/auth/v1/logout', { method: 'POST' }).catch(() => {});
  saveSession(null);
  await clearLocalData();
  pendingDeletes.set([]);
  toast('Déconnecté. Tes cartes restent dans ton compte.');
  go('#/');
}
async function clearLocalData() {
  await tx(STORE, 'readwrite', s => s.clear());
  await tx(FOLDERS, 'readwrite', s => s.clear());
}

/* ---------- Droits ---------- */
function folderCanWrite(folder) { return !folder || !folder.role || folder.role === 'owner' || folder.role === 'write'; }
function canEditDeck(deck, folder) {
  const u = me();
  if (!u || !deck.owner || deck.owner === u.id) return true;
  return !!folder && (folder.role === 'owner' || folder.role === 'write');
}

/* ---------- File d'attente des suppressions (hors connexion) ---------- */
const pendingDeletes = {
  get() { try { return JSON.parse(localStorage.getItem('fa-deletes')) || []; } catch { return []; } },
  set(v) { try { localStorage.setItem('fa-deletes', JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
function queueDelete(table, id) {
  if (!me()) return;
  pendingDeletes.set([...pendingDeletes.get(), { table, id }]);
  scheduleSync(300);
}

/* ---------- Fusion paquet local / paquet du serveur ---------- */
const PROGRESS_KEYS = ['due', 'interval', 'ease', 'reps', 'lapses', 'rev'];
const stampOf = c => c.updated || c.created || 0;
function progressFields(c) {
  const out = {};
  for (const k of PROGRESS_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}
function applyProgress(card, p) {
  for (const k of PROGRESS_KEYS) delete card[k];
  Object.assign(card, p);
}
function progressOf(deck) {
  const out = {};
  for (const c of deck.cards) { const p = progressFields(c); if (Object.keys(p).length) out[c.id] = p; }
  return out;
}
function deckPayload(d) {
  return {
    id: d.id, folder_id: d.folderId || null, updated_at: d.editedAt || d.updated || Date.now(),
    data: {
      name: d.name, description: d.description || '', images: d.images || {},
      editedAt: d.editedAt || 0, deletedCards: d.deletedCards || {},
      cards: d.cards.map(({ id, front, back, created, updated }) => ({ id, front, back, created, updated })),
    },
  };
}
// Fusion carte par carte : la version la plus récente de chaque carte gagne, la progression locale est conservée
function mergeDeck(local, row) {
  const r = row.data || {};
  const base = local || { id: row.id, created: Date.now(), cards: [], images: {} };
  const out = { ...base, owner: row.owner, remoteAt: row.synced_at };
  if (!local || !local.dirty || (r.editedAt || 0) >= (local.editedAt || 0)) {
    Object.assign(out, { name: r.name, description: r.description || '', folderId: row.folder_id, editedAt: Math.max(r.editedAt || 0, local?.editedAt || 0) });
  }
  out.images = { ...(r.images || {}), ...(base.images || {}) };
  const tomb = { ...(r.deletedCards || {}) };
  for (const [k, v] of Object.entries(base.deletedCards || {})) tomb[k] = Math.max(tomb[k] || 0, v);
  const cards = new Map();
  for (const c of r.cards || []) cards.set(c.id, { ...c });
  for (const c of base.cards) {
    const rc = cards.get(c.id);
    if (!rc) { if (local?.dirty || !local?.remoteAt) cards.set(c.id, c); continue; }
    cards.set(c.id, { ...(stampOf(c) > stampOf(rc) ? c : rc), ...progressFields(c) });
  }
  out.cards = [...cards.values()].filter(c => !(tomb[c.id] >= stampOf(c)));
  out.deletedCards = tomb;
  gcImages(out);
  return out;
}
async function updateDeckRaw(id, fn) {
  const d = await getDeck(id);
  if (!d) return;
  if (fn(d) !== false) await putDeck(d, 'raw');
}

/* ---------- Synchronisation ---------- */
const syncState = { running: false, again: false, status: 'idle', last: 0, error: '', timer: null };
function setSyncStatus(status, error = '') {
  Object.assign(syncState, { status, error });
  renderAccountButton();
}
function scheduleSync(delay = 2000) {
  if (!me()) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(sync, delay);
}

async function sync() {
  const user = me();
  if (!user) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (syncState.running) { syncState.again = true; return; }
  syncState.running = true;
  setSyncStatus('syncing');
  let changed = false;
  const errors = [];
  try {
    // 1. Suppressions faites hors connexion
    for (const d of pendingDeletes.get()) {
      try { await api(`/rest/v1/${d.table}?id=eq.${q(d.id)}`, { method: 'DELETE' }); }
      catch (e) { if (e.status !== 404) errors.push(e.message); }
      pendingDeletes.set(pendingDeletes.get().filter(x => !(x.table === d.table && x.id === d.id)));
    }

    // 2. Dossiers et membres
    const [rFolders, members] = await Promise.all([api('/rest/v1/folders?select=*'), api('/rest/v1/folder_members?select=*')]);
    const remoteFolders = new Map(rFolders.map(f => [f.id, f]));
    for (const lf of await getFolders()) {
      if (remoteFolders.has(lf.id)) continue;
      if (lf.remote) { await delFolder(lf.id); changed = true; continue; } // supprimé ailleurs, ou accès retiré
      try {
        const [row] = await api('/rest/v1/folders', { method: 'POST', prefer: 'return=representation', body: { id: lf.id, name: lf.name, updated_at: lf.updated || Date.now() } });
        remoteFolders.set(row.id, row);
      } catch (e) { errors.push(e.message); }
    }
    const localFolders = new Map((await getFolders()).map(f => [f.id, f]));
    for (const r of remoteFolders.values()) {
      const lf = localFolders.get(r.id);
      const role = r.owner === user.id ? 'owner' : (members.find(m => m.folder_id === r.id && m.email === user.email)?.role || 'read');
      let name = r.name;
      if (lf?.dirty && role === 'owner' && (lf.updated || 0) > r.updated_at) {
        await api(`/rest/v1/folders?id=eq.${q(r.id)}`, { method: 'PATCH', body: { name: lf.name, updated_at: lf.updated } });
        name = lf.name;
      }
      const folderMembers = members.filter(m => m.folder_id === r.id).map(m => ({ email: m.email, role: m.role }));
      const next = {
        ...(lf || { created: Date.now() }), id: r.id, name, role, owner: r.owner, ownerEmail: r.owner_email,
        members: folderMembers, remote: true, dirty: false, updated: Math.max(r.updated_at, lf?.updated || 0),
      };
      if (!lf || lf.name !== next.name || lf.role !== role || JSON.stringify(lf.members) !== JSON.stringify(folderMembers)) changed = true;
      await putFolder(next, true);
    }
    const folders = new Map((await getFolders()).map(f => [f.id, f]));

    // 3. Paquets : récupérer ceux qui ont changé sur le serveur
    const rList = await api('/rest/v1/decks?select=id,synced_at');
    const remoteAt = new Map(rList.map(d => [d.id, d.synced_at]));
    const locals = new Map((await getAll()).map(d => [d.id, d]));
    const toFetch = rList.filter(r => locals.get(r.id)?.remoteAt !== r.synced_at).map(r => r.id);
    for (let i = 0; i < toFetch.length; i += 20) {
      const rows = await api(`/rest/v1/decks?select=*&id=in.(${toFetch.slice(i, i + 20).map(q).join(',')})`);
      for (const row of rows) {
        await putDeck(mergeDeck(await getDeck(row.id), row), 'raw');
        changed = true;
      }
    }
    for (const d of locals.values()) {
      if (!remoteAt.has(d.id) && d.remoteAt) { await delDeck(d.id); changed = true; } // supprimé ailleurs, ou accès retiré
    }

    // 4. Paquets : envoyer les modifications locales
    for (const d of await getAll()) {
      if (!d.dirty && d.remoteAt) continue;
      const folder = d.folderId ? folders.get(d.folderId) : null;
      if (!canEditDeck(d, folder)) { await updateDeckRaw(d.id, x => { x.dirty = false; }); continue; }
      if (d.folderId && (!folder || !folderCanWrite(folder))) d.folderId = null;
      try {
        const [row] = await api('/rest/v1/decks?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: deckPayload(d) });
        await updateDeckRaw(d.id, x => {
          x.remoteAt = row.synced_at;
          x.owner = row.owner;
          if (x.updated === d.updated) x.dirty = false; // sinon : modifié pendant l'envoi, on renverra
        });
      } catch (e) { errors.push(`« ${d.name} » : ${e.message}`); }
    }

    // 5. Progression personnelle (carte par carte : la révision la plus récente gagne)
    const rProg = new Map((await api('/rest/v1/progress?select=deck_id,data')).map(p => [p.deck_id, p.data || {}]));
    for (const d of await getAll()) {
      if (!d.remoteAt) continue;
      const rp = rProg.get(d.id);
      let needPush = !!d.progressDirty, pulled = false;
      await updateDeckRaw(d.id, x => {
        for (const c of x.cards) {
          const rs = rp?.[c.id];
          const lr = c.rev || 0;
          if (rs && (rs.rev || 0) > lr) { applyProgress(c, rs); pulled = true; }
          else if ((!rs && (c.rev || c.reps)) || (rs && lr > (rs.rev || 0))) needPush = true;
        }
        x.progressDirty = false;
        return pulled || d.progressDirty;
      });
      if (pulled) changed = true;
      if (needPush) {
        const cur = await getDeck(d.id);
        try {
          await api('/rest/v1/progress?on_conflict=user_id,deck_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { deck_id: d.id, data: progressOf(cur), updated_at: Date.now() } });
        } catch (e) { errors.push(e.message); await updateDeckRaw(d.id, x => { x.progressDirty = true; }); }
      }
    }

    syncState.last = Date.now();
    setSyncStatus(errors.length ? 'error' : 'ok', errors.join(' · '));
  } catch (e) {
    console.error(e);
    setSyncStatus(navigator.onLine ? 'error' : 'offline', e.message);
  } finally {
    syncState.running = false;
    if (changed) refreshView();
    if (syncState.again) { syncState.again = false; scheduleSync(300); }
  }
}

// Réaffiche l'écran après une synchronisation (sauf pendant une révision ou une saisie)
function refreshView() {
  if (modal.open || location.hash.startsWith('#/study')) return;
  const y = scrollY;
  route().then(() => scrollTo(0, y));
}

/* ---------- Bouton « Compte » dans l'en-tête ---------- */
function renderAccountButton() {
  const b = document.getElementById('account');
  if (!b) return;
  const u = me();
  const s = !u ? 'none' : syncState.status;
  b.dataset.status = s;
  b.title = !u ? 'Se connecter'
    : s === 'syncing' ? 'Synchronisation…'
    : s === 'offline' ? 'Hors connexion : les modifications seront envoyées plus tard'
    : s === 'error' ? 'Erreur de synchronisation'
    : `Connecté : ${u.email}`;
}

function openAccount() {
  const u = me();
  if (u) {
    const s = syncState;
    const status = s.status === 'syncing' ? 'Synchronisation en cours…'
      : s.status === 'offline' ? 'Hors connexion : tes modifications seront envoyées au retour du réseau.'
      : s.status === 'error' ? `Erreur de synchronisation : ${esc(s.error)}`
      : s.last ? `Synchronisé à ${new Date(s.last).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : 'Pas encore synchronisé.';
    const m = openModal(`
      <h2>Mon compte</h2>
      <p>Connecté avec <b>${esc(u.email)}</b></p>
      <p class="hint sync-line" data-status="${s.status}">${status}</p>
      <p class="hint">Tes dossiers, paquets et ta progression sont enregistrés dans ton compte et synchronisés sur tous tes appareils. Tu peux partager un dossier depuis son menu ⋯.</p>
      <div class="row end">
        <button class="btn danger" id="logout">Se déconnecter</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-act="close">Fermer</button>
        <button class="btn primary" id="sync-now">Synchroniser</button>
      </div>`);
    $('#sync-now', m).onclick = async () => { await sync(); openAccount(); };
    $('#logout', m).onclick = () => { closeModal(); logout(); };
    return;
  }
  const m = openModal(`
    <h2>Se connecter</h2>
    <p class="hint">Avec un compte, tes cartes sont synchronisées entre ton PC et ton téléphone, et tu peux partager des dossiers avec tes camarades. Pas de mot de passe : tu reçois un code par e-mail.</p>
    <div id="step-email">
      <label class="field"><span>Adresse e-mail</span><input type="email" id="login-email" autocomplete="email" placeholder="prenom.nom@exemple.fr"></label>
      <p class="hint">Les paquets déjà présents sur cet appareil seront ajoutés à ton compte.</p>
      <div class="row end"><button class="btn ghost" data-act="close">Annuler</button><button class="btn primary" id="send-code">Recevoir un code</button></div>
    </div>
    <div id="step-code" hidden>
      <p>Un e-mail a été envoyé à <b id="sent-to"></b>. Saisis le code qu’il contient, ou clique sur le lien depuis cet appareil.</p>
      <label class="field"><span>Code reçu par e-mail</span><input type="text" id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></label>
      <div class="row end"><button class="btn ghost" id="change-email">Changer d’adresse</button><button class="btn primary" id="verify-code">Valider</button></div>
    </div>`);
  const email = $('#login-email', m), code = $('#login-code', m);
  const send = async () => {
    const v = email.value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(v)) { email.focus(); return toast('Adresse e-mail invalide'); }
    const btn = $('#send-code', m);
    btn.disabled = true;
    try {
      await sendLoginCode(v);
      $('#sent-to', m).textContent = v;
      $('#step-email', m).hidden = true;
      $('#step-code', m).hidden = false;
      code.focus();
    } catch (e) {
      toast(e.status === 429 ? 'Trop de demandes : attends quelques minutes avant de redemander un code.' : 'Envoi impossible : ' + e.message);
    } finally { btn.disabled = false; }
  };
  const verify = async () => {
    const t = code.value.replace(/\s/g, '');
    if (!t) return code.focus();
    const btn = $('#verify-code', m);
    btn.disabled = true;
    try { await verifyLoginCode(email.value.trim().toLowerCase(), t); closeModal(); }
    catch (e) { toast('Code refusé : ' + (e.status === 403 ? 'code incorrect ou expiré' : e.message)); }
    finally { btn.disabled = false; }
  };
  $('#send-code', m).onclick = send;
  $('#verify-code', m).onclick = verify;
  $('#change-email', m).onclick = () => { $('#step-email', m).hidden = false; $('#step-code', m).hidden = true; };
  email.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  code.addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
  email.focus();
}

/* ---------- Partage d'un dossier ---------- */
async function openShare(folderId) {
  let folder = await getFolder(folderId);
  if (!me()) {
    const m = openModal(`<h2>Partager « ${esc(folder.name)} »</h2>
      <p>Pour partager un dossier, connecte-toi d’abord : tes camarades pourront alors y accéder avec leur propre compte.</p>
      <div class="row end"><button class="btn ghost" data-act="close">Annuler</button><button class="btn primary" id="go-login">Se connecter</button></div>`);
    $('#go-login', m).onclick = openAccount;
    return;
  }
  if (!folder.remote) { await sync(); folder = await getFolder(folderId); }
  if (!folder?.remote) return toast('Le dossier n’a pas encore pu être envoyé au serveur (connexion ?)');
  const roleLabel = { read: 'Lecture seule', write: 'Peut modifier' };
  const members = folder.members || [];
  const m = openModal(`
    <h2>Partager « ${esc(folder.name)} »</h2>
    <p class="hint">Invite tes camarades avec leur adresse e-mail. Ils se connectent à Flash’Agreg avec cette adresse, et le dossier apparaît automatiquement chez eux. Chacun garde sa propre progression.</p>
    <ul class="members">${members.length ? members.map(x => `
      <li><span class="member-email">${esc(x.email)}</span>
        <select data-email="${esc(x.email)}" aria-label="Droits de ${esc(x.email)}">
          ${Object.entries(roleLabel).map(([v, l]) => `<option value="${v}" ${x.role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="icon-btn" data-remove="${esc(x.email)}" aria-label="Retirer ${esc(x.email)}" title="Retirer">×</button></li>`).join('')
      : '<li class="muted">Ce dossier n’est partagé avec personne pour l’instant.</li>'}</ul>
    <div class="invite">
      <input type="email" id="invite-email" placeholder="adresse e-mail du camarade" autocomplete="off">
      <select id="invite-role"><option value="read">Lecture seule</option><option value="write">Peut modifier</option></select>
      <button class="btn primary" id="invite">Inviter</button>
    </div>
    <p class="hint"><b>Lecture seule</b> : révise les cartes sans pouvoir les modifier. <b>Peut modifier</b> : ajoute, corrige et crée des paquets dans ce dossier.</p>
    <div class="row end">
      ${location.protocol.startsWith('http') ? '<button class="btn" id="copy-link">Copier le lien de l’appli</button>' : ''}
      <button class="btn ghost" data-act="close">Fermer</button>
    </div>`);
  const refresh = async () => { await sync(); openShare(folderId); };
  const run = async fn => { try { await fn(); await refresh(); } catch (e) { toast('Erreur : ' + e.message); } };
  $('#invite', m).onclick = () => {
    const email = $('#invite-email', m).value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Adresse e-mail invalide');
    if (email === me().email) return toast('C’est ton adresse !');
    run(() => api('/rest/v1/folder_members', { method: 'POST', body: { folder_id: folderId, email, role: $('#invite-role', m).value } }));
  };
  m.querySelectorAll('select[data-email]').forEach(sel => {
    sel.onchange = () => run(() => api(`/rest/v1/folder_members?folder_id=eq.${q(folderId)}&email=eq.${q(sel.dataset.email)}`, { method: 'PATCH', body: { role: sel.value } }));
  });
  m.querySelectorAll('[data-remove]').forEach(b => {
    b.onclick = () => { if (confirm(`Retirer l’accès de ${b.dataset.remove} ?`)) run(() => api(`/rest/v1/folder_members?folder_id=eq.${q(folderId)}&email=eq.${q(b.dataset.remove)}`, { method: 'DELETE' })); };
  });
  $('#copy-link', m)?.addEventListener('click', () => copyText(location.origin + location.pathname));
}

async function leaveFolder(folderId) {
  const folder = await getFolder(folderId);
  if (!confirm(`Quitter le dossier partagé « ${folder.name} » ?\n\nTu n’y auras plus accès (sauf nouvelle invitation).`)) return;
  try {
    await api(`/rest/v1/folder_members?folder_id=eq.${q(folderId)}&email=eq.${q(me().email)}`, { method: 'DELETE' });
    closeModal();
    await sync();
    go('#/');
  } catch (e) { toast('Erreur : ' + e.message); }
}

/* ---------- Déclencheurs de synchronisation ---------- */
window.addEventListener('online', () => scheduleSync(500));
window.addEventListener('offline', () => { if (me()) setSyncStatus('offline'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - syncState.last > 60e3) scheduleSync(500);
});
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 5 * 60e3);
