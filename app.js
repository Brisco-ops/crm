import * as db from './db.js';
import * as G from './google.js';
import { merge } from './sync.js';

const STATUTS = ['Nouveau', 'Contacté', 'RDV planifié', 'Proposition envoyée', 'Gagné', 'Perdu'];
const CANAUX = ['WhatsApp', 'Google Meet', 'Appel', 'Email', 'En personne'];
const isOpen = s => s !== 'Gagné' && s !== 'Perdu';
const badgeClass = s => 'b-' + s.split(' ')[0];

const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const euro = n => (Number(n) || 0).toLocaleString('fr-FR') + ' €';

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const toStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toStr(new Date());
const addDays = (n, from = new Date()) => { const d = new Date(from); d.setDate(d.getDate() + n); return toStr(d); };
const diff = s => Math.round((new Date(s + 'T00:00') - new Date(today() + 'T00:00')) / 864e5);
const fmt = s => new Date(s + 'T00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
function dueLabel(s) {
  const d = diff(s);
  if (d < 0) return `<span class="late">En retard de ${-d} j</span>`;
  if (d === 0) return '<span class="soon">Aujourd\'hui</span>';
  if (d === 1) return '<span class="soon">Demain</span>';
  return fmt(s);
}

// ---------- état ----------
const S = { contacts: [], tasks: [], notes: [], docs: [], tombs: [] };
const ui = { q: '', status: '' };
const byId = (k, id) => S[k].find(x => x.id === id);

async function load() { for (const k of Object.keys(S)) S[k] = await db.all(k); }
async function save(store, obj) {
  obj.updatedAt = Date.now();
  await db.put(store, obj);
  const i = S[store].findIndex(x => x.id === obj.id);
  i >= 0 ? (S[store][i] = obj) : S[store].push(obj);
  scheduleSync();
}
async function remove(store, id) {
  await db.del(store, id);
  S[store] = S[store].filter(x => x.id !== id);
  const tomb = { id, store, at: Date.now() };
  await db.put('tombs', tomb);
  S.tombs.push(tomb);
  scheduleSync();
}
async function removeContact(id) {
  for (const k of ['tasks', 'notes', 'docs']) for (const x of S[k].filter(x => x.contactId === id)) await remove(k, x.id);
  await remove('contacts', id);
}

// ---------- liens ----------
const cc = () => localStorage.getItem('cc') || '33';
function waNumber(p) {
  if (!p) return '';
  const plus = p.trim().startsWith('+');
  let d = p.replace(/\(0\)/g, '').replace(/\D/g, ''); // ignore le (0) de « +33 (0)6… »
  if (plus) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return cc() + d.slice(1);
  return d;
}
const waLink = p => (waNumber(p) ? `https://wa.me/${waNumber(p)}` : '');
function calLink(t, c) {
  const start = t.due.replaceAll('-', '');
  const end = addDays(1, new Date(t.due + 'T00:00')).replaceAll('-', '');
  const text = encodeURIComponent(`${t.text} — ${c ? c.name : ''}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${start}/${end}`;
}

// ---------- formulaires (dialog) ----------
function field(f, v) {
  const val = v ?? f.default ?? '';
  const req = f.required ? 'required' : '';
  if (f.type === 'select') return `<label>${f.label}<select name="${f.name}">${f.options.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  if (f.type === 'textarea') return `<label>${f.label}<textarea name="${f.name}" rows="${f.rows || 3}" ${req}>${esc(val)}</textarea></label>`;
  return `<label>${f.label}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" ${req} ${f.type === 'tel' ? 'inputmode="tel"' : ''}></label>`;
}
function openForm({ title, fields, values = {}, onSave, onDelete }) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form><h3>${esc(title)}</h3>${fields.map(f => field(f, values[f.name])).join('')}
    <div class="actions">${onDelete ? '<button type="button" class="btn d" data-del>Supprimer</button>' : ''}<span class="grow"></span>
    <button type="button" class="btn" data-cancel>Annuler</button><button class="btn p">Enregistrer</button></div></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = close;
  d.addEventListener('cancel', () => setTimeout(() => d.remove()));
  if (onDelete) d.querySelector('[data-del]').onclick = async () => {
    if (confirm('Supprimer définitivement ?')) { close(); await onDelete(); render(); }
  };
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    close();
    await onSave(data);
    render();
  };
  d.showModal();
  d.querySelector('input,textarea')?.focus();
}

const contactFields = [
  { name: 'name', label: 'Nom du contact', required: true },
  { name: 'company', label: 'Entreprise' },
  { name: 'phone', label: 'Téléphone / WhatsApp', type: 'tel' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'status', label: 'Statut', type: 'select', options: STATUTS },
  { name: 'amount', label: 'Montant potentiel (€)', type: 'number' },
  { name: 'source', label: 'Source (recommandation, LinkedIn…)' },
  { name: 'driveUrl', label: 'Dossier Google Drive (lien)', type: 'url' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
function editContact(c) {
  const isNew = !c;
  openForm({
    title: isNew ? 'Nouveau contact' : 'Modifier le contact',
    fields: contactFields,
    values: c || { status: 'Nouveau' },
    onSave: async data => {
      const obj = { ...(c || { id: uid(), createdAt: today() }), ...data, amount: Number(data.amount) || 0 };
      await save('contacts', obj);
      if (isNew) location.hash = '#/contact/' + obj.id;
    },
    onDelete: isNew ? null : async () => { await removeContact(c.id); location.hash = '#/contacts'; },
  });
}
function addTask(contactId, t) {
  openForm({
    title: t ? 'Modifier la relance' : 'Nouvelle relance',
    fields: [{ name: 'text', label: 'Action à faire', required: true }, { name: 'due', label: 'Échéance', type: 'date', required: true, default: addDays(2) }],
    values: t || {},
    onSave: d => save('tasks', { ...(t || { id: uid(), contactId, done: false }), ...d }),
    onDelete: t ? () => remove('tasks', t.id) : null,
  });
}
function addNote(contactId) {
  openForm({
    title: 'Nouvel échange',
    fields: [
      { name: 'channel', label: 'Canal', type: 'select', options: CANAUX },
      { name: 'date', label: 'Date', type: 'date', default: today(), required: true },
      { name: 'text', label: 'Résumé', type: 'textarea', rows: 5, required: true },
    ],
    onSave: async d => {
      await save('notes', { id: uid(), contactId, ...d });
      const c = byId('contacts', contactId);
      if (c && (!c.lastContact || d.date > c.lastContact)) await save('contacts', { ...c, lastContact: d.date });
    },
  });
}
function addDoc(contactId) {
  openForm({
    title: 'Ajouter un document',
    fields: [{ name: 'title', label: 'Titre (ex : Devis v1)', required: true }, { name: 'url', label: 'Lien Google Drive', type: 'url', required: true }],
    onSave: d => save('docs', { id: uid(), contactId, ...d, date: today() }),
  });
}

// ---------- vues ----------
const contactName = id => esc(byId('contacts', id)?.name || '—');
function taskItem(t, showContact = true) {
  const c = byId('contacts', t.contactId);
  const wa = c && waLink(c.phone);
  return `<li class="${t.done ? 'done' : ''}">
    <button class="check" data-act="toggle" data-id="${t.id}" aria-label="Terminer">${t.done ? '✓' : ''}</button>
    <div class="grow"><a class="t" href="#/contact/${t.contactId}" ${showContact ? '' : 'data-act="edit-task" data-id="' + t.id + '"'}><b>${esc(t.text)}</b></a>
      <small>${showContact ? contactName(t.contactId) + ' · ' : ''}${t.done ? 'Fait' : dueLabel(t.due)}</small></div>
    ${wa && !t.done ? `<a class="btn wa s" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    ${!t.done ? `<a class="btn s" href="${calLink(t, c)}" target="_blank" rel="noopener" title="Ajouter à Google Agenda">📅</a>` : ''}
  </li>`;
}

function viewToday() {
  const open = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const late = open.filter(t => diff(t.due) < 0), now = open.filter(t => diff(t.due) === 0), week = open.filter(t => diff(t.due) > 0 && diff(t.due) <= 7);
  const active = S.contacts.filter(c => isOpen(c.status));
  const pipeline = active.reduce((s, c) => s + (c.amount || 0), 0);
  const noAction = active.filter(c => !open.some(t => t.contactId === c.id));
  const sec = (t, arr) => arr.length ? `<h2>${t} (${arr.length})</h2><ul class="list">${arr.map(x => taskItem(x)).join('')}</ul>` : '';
  const empty = !late.length && !now.length && !week.length;
  return `<div class="stats">
      <div class="stat"><b>${active.length}</b><small>en cours</small></div>
      <div class="stat"><b class="${late.length ? 'late' : ''}">${late.length}</b><small>en retard</small></div>
      <div class="stat"><b>${euro(pipeline)}</b><small>pipeline</small></div></div>
    ${G.configured() ? '<p><a class="btn" href="#/meetings">📝 Réunions Meet récentes</a></p>' : ''}
    ${sec('En retard', late)}${sec('Aujourd\'hui', now)}${sec('7 prochains jours', week)}
    ${empty ? '<div class="empty">Aucune relance à venir 🎉<br>Ouvrez un contact pour en planifier une.</div>' : ''}
    ${noAction.length ? `<h2>Sans prochaine action (${noAction.length})</h2><ul class="list">${noAction.map(c => `<li><a class="grow" href="#/contact/${c.id}"><b>${esc(c.name)}</b><small>${esc(c.company || '')}</small></a><span class="badge ${badgeClass(c.status)}">${esc(c.status)}</span></li>`).join('')}</ul>` : ''}`;
}

function contactList() {
  const q = ui.q.trim().toLowerCase();
  const list = S.contacts
    .filter(c => (!ui.status || c.status === ui.status) && (!q || [c.name, c.company, c.phone, c.email].some(v => (v || '').toLowerCase().includes(q))))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!list.length) return `<div class="empty">${S.contacts.length ? 'Aucun résultat.' : 'Aucun contact pour l\'instant.<br>Appuyez sur + pour en ajouter un.'}</div>`;
  return `<ul class="list">${list.map(c => {
    const next = S.tasks.filter(t => t.contactId === c.id && !t.done).sort((a, b) => a.due.localeCompare(b.due))[0];
    return `<li><a class="grow" href="#/contact/${c.id}"><b>${esc(c.name)}</b><small>${esc(c.company || '')}${next ? ' · ' + dueLabel(next.due) : ''}</small></a>
      <span class="badge ${badgeClass(c.status)}">${esc(c.status)}</span></li>`;
  }).join('')}</ul>`;
}
function viewContacts() {
  return `<input id="q" type="search" placeholder="Rechercher un nom, une entreprise…" value="${esc(ui.q)}">
    <div class="chips"><button class="chip ${ui.status ? '' : 'on'}" data-act="filter" data-s="">Tous</button>
    ${STATUTS.map(s => `<button class="chip ${ui.status === s ? 'on' : ''}" data-act="filter" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div id="clist">${contactList()}</div>`;
}

function viewContact(id) {
  const c = byId('contacts', id);
  if (!c) return '<div class="empty">Contact introuvable. <a href="#/contacts">Retour</a></div>';
  const tasks = S.tasks.filter(t => t.contactId === id).sort((a, b) => (a.done - b.done) || a.due.localeCompare(b.due));
  const notes = S.notes.filter(n => n.contactId === id).sort((a, b) => b.date.localeCompare(a.date));
  const docs = S.docs.filter(d => d.contactId === id).sort((a, b) => b.date.localeCompare(a.date));
  const wa = waLink(c.phone);
  return `<p><a href="#/contacts" class="muted">← Contacts</a></p>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:start"><div><h2 style="margin:0;font-size:20px;text-transform:none;letter-spacing:0;color:var(--text)">${esc(c.name)}</h2>
        <span class="muted">${esc(c.company || '')}</span></div><button class="btn s" data-act="edit-contact">Modifier</button></div>
      <div class="row" style="margin:12px 0"><select data-act="status" style="width:auto">${STATUTS.map(s => `<option ${s === c.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        ${c.amount ? `<span class="badge">${euro(c.amount)}</span>` : ''}</div>
      <div class="row">
        ${wa ? `<a class="btn wa" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${c.phone ? `<a class="btn" href="tel:${esc(c.phone)}">Appeler</a>` : ''}
        ${c.email ? `<a class="btn" href="mailto:${esc(c.email)}">Email</a>` : ''}
        ${c.driveUrl ? `<a class="btn" href="${esc(c.driveUrl)}" target="_blank" rel="noopener">Dossier Drive</a>` : ''}
        ${G.configured() ? `<a class="btn" href="#/meetings/${c.id}">Réunions Meet</a>` : ''}</div>
      ${c.source || c.lastContact ? `<p class="muted" style="margin:12px 0 0">${c.source ? 'Source : ' + esc(c.source) + '. ' : ''}${c.lastContact ? 'Dernier contact : ' + fmt(c.lastContact) + '.' : ''}</p>` : ''}
      ${c.notes ? `<p class="note-body" style="margin:10px 0 0">${esc(c.notes)}</p>` : ''}
    </div>
    <h2>Relances <button class="btn s" data-act="add-task">+ Ajouter</button></h2>
    ${tasks.length ? `<ul class="list">${tasks.map(t => taskItem(t, false)).join('')}</ul>` : '<div class="empty">Aucune relance.</div>'}
    <h2>Échanges <button class="btn s" data-act="add-note">+ Ajouter</button></h2>
    ${notes.length ? notes.map(n => `<div class="card"><small>${fmt(n.date)} · ${esc(n.channel)} <a href="#" data-act="del-note" data-id="${n.id}" class="muted" style="float:right">supprimer</a></small><div class="note-body">${esc(n.text)}</div></div>`).join('') : '<div class="empty">Aucun échange noté.</div>'}
    <h2>Documents <button class="btn s" data-act="add-doc">+ Ajouter</button></h2>
    ${docs.length ? `<ul class="list">${docs.map(d => `<li><a class="grow" href="${esc(d.url)}" target="_blank" rel="noopener"><b>${d.kind === 'video' ? '🎥' : d.kind === 'notes' ? '📝' : '📄'} ${esc(d.title)}</b><small>${fmt(d.date)}</small></a><button class="btn s d" data-act="del-doc" data-id="${d.id}">✕</button></li>`).join('')}</ul>` : '<div class="empty">Aucun document. Collez le lien Drive d\'un devis ou d\'un contrat.</div>'}`;
}

function viewSettings() {
  return `${googleCard()}<div class="card"><b>Indicatif pays par défaut</b><p class="muted">Utilisé pour transformer 06 12 34 56 78 en numéro WhatsApp international.</p>
      <input id="cc" value="${esc(cc())}" inputmode="numeric" style="max-width:120px"> <small class="muted">33 = France</small></div>
    <div class="card"><b>Sauvegarde</b><p class="muted">Les données sont stockées sur cet appareil. Exportez régulièrement un fichier de sauvegarde, et importez-le pour retrouver vos données sur un autre appareil.</p>
      <div class="row"><button class="btn p" data-act="export">Exporter</button><label class="btn" style="margin:0;color:var(--text)">Importer<input type="file" id="import" accept=".json" hidden></label></div></div>
    <div class="card"><b>Installer l'application</b><p class="muted">Android/Chrome : menu ⋮ → « Installer l'application ». iPhone/Safari : Partager → « Sur l'écran d'accueil ». Ordinateur : icône d'installation dans la barre d'adresse.</p></div>
    <div class="card"><b>Zone de danger</b><p class="muted">Efface toutes les données de cet appareil.</p><button class="btn d" data-act="wipe">Tout effacer</button></div>`;
}

// ---------- rendu ----------
function render() {
  const h = location.hash || '#/';
  const [, route, arg] = h.split('/');
  let tab = 'today', title = 'Aujourd\'hui', html;
  if (route === 'contacts') { tab = 'contacts'; title = 'Contacts'; html = viewContacts(); }
  else if (route === 'contact') { tab = 'contacts'; title = 'Fiche contact'; html = viewContact(arg); }
  else if (route === 'meetings') { tab = 'today'; title = 'Réunions Meet'; html = viewMeetings(arg); }
  else if (route === 'settings') { tab = 'settings'; title = 'Réglages'; html = viewSettings(); }
  else html = viewToday();
  $('#title').textContent = title;
  $('#main').innerHTML = html;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  $('#fab').hidden = route === 'settings' || route === 'contact' || route === 'meetings';
  updateTop();
  if (route === 'meetings' && G.connected() && ui.meet.items === null && !ui.meet.loading) fetchMeetings();
}

// ---------- événements ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const cid = location.hash.split('/')[2];
  if (act === 'del-note' || act === 'edit-task') e.preventDefault();
  if (act === 'new-contact') editContact();
  else if (act === 'edit-contact') editContact(byId('contacts', cid));
  else if (act === 'add-task') addTask(cid);
  else if (act === 'edit-task') addTask(cid, byId('tasks', id));
  else if (act === 'add-note') addNote(cid);
  else if (act === 'add-doc') addDoc(cid);
  else if (act === 'toggle') { const t = byId('tasks', id); await save('tasks', { ...t, done: !t.done, doneAt: t.done ? null : today() }); render(); }
  else if (act === 'del-note') { if (confirm('Supprimer cet échange ?')) { await remove('notes', id); render(); } }
  else if (act === 'del-doc') { if (confirm('Retirer ce document ?')) { await remove('docs', id); render(); } }
  else if (act === 'filter') { ui.status = el.dataset.s; render(); }
  else if (act === 'sync') await doSync(true);
  else if (act === 'google-connect') { await connectGoogle(); }
  else if (act === 'google-signout') { G.signOut(); ui.sync = { state: 'off' }; ui.meet.items = null; render(); }
  else if (act === 'meet-refresh') { ui.meet.items = null; ui.meet.error = ''; render(); }
  else if (act === 'meet-add') await meetAdd(el.dataset);
  else if (act === 'meet-note') await meetNote(el);
  else if (act === 'export') exportData();
  else if (act === 'wipe') {
    if (confirm('Tout effacer sur cet appareil ?') && confirm('Vraiment ? Pensez à exporter avant.')) {
      for (const k of db.STORES) await db.clear(k);
      await load(); render();
    }
  }
});
document.addEventListener('change', async e => {
  if (e.target.dataset.act === 'status') {
    const c = byId('contacts', location.hash.split('/')[2]);
    await save('contacts', { ...c, status: e.target.value }); render();
  } else if (e.target.id === 'cc') localStorage.setItem('cc', e.target.value.replace(/\D/g, '') || '33');
  else if (e.target.id === 'gcid') { localStorage.setItem('gcid', e.target.value.trim()); render(); }
  else if (e.target.id === 'import') importData(e.target.files[0]);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; $('#clist').innerHTML = contactList(); }
});

function exportData() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...S }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `crm-sauvegarde-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!db.STORES.every(k => Array.isArray(data[k]))) throw new Error('format');
    if (!confirm('Remplacer toutes les données de cet appareil par cette sauvegarde ?')) return;
    for (const k of db.STORES) { await db.clear(k); for (const v of data[k]) await db.put(k, v); }
    await load(); render();
    alert('Import terminé.');
  } catch { alert('Fichier de sauvegarde invalide.'); }
}


// ---------- Google : synchro ----------
ui.sync = { state: 'off', msg: '' };
ui.meet = { items: null, loading: false, error: '' };
let syncing = false, syncTimer;

function setSync(state, msg = '') { ui.sync = { state, msg, at: Date.now() }; updateTop(); }
function updateTop() {
  const el = $('#topAction');
  if (!G.configured()) { el.innerHTML = ''; return; }
  const label = { off: '☁ Connecter', syncing: '☁ Synchro…', ok: '☁ À jour', error: '☁ Erreur' }[ui.sync.state] || '☁';
  el.innerHTML = `<button class="btn s" data-act="sync" title="${esc(ui.sync.msg)}">${label}</button>`;
}
function scheduleSync() {
  if (!G.configured() || !G.connected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(false), 4000);
}
function safeRender() {
  const busy = document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  busy ? updateTop() : render();
}
async function connectGoogle() {
  try { await G.signIn(); } catch (e) { alert(e.message); setSync('error', e.message); return render(); }
  await doSync(false);
  render();
}
async function doSync(manual) {
  if (syncing || !G.configured()) return;
  if (!G.connected()) {
    if (!manual) return setSync('off');
    return connectGoogle();
  }
  syncing = true; setSync('syncing');
  try {
    const { id, data } = await G.pullRemote();
    const m = merge(S, data, db.STORES);
    for (const k of db.STORES) {
      const keep = new Set(m[k].map(r => r.id));
      for (const r of S[k]) if (!keep.has(r.id)) await db.del(k, r.id);
      for (const r of m[k]) if (!S[k].includes(r)) await db.put(k, r);
      S[k] = m[k];
    }
    const known = new Set(S.tombs.map(t => t.id + t.at));
    for (const t of m.tombs) if (!known.has(t.id + t.at)) await db.put('tombs', t);
    S.tombs = m.tombs;
    await G.pushRemote(id, { version: 1, syncedAt: Date.now(), ...m });
    setSync('ok');
  } catch (e) {
    setSync('error', e.message);
    if (manual) alert('Synchronisation impossible : ' + e.message);
  } finally {
    syncing = false;
    safeRender();
  }
}

function googleCard() {
  const st = ui.sync;
  const status = !G.configured() ? 'Non configuré' : !G.connected() ? 'Non connecté' : { ok: 'Synchronisé à ' + new Date(st.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), syncing: 'Synchronisation…', error: 'Erreur : ' + st.msg }[st.state] || 'Connecté';
  return `<div class="card"><b>Google</b>
    <p class="muted">Synchronise le CRM entre vos appareils (via votre Drive) et importe les comptes rendus et enregistrements Meet.</p>
    <label>ID client Google (OAuth)<input id="gcid" value="${esc(localStorage.getItem('gcid') || '')}" placeholder="xxxx.apps.googleusercontent.com"></label>
    <p class="muted">${esc(status)}</p>
    ${G.configured() ? `<div class="row">${G.connected() ? '<button class="btn p" data-act="sync">Synchroniser</button><button class="btn" data-act="google-signout">Se déconnecter</button>' : '<button class="btn p" data-act="google-connect">Se connecter avec Google</button>'}</div>` : ''}</div>`;
}

// ---------- Google : réunions Meet ----------
const norm = e => (e || '').trim().toLowerCase();
const kindOf = a => a.mimeType?.startsWith('video/') ? 'video' : a.mimeType === 'application/vnd.google-apps.document' ? 'notes' : null;

async function fetchMeetings() {
  ui.meet.loading = true;
  try {
    const events = await G.recentEvents(45);
    const byEmail = new Map(S.contacts.filter(c => c.email).map(c => [norm(c.email), c]));
    const items = [];
    for (const ev of events) {
      const atts = (ev.attachments || []).map(a => ({ fileId: a.fileId, title: a.title, url: a.fileUrl, kind: kindOf(a) })).filter(a => a.kind && a.fileId);
      if (!atts.length) continue;
      const date = (ev.start?.dateTime || ev.start?.date || '').slice(0, 10);
      const seen = new Set();
      for (const at of ev.attendees || []) {
        const c = !at.self && byEmail.get(norm(at.email));
        if (c && !seen.has(c.id)) { seen.add(c.id); items.push({ eventId: ev.id, summary: ev.summary || 'Réunion', date, contactId: c.id, atts }); }
      }
    }
    ui.meet.items = items.sort((a, b) => b.date.localeCompare(a.date));
    ui.meet.error = '';
  } catch (e) {
    ui.meet.items = [];
    ui.meet.error = e.message;
  } finally {
    ui.meet.loading = false;
    if (location.hash.startsWith('#/meetings')) render();
  }
}
function viewMeetings(filterId) {
  const back = `<p><a href="${filterId ? '#/contact/' + filterId : '#/'}" class="muted">← Retour</a></p>`;
  if (!G.configured()) return back + '<div class="empty">Google n\'est pas configuré. Voir Réglages.</div>';
  if (!G.connected()) return back + '<div class="empty">Connectez-vous à Google pour voir vos réunions.<br><br><button class="btn p" data-act="google-connect">Se connecter avec Google</button></div>';
  if (ui.meet.items === null) return back + '<div class="empty">Chargement des réunions…</div>';
  const rows = ui.meet.items.filter(i => !filterId || i.contactId === filterId);
  const noEmail = S.contacts.filter(c => !c.email).length;
  const refresh = '<p><button class="btn s" data-act="meet-refresh">Actualiser</button></p>';
  if (ui.meet.error) return back + `<div class="empty late">${esc(ui.meet.error)}</div>${refresh}`;
  if (!rows.length) return back + `<div class="empty">Aucun compte rendu ni enregistrement trouvé sur les 45 derniers jours.<br><small>Il faut que l'email du contact soit renseigné et qu'il ait été invité à la réunion.${noEmail ? ` (${noEmail} contact(s) sans email)` : ''}</small></div>${refresh}`;
  return back + refresh + rows.map(i => {
    const c = byId('contacts', i.contactId);
    return `<div class="card"><b>${esc(i.summary)}</b><br><small>${fmt(i.date)} · <a href="#/contact/${i.contactId}">${esc(c?.name)}</a></small>
      ${i.atts.map(a => {
        const added = S.docs.some(d => d.contactId === i.contactId && d.fileId === a.fileId);
        const noted = S.notes.some(n => n.contactId === i.contactId && n.fileId === a.fileId);
        return `<div class="row" style="margin-top:8px;align-items:center"><a class="grow" href="${esc(a.url)}" target="_blank" rel="noopener">${a.kind === 'video' ? '🎥' : '📝'} ${esc(a.title)}</a>
          ${added ? '<small>✓ Ajouté</small>' : `<button class="btn s" data-act="meet-add" data-ev="${esc(i.eventId)}" data-f="${esc(a.fileId)}" data-c="${i.contactId}">Ajouter aux documents</button>`}
          ${a.kind === 'notes' ? (noted ? '<small>✓ Dans les échanges</small>' : `<button class="btn s" data-act="meet-note" data-ev="${esc(i.eventId)}" data-f="${esc(a.fileId)}" data-c="${i.contactId}">Copier dans Échanges</button>`) : ''}</div>`;
      }).join('')}</div>`;
  }).join('');
}
function findMeet(d) {
  const i = ui.meet.items.find(x => x.eventId === d.ev && x.contactId === d.c);
  return i && { i, a: i.atts.find(a => a.fileId === d.f) };
}
async function meetAdd(d) {
  const m = findMeet(d); if (!m) return;
  await save('docs', { id: uid(), contactId: d.c, title: `${m.i.summary} — ${m.a.title}`, url: m.a.url, date: m.i.date, fileId: d.f, kind: m.a.kind });
  render();
}
async function meetNote(btn) {
  const m = findMeet(btn.dataset); if (!m) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const text = (await G.docText(btn.dataset.f)).trim().slice(0, 30000);
    await save('notes', { id: uid(), contactId: btn.dataset.c, channel: 'Google Meet', date: m.i.date, text: `${m.i.summary}\n\n${text}`, fileId: btn.dataset.f });
    const c = byId('contacts', btn.dataset.c);
    if (c && (!c.lastContact || m.i.date > c.lastContact)) await save('contacts', { ...c, lastContact: m.i.date });
  } catch (e) { alert('Import impossible : ' + e.message); }
  render();
}

window.addEventListener('hashchange', render);
await load();
render();
if (G.configured()) { G.preload().catch(() => {}); if (G.connected()) doSync(false); else setSync('off'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.();
