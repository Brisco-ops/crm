import * as db from './db.js';
import * as G from './google.js';
import { merge } from './sync.js';
import * as M from './model.js';

const STATUTS = M.STAGES.map(s => s.label);
const CANAUX = ['WhatsApp', 'Google Meet', 'Appel', 'Email', 'En personne'];
const isOpen = s => s !== 'Gagné' && s !== 'Perdu';
const badgeClass = s => 'b-' + s.split(' ')[0];

const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const euro = n => (Number(n) || 0).toLocaleString('fr-FR') + ' €';
const money = (n, cur = 'EUR') => cur === 'XOF' ? (Number(n) || 0).toLocaleString('fr-FR') + ' F CFA' : euro(n);
const sumMoney = list => {
  const t = {};
  for (const c of list) if (c.amount) t[c.currency || 'EUR'] = (t[c.currency || 'EUR'] || 0) + c.amount;
  const k = Object.keys(t);
  return k.length ? k.map(cur => money(t[cur], cur)).join(' + ') : euro(0);
};

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
const ui = { q: '', status: '', tf: 'open', ct: 'activity', ctId: '', calDate: toStr(new Date()),
  calView: (() => { try { return localStorage.getItem('calview'); } catch { return null; } })() || ((window.innerWidth || 1000) < 700 ? 'day' : 'week') };
const byId = (k, id) => S[k].find(x => x.id === id);

async function load() {
  for (const k of Object.keys(S)) S[k] = await db.all(k);
  await upgradeAll();
}
// Met tous les enregistrements au format courant (idempotent) : voir model.js / DATA-MODEL.md.
async function upgradeAll() {
  for (const k of db.STORES) {
    for (let i = 0; i < S[k].length; i++) {
      const r = S[k][i], u = M.upgradeRecord(k, r, cc());
      if (JSON.stringify(u) !== JSON.stringify(r)) { S[k][i] = u; await db.put(k, u); }
    }
  }
}
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
const waNumber = p => M.intlDigits(p, cc());
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
function confirmSheet(msg, label = 'Supprimer') {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.className = 'asheet';
    d.innerHTML = `<div class="ag"><p>${esc(msg)}</p><button class="red" data-ok>${esc(label)}</button></div><div class="ag"><button data-no>Annuler</button></div>`;
    document.body.appendChild(d);
    const done = v => { d.close(); d.remove(); res(v); };
    d.querySelector('[data-ok]').onclick = () => done(true);
    d.querySelector('[data-no]').onclick = () => done(false);
    d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    d.addEventListener('click', e => { if (e.target === d) done(false); });
    d.showModal();
  });
}
function openForm({ title, fields, values = {}, onSave, onDelete }) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form><div class="grab"></div>
    <div class="sh"><button type="button" class="lnk" data-cancel>Annuler</button><h3>${esc(title)}</h3><button class="lnk b">Enregistrer</button></div>
    <div class="sb">${fields.map(f => field(f, values[f.name])).join('')}
    ${onDelete ? '<button type="button" class="btn d wide" data-del>Supprimer</button>' : ''}</div></form>`;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = close;
  d.addEventListener('cancel', () => setTimeout(() => d.remove()));
  d.addEventListener('click', e => { if (e.target === d) close(); });
  if (onDelete) d.querySelector('[data-del]').onclick = async () => {
    if (await confirmSheet('Supprimer définitivement ?')) { close(); await onDelete(); render(); }
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
  { name: 'firstName', label: 'Prénom' },
  { name: 'lastName', label: 'Nom', required: true },
  { name: 'jobTitle', label: 'Poste' },
  { name: 'company', label: 'Entreprise' },
  { name: 'phone', label: 'Téléphone / WhatsApp (avec +indicatif hors France)', type: 'tel' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'status', label: 'Statut', type: 'select', options: STATUTS },
  { name: 'amount', label: 'Montant potentiel', type: 'number' },
  { name: 'currency', label: 'Devise', type: 'select', options: M.CURRENCIES },
  { name: 'entity', label: 'Entité qui facture', type: 'select', options: ['', ...M.ENTITIES] },
  { name: 'source', label: 'Source (recommandation, LinkedIn…)' },
  { name: 'driveUrl', label: 'Dossier Google Drive (lien)', type: 'url' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
function editContact(c) {
  const isNew = !c;
  openForm({
    title: isNew ? 'Nouveau contact' : 'Modifier le contact',
    fields: contactFields,
    values: c || { status: 'Nouveau', currency: 'EUR' },
    onSave: async data => {
      const base = c || { id: uid(), createdAt: new Date().toISOString() };
      const obj = M.normalizeContact({ ...base, ...data, amount: Number(data.amount) || 0 }, cc());
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
  return `<li class="tk ${t.done ? 'done' : ''} ${!t.done && diff(t.due) < 0 ? 'lt' : ''}">
    <button class="check" data-act="toggle" data-id="${t.id}" aria-label="Terminer">${t.done ? '✓' : ''}</button>
    <div class="grow"><a class="t" href="#/contact/${t.contactId}" ${showContact ? '' : 'data-act="edit-task" data-id="' + t.id + '"'}><b>${esc(t.text)}</b></a>
      <small>${showContact ? contactName(t.contactId) + ' · ' : ''}${t.done ? 'Fait' : dueLabel(t.due)}</small></div>
    ${wa && !t.done ? `<a class="btn wa s" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    ${!t.done ? `<a class="btn s" href="${calLink(t, c)}" target="_blank" rel="noopener" title="Ajouter à Google Agenda">📅</a>` : ''}
  </li>`;
}

// ---------- accueil : calendrier façon Teams ----------
const HOUR_PX = 56, MIN_PX = HOUR_PX / 60;
const hhmm = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function startOfWeek(s) { const d = new Date(s + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toStr(d); }
function visibleDays() {
  if (ui.calView === 'day') return [ui.calDate];
  const mon = new Date(startOfWeek(ui.calDate) + 'T00:00');
  return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(i, mon));
}
function rangeLabel(days) {
  const f = s => new Date(s + 'T00:00');
  if (days.length === 1) { const t = f(days[0]).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); }
  const a = f(days[0]), b = f(days[6]);
  const sameMonth = a.getMonth() === b.getMonth();
  return `${a.toLocaleDateString('fr-FR', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}
// Répartit les événements qui se chevauchent côte à côte.
function layoutDay(list) {
  list.sort((a, b) => a.s - b.s || b.f - a.f);
  const out = []; let cluster = [], end = -1;
  const flush = () => {
    const cols = [];
    for (const ev of cluster) { let i = cols.findIndex(f => f <= ev.s); if (i < 0) { i = cols.length; cols.push(0); } cols[i] = ev.f; ev.col = i; }
    cluster.forEach(ev => { ev.cols = cols.length; out.push(ev); }); cluster = []; end = -1;
  };
  for (const ev of list) { if (cluster.length && ev.s >= end) flush(); cluster.push(ev); end = Math.max(end, ev.f); }
  if (cluster.length) flush();
  return out;
}
function dayEvents(day) {
  const d0 = new Date(day + 'T00:00'), d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
  const allDay = [], timed = [];
  for (const e of ui.cal.items || []) {
    if (e.allDay) { if (e.sd <= day && day < e.ed) allDay.push(e); continue; }
    const st = new Date(e.start), en = new Date(e.end || e.start);
    if (st < d1 && en > d0) { const s = Math.max(0, (st - d0) / 6e4); timed.push({ e, s, f: Math.max(Math.min(1440, (en - d0) / 6e4), s + 25) }); }
  }
  return { allDay, timed: layoutDay(timed) };
}

function viewToday() {
  const open = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const late = open.filter(t => diff(t.due) < 0);
  const active = S.contacts.filter(c => isOpen(c.status));
  const pipeline = sumMoney(active);
  const noAction = active.filter(c => !open.some(t => t.contactId === c.id));
  const byEmail = new Map(S.contacts.filter(c => c.email).map(c => [norm(c.email), c]));
  const days = visibleDays(), td = today();
  const per = days.map(d => ({ d, ...dayEvents(d) }));

  // plage horaire : 7h-20h, élargie si besoin
  let h0 = 7, h1 = 20;
  for (const p of per) for (const t of p.timed) { h0 = Math.min(h0, Math.floor(t.s / 60)); h1 = Math.max(h1, Math.ceil(t.f / 60)); }
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (days.includes(td)) { h0 = Math.min(h0, Math.floor(nowMin / 60)); h1 = Math.min(24, Math.max(h1, Math.ceil(nowMin / 60) + 1)); }
  const gridH = (h1 - h0) * HOUR_PX, base = h0 * 60;
  ui.calH0 = h0;

  const head = per.map(p => {
    const d = new Date(p.d + 'T00:00');
    return `<div class="dh ${p.d === td ? 'today' : ''}" data-act="calday" data-d="${p.d}"><small>${d.toLocaleDateString('fr-FR', { weekday: 'short' })}</small><b>${d.getDate()}</b></div>`;
  }).join('');
  const allday = per.map(p => {
    const tasks = open.filter(t => t.due === p.d || (p.d === td && t.due < td));
    return `<div class="adc">${p.allDay.map(e => `<a class="achip ev" href="${esc(e.link)}" target="_blank" rel="noopener" title="${esc(e.title)}${e.cal ? ' — ' + esc(e.cal) : ''}"${e.color ? ` style="background:${e.color}33;border-left-color:${e.color}"` : ''}>${esc(e.title)}</a>`).join('')}
      ${tasks.map(t => `<span class="achip tk ${t.due < td ? 'lt' : ''}"><button class="tcheck" data-act="toggle" data-id="${t.id}" aria-label="Terminer"></button><a href="#/contact/${t.contactId}" title="${esc(t.text)}">${esc(t.text)} <small>${contactName(t.contactId)}${t.due < td ? ' · retard' : ''}</small></a></span>`).join('')}</div>`;
  }).join('');
  const hours = Array.from({ length: h1 - h0 }, (_, i) => `<span style="top:${i * HOUR_PX}px">${pad(h0 + i)}:00</span>`).join('');
  const cols = per.map(p => `<div class="dcol">${p.timed.map(t => {
    const e = t.e, c = e.emails.map(m => byEmail.get(norm(m))).find(Boolean);
    return `<div class="blk" data-act="openurl" data-url="${esc(e.link)}" style="top:${(t.s - base) * MIN_PX}px;height:${Math.max(22, (t.f - t.s) * MIN_PX - 2)}px;left:${t.col / t.cols * 100}%;width:calc(${100 / t.cols}% - 3px)${e.color ? `;background:${e.color}38;border-left-color:${e.color}` : ''}" title="${esc(e.title)}${e.cal ? ' — ' + esc(e.cal) : ''}">
      <b>${esc(e.title)}</b><small>${hhmm(e.start)} – ${hhmm(e.end)}${c ? ' · ' + esc(c.name) : ''}</small>${e.meet ? `<a class="join" href="${esc(e.meet)}" target="_blank" rel="noopener" title="Rejoindre la réunion">🎥</a>` : ''}</div>`;
  }).join('')}${p.d === td && nowMin >= base && nowMin <= h1 * 60 ? `<div class="nowl" style="top:${(nowMin - base) * MIN_PX}px"></div>` : ''}</div>`).join('');

  let note = '';
  if (G.configured() && !G.connected()) note = '<div class="card note">Connecte Google pour afficher tes réunions dans le calendrier. <button class="btn p s" data-act="google-connect">Se connecter avec Google</button></div>';
  else if (ui.cal.error) note = `<p class="late">Agenda : ${esc(ui.cal.error)}</p>`;

  return `<div class="stats slim">
      <a class="stat" href="#/contacts"><b>${active.length}</b><small>contacts en cours</small></a>
      <a class="stat ${late.length ? 'alert' : ''}" href="#/tasks"><b>${late.length}</b><small>relances en retard</small></a>
      <a class="stat" href="#/pipeline"><b>${pipeline}</b><small>pipeline</small></a></div>
    ${note}
    <div class="cal-bar">
      <button class="btn" data-act="calnav" data-n="0">Aujourd'hui</button>
      <button class="btn icon" data-act="calnav" data-n="-1" aria-label="Précédent">‹</button><button class="btn icon" data-act="calnav" data-n="1" aria-label="Suivant">›</button>
      <b class="grow">${esc(rangeLabel(days))}</b>
      ${ui.cal.loading ? '<small class="muted">Chargement…</small>' : ''}
      ${G.connected() ? '<button class="btn s" data-act="cal-refresh" title="Actualiser">↻</button>' : ''}
      <div class="seg"><button class="${ui.calView === 'day' ? 'on' : ''}" data-act="calview" data-v="day">Jour</button><button class="${ui.calView === 'week' ? 'on' : ''}" data-act="calview" data-v="week">Semaine</button></div>
    </div>
    <div class="cal-scroll"><div class="cal" style="--n:${days.length}">
      <div class="cal-top"><div class="row-g"><div class="gut"></div>${head}</div><div class="row-g allday"><div class="gut"><small>Relances</small></div>${allday}</div></div>
      <div class="row-g cal-body" style="height:${gridH}px"><div class="gut" style="height:${gridH}px">${hours}</div>${cols}</div>
    </div></div>
    ${noAction.length ? `<details class="card" style="margin-top:16px"><summary>Contacts sans prochaine action (${noAction.length})</summary><ul class="list" style="margin-top:10px">${noAction.map(c => `<li><a class="grow" href="#/contact/${c.id}"><b>${esc(c.name)}</b><small>${esc(c.company || '')}</small></a><span class="badge ${badgeClass(c.status)}">${esc(c.status)}</span></li>`).join('')}</ul></details>` : ''}
    ${G.configured() ? '<p style="margin-top:16px"><a class="btn" href="#/meetings">📝 Comptes rendus de réunions</a></p>' : ''}`;
}

const initials = n => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const nextTask = id => S.tasks.filter(t => t.contactId === id && !t.done).sort((a, b) => a.due.localeCompare(b.due))[0];
const CH_ICON = { 'WhatsApp': '💬', 'Google Meet': '🎥', 'Appel': '📞', 'Email': '✉️', 'En personne': '🤝' };
const docIcon = d => d.kind === 'video' ? '🎥' : d.kind === 'notes' ? '📝' : '📄';

function contactList() {
  const q = ui.q.trim().toLowerCase();
  const list = S.contacts
    .filter(c => (!ui.status || c.status === ui.status) && (!q || [c.name, c.company, c.phone, c.email].some(v => (v || '').toLowerCase().includes(q))))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!list.length) return `<div class="empty">${S.contacts.length ? 'Aucun résultat.' : 'Aucun contact pour l\'instant.<br>Appuie sur + pour en ajouter un.'}</div>`;
  return `<table class="tbl"><thead><tr><th>Nom</th><th class="hm">Entreprise</th><th>Statut</th><th class="hm">Montant</th><th class="hm">Dernier contact</th><th class="hm">Prochaine relance</th></tr></thead><tbody>${list.map(c => {
    const n = nextTask(c.id);
    return `<tr data-act="open" data-id="${c.id}"><td><div class="row nowrap"><span class="av s">${esc(initials(c.name))}</span><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.company || c.email || '')}</small></div></div></td>
      <td class="hm">${esc(c.company || '')}</td><td><span class="badge ${badgeClass(c.status)}">${esc(c.status)}</span></td>
      <td class="hm">${c.amount ? money(c.amount, c.currency) : ''}</td><td class="hm">${c.lastContact ? fmt(c.lastContact) : ''}</td><td class="hm">${n ? dueLabel(n.due) : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function viewContacts() {
  return `<div class="row between" style="margin:0 0 10px"><input id="q" type="search" placeholder="Rechercher un nom, une entreprise…" value="${esc(ui.q)}" style="max-width:420px"><button class="btn p" data-act="new-contact">+ Nouveau contact</button></div>
    <div class="chips"><button class="chip ${ui.status ? '' : 'on'}" data-act="filter" data-s="">Tous (${S.contacts.length})</button>
    ${STATUTS.map(s => `<button class="chip ${ui.status === s ? 'on' : ''}" data-act="filter" data-s="${esc(s)}">${esc(s)} (${S.contacts.filter(c => c.status === s).length})</button>`).join('')}</div>
    <div id="clist">${contactList()}</div>`;
}

function viewPipeline() {
  const cols = STATUTS.map(s => {
    const cs = S.contacts.filter(c => c.status === s).sort((a, b) => (b.amount || 0) - (a.amount || 0));
    return `<section class="col"><header><b>${esc(s)}</b><small>${cs.length} contact${cs.length > 1 ? 's' : ''} · ${sumMoney(cs)}</small></header>
      <div class="drop" data-status="${esc(s)}">${cs.map(c => {
        const n = nextTask(c.id);
        return `<a class="kcard ${badgeClass(s).replace('b-', 'k-')}" draggable="true" data-id="${c.id}" href="#/contact/${c.id}"><b>${esc(c.name)}</b><small>${esc(c.company || '')}</small>
          <div class="row between nowrap" style="margin-top:6px"><span>${c.amount ? money(c.amount, c.currency) : ''}</span><small>${n ? dueLabel(n.due) : ''}</small></div></a>`;
      }).join('') || '<p class="muted nothing">Aucun contact</p>'}</div></section>`;
  }).join('');
  return `<div class="board">${cols}</div><p class="muted hint">Sur ordinateur, glisse une carte vers une autre colonne pour changer son statut. Sur téléphone, ouvre la fiche.</p>`;
}

function viewTasks() {
  const open = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const g = {
    open, late: open.filter(t => diff(t.due) < 0), today: open.filter(t => diff(t.due) === 0), week: open.filter(t => diff(t.due) >= 0 && diff(t.due) <= 7),
    done: S.tasks.filter(t => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')),
  };
  const labels = { open: 'Toutes', late: 'En retard', today: 'Aujourd\'hui', week: '7 jours', done: 'Terminées' };
  const list = g[ui.tf] || g.open;
  return `<div class="chips">${Object.keys(labels).map(k => `<button class="chip ${ui.tf === k ? 'on' : ''}" data-act="tfilter" data-f="${k}">${labels[k]} (${g[k].length})</button>`).join('')}</div>
    ${list.length ? `<ul class="list">${list.map(t => taskItem(t)).join('')}</ul>` : '<div class="empty">Aucune tâche ici.<br><small>Ajoute une relance depuis la fiche d\'un contact.</small></div>'}`;
}

function viewContact(id) {
  const c = byId('contacts', id);
  if (!c) return '<div class="empty">Contact introuvable. <a href="#/contacts">Retour</a></div>';
  const tasks = S.tasks.filter(t => t.contactId === id).sort((a, b) => (a.done - b.done) || a.due.localeCompare(b.due));
  const notes = S.notes.filter(n => n.contactId === id);
  const docs = S.docs.filter(d => d.contactId === id).sort((a, b) => b.date.localeCompare(a.date));
  const wa = waLink(c.phone);
  const openTasks = tasks.filter(t => !t.done);

  const items = [
    ...notes.map(n => ({ date: n.date, ico: CH_ICON[n.channel] || '💬', title: n.channel,
      body: n.text.length > 400 ? `<details><summary>${esc(n.text.slice(0, 200))}…</summary><div class="note-body">${esc(n.text)}</div></details>` : `<div class="note-body">${esc(n.text)}</div>`,
      del: `<a href="#" data-act="del-note" data-id="${n.id}" class="muted">supprimer</a>` })),
    ...docs.map(d => ({ date: d.date, ico: docIcon(d), title: 'Document ajouté', body: `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>` })),
    ...tasks.filter(t => t.done).map(t => ({ date: t.doneAt || t.due, ico: '✅', title: 'Relance terminée', body: esc(t.text) })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const tab = ui.ct;
  const content = tab === 'tasks'
    ? `<div class="row between"><b>Relances</b><button class="btn s p" data-act="add-task">+ Relance</button></div>${tasks.length ? `<ul class="list" style="margin-top:10px">${tasks.map(t => taskItem(t, false)).join('')}</ul>` : '<div class="empty">Aucune relance.</div>'}`
    : tab === 'docs'
    ? `<div class="row between"><b>Documents</b><button class="btn s p" data-act="add-doc">+ Document</button></div>${docs.length ? `<ul class="list" style="margin-top:10px">${docs.map(d => `<li><a class="grow" href="${esc(d.url)}" target="_blank" rel="noopener"><b>${docIcon(d)} ${esc(d.title)}</b><small>${fmt(d.date)}</small></a><button class="btn s d" data-act="del-doc" data-id="${d.id}">✕</button></li>`).join('')}</ul>` : '<div class="empty">Aucun document. Colle le lien Drive d\'un devis ou d\'un contrat.</div>'}`
    : `<div class="row between"><b>Activité</b><button class="btn s p" data-act="add-note">+ Note / échange</button></div>
       ${items.length ? `<div class="tl">${items.map(i => `<div class="item"><span class="ico">${i.ico}</span><div class="grow card"><div class="row between nowrap"><b>${esc(i.title)}</b><small>${fmt(i.date)} ${i.del || ''}</small></div>${i.body}</div></div>`).join('')}</div>` : '<div class="empty">Aucune activité. Note ton premier échange.</div>'}`;

  const prop = (k, v) => v ? `<div class="prop"><small>${k}</small><div>${v}</div></div>` : '';
  return `<p><a href="#/contacts" class="muted">← Contacts</a></p>
    <div class="record">
      <aside class="card">
        <div class="row nowrap" style="align-items:center"><span class="av">${esc(initials(c.name))}</span><div class="grow"><b style="font-size:18px">${esc(c.name)}</b><br><span class="muted">${esc(c.company || '')}</span></div></div>
        <div class="qa">
          <button class="qbtn" data-act="add-note"><i>📝</i>Note</button>
          <button class="qbtn" data-act="add-task"><i>✅</i>Relance</button>
          <button class="qbtn" data-act="add-doc"><i>📄</i>Document</button>
          ${c.phone ? `<a class="qbtn" href="tel:${esc(c.phone)}"><i>📞</i>Appeler</a>` : ''}
          ${wa ? `<a class="qbtn" href="${wa}" target="_blank" rel="noopener"><i>💬</i>WhatsApp</a>` : ''}
          ${c.email ? `<a class="qbtn" href="mailto:${esc(c.email)}"><i>✉️</i>Email</a>` : ''}
        </div>
        <hr>
        <div class="row between"><b>À propos</b><button class="btn s" data-act="edit-contact">Modifier</button></div>
        <div class="prop"><small>Statut</small><select data-act="status">${STATUTS.map(s => `<option ${s === c.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        ${prop('Montant potentiel', c.amount ? money(c.amount, c.currency) : '')}${prop('Téléphone', esc(c.phone))}${prop('Email', esc(c.email))}${prop('Poste', esc(c.jobTitle))}${prop('Source', esc(c.source))}${prop('Entité', esc(c.entity))}
        ${prop('Dernier contact', c.lastContact ? fmt(c.lastContact) : '')}
        ${prop('Dossier Drive', c.driveUrl ? `<a href="${esc(c.driveUrl)}" target="_blank" rel="noopener">Ouvrir le dossier</a>` : '')}
        ${G.configured() ? `<div class="prop"><a class="btn s" href="#/meetings/${c.id}">Réunions Meet</a></div>` : ''}
        ${c.notes ? `<hr><small class="muted">Notes</small><p class="note-body" style="margin:4px 0 0">${esc(c.notes)}</p>` : ''}
      </aside>
      <section>
        <div class="ctabs">
          <button class="${tab === 'activity' ? 'on' : ''}" data-act="ctab" data-t="activity">Activité</button>
          <button class="${tab === 'tasks' ? 'on' : ''}" data-act="ctab" data-t="tasks">Relances (${openTasks.length})</button>
          <button class="${tab === 'docs' ? 'on' : ''}" data-act="ctab" data-t="docs">Documents (${docs.length})</button>
        </div>
        <div class="card" style="margin-top:10px">${content}</div>
      </section>
    </div>`;
}

function viewSettings() {
  return `${googleCard()}<div class="card"><b>Indicatif pays par défaut</b><p class="muted">Utilisé pour transformer 06 12 34 56 78 en numéro WhatsApp international.</p>
      <input id="cc" value="${esc(cc())}" inputmode="numeric" style="max-width:120px"> <small class="muted">33 = France</small></div>
    <div class="card"><b>Sauvegarde</b><p class="muted">Les données sont stockées sur cet appareil. Exporte régulièrement un fichier de sauvegarde, et importe-le pour retrouver tes données sur un autre appareil.</p>
      <div class="row"><button class="btn p" data-act="export">Exporter</button><label class="btn" style="margin:0;color:var(--text)">Importer<input type="file" id="import" accept=".json" hidden></label></div></div>
    <div class="card"><b>Changer de CRM</b><p class="muted">Tes données ne sont jamais enfermées : exporte-les dans un format prêt à importer ailleurs (identifiants stables, téléphones au format international, dates normalisées).</p>
      <div class="row"><button class="btn p" data-act="export-hubspot">HubSpot (ZIP de CSV)</button><button class="btn" data-act="export-csv">Contacts (CSV)</button><button class="btn" data-act="export-json">Complet (JSON)</button></div></div>
    <div class="card"><b>Installer l'application</b><p class="muted">Android/Chrome : menu ⋮ → « Installer l'application ». iPhone/Safari : Partager → « Sur l'écran d'accueil ». Ordinateur : icône d'installation dans la barre d'adresse.</p></div>
    <div class="card"><b>Zone de danger</b><p class="muted">Efface toutes les données de cet appareil.</p><button class="btn d" data-act="wipe">Tout effacer</button></div>`;
}

// ---------- rendu ----------
function render() {
  const h = location.hash || '#/';
  const [, route, arg] = h.split('/');
  let tab = 'today', title = 'Accueil', html;
  if (route === 'contacts') { tab = 'contacts'; title = 'Contacts'; html = viewContacts(); }
  else if (route === 'contact') { tab = 'contacts'; title = 'Fiche contact'; if (ui.ctId !== arg) { ui.ctId = arg; ui.ct = 'activity'; } html = viewContact(arg); }
  else if (route === 'pipeline') { tab = 'pipeline'; title = 'Pipeline'; html = viewPipeline(); }
  else if (route === 'tasks') { tab = 'tasks'; title = 'Tâches'; html = viewTasks(); }
  else if (route === 'meetings') { tab = 'today'; title = 'Réunions Meet'; html = viewMeetings(arg); }
  else if (route === 'settings') { tab = 'settings'; title = 'Réglages'; html = viewSettings(); }
  else html = viewToday();
  $('#title').textContent = title;
  $('#main').innerHTML = html;
  document.body.dataset.route = route || 'home';
  const m = $('#main'), changed = ui.lastHash !== h;
  m.classList.toggle('enter', false); void m.offsetWidth; if (changed) m.classList.toggle('enter', true);
  ui.lastHash = h;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  $('#fab').hidden = !['', 'contacts', 'pipeline'].includes(route || '');
  updateTop();
  if (route === 'meetings' && G.connected() && ui.meet.items === null && !ui.meet.loading) fetchMeetings();
  if (!route) {
    if (G.connected() && ui.cal.key !== calKey() && !ui.cal.loading) fetchCal();
    const sc = $('.cal-scroll');
    if (sc && !ui.calScrolled) { sc.scrollTop = Math.max(0, ((new Date().getHours() || 8) - 1 - (ui.calH0 || 7)) * HOUR_PX); ui.calScrolled = true; }
  }
  if (route) ui.calScrolled = false;
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
  else if (act === 'toggle') { navigator.vibrate?.(8); const t = byId('tasks', id); await save('tasks', { ...t, done: !t.done, doneAt: t.done ? null : today() }); render(); }
  else if (act === 'del-note') { if (await confirmSheet('Supprimer cet échange ?')) { await remove('notes', id); render(); } }
  else if (act === 'del-doc') { if (await confirmSheet('Retirer ce document ?', 'Retirer')) { await remove('docs', id); render(); } }
  else if (act === 'filter') { ui.status = el.dataset.s; render(); }
  else if (act === 'open') location.hash = '#/contact/' + id;
  else if (act === 'ctab') { ui.ct = el.dataset.t; render(); }
  else if (act === 'tfilter') { ui.tf = el.dataset.f; render(); }
  else if (act === 'sync') await doSync(true);
  else if (act === 'google-connect') { await connectGoogle(); }
  else if (act === 'google-signout') { G.signOut(); ui.sync = { state: 'off' }; ui.meet.items = null; ui.cal = { items: [], key: '', loading: false, error: '' }; render(); }
  else if (act === 'cal-refresh') { ui.cal.key = ''; ui.cal.error = ''; render(); }
  else if (act === 'calnav') {
    const n = +el.dataset.n, step = ui.calView === 'day' ? 1 : 7;
    ui.calDate = n === 0 ? today() : addDays(n * step, new Date(ui.calDate + 'T00:00'));
    ui.calScrolled = n === 0 ? false : ui.calScrolled; render();
  }
  else if (act === 'calview') { ui.calView = el.dataset.v; try { localStorage.setItem('calview', ui.calView); } catch {} render(); }
  else if (act === 'calday') { ui.calDate = el.dataset.d; ui.calView = 'day'; render(); }
  else if (act === 'openurl') { if (!e.target.closest('a')) window.open(el.dataset.url, '_blank', 'noopener'); }
  else if (act === 'meet-refresh') { ui.meet.items = null; ui.meet.error = ''; render(); }
  else if (act === 'meet-add') await meetAdd(el.dataset);
  else if (act === 'meet-note') await meetNote(el);
  else if (act === 'export-hubspot') { const C = M.toCanonical(S, { cc: cc() }); download(`crm-hubspot-${today()}.zip`, M.zip(M.hubspotFiles(C))); }
  else if (act === 'export-csv') download(`crm-contacts-${today()}.csv`, new Blob([M.genericContactsCsv(M.toCanonical(S, { cc: cc() }))], { type: 'text/csv' }));
  else if (act === 'export-json') download(`crm-complet-${today()}.json`, new Blob([JSON.stringify(M.toCanonical(S, { cc: cc() }), null, 2)], { type: 'application/json' }));
  else if (act === 'export') exportData();
  else if (act === 'wipe') {
    if (confirm('Tout effacer sur cet appareil ?') && confirm('Vraiment ? Pense à exporter avant.')) {
      for (const k of db.STORES) await db.clear(k);
      await load(); render();
    }
  }
});
// glisser-déposer des cartes du pipeline (ordinateur)
document.addEventListener('dragstart', e => {
  const k = e.target.closest?.('.kcard');
  if (k) { e.dataTransfer.setData('text/plain', k.dataset.id); e.dataTransfer.effectAllowed = 'move'; }
});
document.addEventListener('dragover', e => {
  const d = e.target.closest?.('.drop');
  if (d) { e.preventDefault(); d.classList.add('over'); }
});
document.addEventListener('dragleave', e => e.target.closest?.('.drop')?.classList.remove('over'));
document.addEventListener('drop', async e => {
  const d = e.target.closest?.('.drop');
  if (!d) return;
  e.preventDefault();
  const c = byId('contacts', e.dataTransfer.getData('text/plain'));
  if (c && c.status !== d.dataset.status) await save('contacts', { ...c, status: d.dataset.status });
  render();
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

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
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
ui.cal = { items: [], key: '', loading: false, error: '' };
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
    await upgradeAll();
    await G.pushRemote(id, { version: M.SCHEMA_VERSION, syncedAt: Date.now(), ...Object.fromEntries(db.STORES.map(k => [k, S[k]])), tombs: S.tombs });
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
    <p class="muted">Synchronise le CRM entre tes appareils (via ton Drive) et importe les comptes rendus et enregistrements Meet.</p>
    <label>ID client Google (OAuth)<input id="gcid" value="${esc(localStorage.getItem('gcid') || '')}" placeholder="xxxx.apps.googleusercontent.com"></label>
    <p class="muted">${esc(status)}</p>
    ${G.configured() ? `<div class="row">${G.connected() ? '<button class="btn p" data-act="sync">Synchroniser</button><button class="btn" data-act="google-signout">Se déconnecter</button>' : '<button class="btn p" data-act="google-connect">Se connecter avec Google</button>'}</div>` : ''}</div>`;
}

// ---------- Google : planning ----------
const calKey = () => { const d = visibleDays(); return d[0] + '|' + d[d.length - 1]; };
async function fetchCal() {
  const key = calKey(), d = visibleDays();
  ui.cal.loading = true;
  try {
    const from = new Date(d[0] + 'T00:00'), to = new Date(d[d.length - 1] + 'T00:00');
    to.setDate(to.getDate() + 1);
    const items = await G.eventsBetween(from.toISOString(), to.toISOString());
    ui.cal.items = items
      .filter(e => e.status !== 'cancelled' && !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined'))
      .map(e => ({
        id: e.id, title: e.summary || '(Sans titre)', allDay: !e.start.dateTime,
        sd: e.start.date || '', ed: e.end?.date || '',
        start: e.start.dateTime || '', end: e.end?.dateTime || '',
        meet: e.hangoutLink || '', link: e.htmlLink, location: e.location || '',
        emails: (e.attendees || []).filter(a => !a.self).map(a => a.email),
        color: /^#[0-9a-f]{6}$/i.test(e._cal?.color || '') ? e._cal.color : '', cal: e._cal?.name || '',
      }));
    ui.cal.error = '';
  } catch (err) {
    ui.cal.items = [];
    ui.cal.error = err.message;
  } finally {
    ui.cal.key = key;
    ui.cal.loading = false;
    if (!(location.hash || '#/').replace('#/', '').split('/')[0]) safeRender();
  }
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
  if (!G.connected()) return back + '<div class="empty">Connecte-toi à Google pour voir tes réunions.<br><br><button class="btn p" data-act="google-connect">Se connecter avec Google</button></div>';
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
