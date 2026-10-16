// Modèle de données portable. Aucune dépendance au DOM : tout est testable et réutilisable.
//
// Stockage (IndexedDB) : contacts, tasks, notes, docs, tombs (voir DATA-MODEL.md).
// Export : on traduit ce stockage vers un modèle canonique proche de HubSpot
//          (sociétés / contacts / affaires / activités / tâches), puis vers des CSV d'import.

export const SCHEMA_VERSION = 3;

// Étapes du pipeline. `label` est la valeur stockée ; le reste sert uniquement aux exports.
// dealstage = identifiants internes du pipeline HubSpot par défaut (à adapter si le portail est personnalisé).
export const STAGES = [
  { key: 'new',               label: 'Nouveau',             lifecycle: 'lead',        leadStatus: 'NEW',         dealstage: null },
  { key: 'contacted',         label: 'Contacté',            lifecycle: 'lead',        leadStatus: 'IN_PROGRESS', dealstage: null },
  { key: 'meeting_scheduled', label: 'RDV planifié',        lifecycle: 'opportunity', leadStatus: 'OPEN_DEAL',   dealstage: 'appointmentscheduled' },
  { key: 'proposal_sent',     label: 'Proposition envoyée', lifecycle: 'opportunity', leadStatus: 'OPEN_DEAL',   dealstage: 'contractsent' },
  { key: 'won',               label: 'Gagné',               lifecycle: 'customer',    leadStatus: '',            dealstage: 'closedwon',  closed: true, won: true },
  { key: 'lost',              label: 'Perdu',               lifecycle: 'other',       leadStatus: 'UNQUALIFIED', dealstage: 'closedlost', closed: true },
];
export const ENTITIES = ['France', 'Togo'];       // entité qui facture (ajouter « SASU » le moment venu)
export const CURRENCIES = ['EUR', 'XOF'];
const CHANNEL_TYPE = { 'WhatsApp': 'whatsapp', 'Google Meet': 'meeting', 'En personne': 'meeting', 'Appel': 'call', 'Email': 'email' };
export const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|orange|wanadoo|free|sfr|laposte|neuf|bbox|proton|protonmail|gmx|aol)\./i;

export const stageOf = label => STAGES.find(s => s.label === label) || STAGES[0];

// ---------- normalisation (appliquée à l'enregistrement) ----------
export function isoFrom(v) {
  if (!v) return '';
  if (typeof v === 'number') return new Date(v).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T12:00:00.000Z';   // midi UTC : évite les décalages de date
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}
export function splitName(name) {
  const t = (name || '').trim().split(/\s+/).filter(Boolean);
  if (t.length <= 1) return { firstName: '', lastName: t[0] || '' };
  return { firstName: t.slice(0, -1).join(' '), lastName: t[t.length - 1] };
}
// Chiffres du numéro avec indicatif pays, sans « + » (format wa.me). cc = indicatif par défaut.
export function intlDigits(p, cc = '33') {
  if (!p) return '';
  const plus = p.trim().startsWith('+');
  const d = p.replace(/\(0\)/g, '').replace(/\D/g, '');      // ignore le (0) de « +33 (0)6… »
  if (plus) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return cc + d.slice(1);
  return d;
}
export function toE164(p, cc = '33') {
  const d = intlDigits(p, cc);
  return d.length >= 8 && d.length <= 15 ? '+' + d : '';
}
export function normalizeContact(c, cc = '33') {
  const o = { ...c };
  if (!o.firstName && !o.lastName && o.name) Object.assign(o, splitName(o.name));
  o.firstName = (o.firstName || '').trim();
  o.lastName = (o.lastName || '').trim();
  o.name = `${o.firstName} ${o.lastName}`.trim();
  o.email = (o.email || '').trim().toLowerCase();
  o.phoneE164 = toE164(o.phone, cc);
  o.currency = o.currency || 'EUR';
  o.createdAt = isoFrom(o.createdAt) || isoFrom(o.updatedAt) || new Date().toISOString();
  return o;
}
// Met un enregistrement au format courant (idempotent). Ne touche pas à updatedAt.
export function upgradeRecord(store, r, cc = '33') {
  if (store === 'contacts') return normalizeContact(r, cc);
  if (store === 'companies') return normalizeCompany(r);
  if (store === 'tombs') return r;
  const created = isoFrom(r.createdAt) || (store === 'tasks' ? '' : isoFrom(r.date)) || isoFrom(r.updatedAt) || new Date().toISOString();
  return r.createdAt === created ? r : { ...r, createdAt: created };
}

export function cleanDomain(d) {
  return (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
}
export function normalizeCompany(c) {
  const o = { ...c };
  o.name = (o.name || '').trim();
  o.domain = cleanDomain(o.domain);
  o.employees = o.employees === '' || o.employees == null ? '' : (Number(o.employees) || '');
  o.createdAt = isoFrom(o.createdAt) || isoFrom(o.updatedAt) || new Date().toISOString();
  return o;
}
// Une affaire existe dès « RDV planifié » ou dès qu'un montant est saisi.
export const hasDeal = c => !!stageOf(c.status).dealstage || (c.amount || 0) > 0;

// ---------- identifiants stables ----------
function hash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519); }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}
export const coId = name => 'co_' + hash(name.trim().toLowerCase());

// ---------- modèle canonique ----------
export function toCanonical(S, { cc = '33' } = {}) {
  const contacts = S.contacts.map(c => normalizeContact(c, cc));
  const warnings = [];

  // sociétés : celles de la base, plus (par sécurité) celles déduites de contacts non rattachés
  const companies = new Map();
  for (const raw of S.companies || []) {
    const co = normalizeCompany(raw);
    companies.set(co.id, { id: co.id, name: co.name, domain: co.domain, phone: co.phone || '', industry: co.industry || '', city: co.city || '', country: co.country || '',
      employees: co.employees, description: co.notes || '', driveFolderUrl: co.driveUrl || '', createdAt: co.createdAt, updatedAt: isoFrom(co.updatedAt) || co.createdAt, externalIds: co.ext || {} });
  }
  const companyIdOf = c => {
    if (c.companyId && companies.has(c.companyId)) return c.companyId;
    const nm = (c.company || '').trim();
    if (!nm) return '';
    const id = coId(nm);
    if (!companies.has(id)) companies.set(id, { id, name: nm, domain: '', phone: '', industry: '', city: '', country: '', employees: '', description: '', driveFolderUrl: '', createdAt: c.createdAt, updatedAt: c.createdAt, externalIds: {} });
    return id;
  };
  for (const c of contacts) {
    const co = companies.get(companyIdOf(c)), dom = c.email.split('@')[1] || '';
    if (co && !co.domain && dom && !FREE_MAIL.test(dom)) co.domain = dom;
  }

  const outContacts = contacts.map(c => {
    const st = stageOf(c.status);
    if (!c.email) warnings.push(`Contact sans email : ${c.name} (rattachement manuel à prévoir lors de l'import)`);
    return {
      id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone || '', phoneE164: c.phoneE164,
      jobTitle: c.jobTitle || '', companyId: companyIdOf(c), companyName: companies.get(companyIdOf(c))?.name || c.company || '',
      lifecycleStage: st.lifecycle, leadStatus: st.leadStatus, stage: st.key, source: c.source || '',
      entity: c.entity || '', driveFolderUrl: c.driveUrl || '', notes: c.notes || '',
      createdAt: c.createdAt, updatedAt: isoFrom(c.updatedAt) || c.createdAt, externalIds: c.ext || {},
    };
  });

  // affaires : une par contact qui a atteint un RDV ou qui porte un montant
  const lastAct = new Map();
  for (const n of S.notes) if (!lastAct.get(n.contactId) || n.date > lastAct.get(n.contactId)) lastAct.set(n.contactId, n.date);
  const deals = [];
  for (const c of contacts) {
    const st = stageOf(c.status);
    if (!st.dealstage && !(c.amount > 0)) continue;
    const dealstage = st.dealstage || 'appointmentscheduled';
    deals.push({
      id: 'deal_' + c.id, name: `${c.company || c.name} — ${c.name}`.slice(0, 120), contactId: c.id, companyId: companyIdOf(c),
      stage: st.key, hubspotStage: dealstage, pipeline: 'default', amount: c.amount || 0, currency: c.currency,
      entity: c.entity || '', isClosed: !!st.closed, isWon: !!st.won,
      closeDate: st.closed ? isoFrom(lastAct.get(c.id) || c.lastContact || c.updatedAt) : '',
      createdAt: c.createdAt, updatedAt: isoFrom(c.updatedAt) || c.createdAt, externalIds: {},
    });
  }
  const dealOf = new Map(deals.map(d => [d.contactId, d.id]));

  const activities = S.notes.map(n => ({
    id: n.id, type: CHANNEL_TYPE[n.channel] || 'note', channel: n.channel, contactId: n.contactId, dealId: dealOf.get(n.contactId) || '',
    occurredAt: isoFrom(n.date), subject: n.channel || 'Note', body: n.text || '', createdAt: isoFrom(n.createdAt) || isoFrom(n.date), externalIds: {},
  }));
  const tasks = S.tasks.map(t => ({
    id: t.id, contactId: t.contactId, dealId: dealOf.get(t.contactId) || '', subject: t.text, dueDate: isoFrom(t.due),
    status: t.done ? 'done' : 'open', completedAt: t.done ? isoFrom(t.doneAt || t.due) : '', priority: 'medium',
    createdAt: isoFrom(t.createdAt) || isoFrom(t.updatedAt), externalIds: {},
  }));
  const documents = S.docs.map(d => ({
    id: d.id, contactId: d.contactId, title: d.title, url: d.url, kind: d.kind || 'file', createdAt: isoFrom(d.createdAt) || isoFrom(d.date), externalIds: {},
  }));

  return {
    schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), source: { app: 'mon-crm', countryCodeDefault: cc },
    companies: [...companies.values()], contacts: outContacts, deals, activities, tasks, documents, warnings,
  };
}

// ---------- CSV ----------
export function csv(headers, rows) {
  const cell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.map(cell).join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))].join('\r\n') + '\r\n';
}

// CSV prêts pour l'import HubSpot (noms internes de propriétés). Les colonnes `mon_crm_*` sont des
// propriétés personnalisées à créer (ou à mapper) pendant l'import ; `mon_crm_id` permet de mettre à jour sans doublon.
export function hubspotFiles(C) {
  const emailOf = new Map(C.contacts.map(c => [c.id, c.email]));
  const assoc = id => ({ associated_contact_email: emailOf.get(id) || '', associated_contact_mon_crm_id: id });
  const files = {};
  // `industry` est une liste fermée dans HubSpot : le secteur saisi va dans une propriété personnalisée.
  files['1-societes.csv'] = csv(['mon_crm_id', 'name', 'domain', 'phone', 'city', 'country', 'numberofemployees', 'description', 'mon_crm_secteur', 'mon_crm_dossier_drive'],
    C.companies.map(c => ({ mon_crm_id: c.id, name: c.name, domain: c.domain, phone: c.phone, city: c.city, country: c.country, numberofemployees: c.employees,
      description: c.description, mon_crm_secteur: c.industry, mon_crm_dossier_drive: c.driveFolderUrl })));
  files['2-contacts.csv'] = csv(
    ['mon_crm_id', 'firstname', 'lastname', 'email', 'phone', 'jobtitle', 'company', 'lifecyclestage', 'hs_lead_status', 'mon_crm_source', 'mon_crm_entite', 'mon_crm_dossier_drive'],
    C.contacts.map(c => ({ mon_crm_id: c.id, firstname: c.firstName, lastname: c.lastName, email: c.email, phone: c.phoneE164 || c.phone, jobtitle: c.jobTitle,
      company: c.companyName, lifecyclestage: c.lifecycleStage, hs_lead_status: c.leadStatus, mon_crm_source: c.source, mon_crm_entite: c.entity, mon_crm_dossier_drive: c.driveFolderUrl })));
  files['3-affaires.csv'] = csv(
    ['mon_crm_id', 'dealname', 'pipeline', 'dealstage', 'amount', 'deal_currency_code', 'closedate', 'mon_crm_entite', 'associated_contact_email', 'associated_contact_mon_crm_id', 'associated_company_name'],
    C.deals.map(d => ({ mon_crm_id: d.id, dealname: d.name, pipeline: d.pipeline, dealstage: d.hubspotStage, amount: d.amount, deal_currency_code: d.currency, closedate: d.closeDate,
      mon_crm_entite: d.entity, ...assoc(d.contactId), associated_company_name: C.contacts.find(c => c.id === d.contactId)?.companyName || '' })));

  const body = a => a.body;
  const notes = [], calls = [], meetings = [];
  for (const c of C.contacts) {
    if (c.notes) notes.push({ mon_crm_id: 'note_' + c.id, hs_timestamp: c.createdAt, hs_note_body: 'Notes de la fiche contact :\n' + c.notes, ...assoc(c.id) });
  }
  for (const a of C.activities) {
    if (a.type === 'call') calls.push({ mon_crm_id: a.id, hs_timestamp: a.occurredAt, hs_call_title: a.subject, hs_call_body: body(a), hs_call_status: 'COMPLETED', ...assoc(a.contactId) });
    else if (a.type === 'meeting') meetings.push({ mon_crm_id: a.id, hs_timestamp: a.occurredAt, hs_meeting_title: a.subject, hs_meeting_body: body(a), hs_meeting_start_time: a.occurredAt, hs_meeting_outcome: 'COMPLETED', ...assoc(a.contactId) });
    else notes.push({ mon_crm_id: a.id, hs_timestamp: a.occurredAt, hs_note_body: (a.type === 'note' ? '' : `[${a.channel}] `) + body(a), ...assoc(a.contactId) });
  }
  for (const d of C.documents) notes.push({ mon_crm_id: d.id, hs_timestamp: d.createdAt, hs_note_body: `Document : ${d.title}\n${d.url}`, ...assoc(d.contactId) });
  files['4-notes.csv'] = csv(['mon_crm_id', 'hs_timestamp', 'hs_note_body', 'associated_contact_email', 'associated_contact_mon_crm_id'], notes);
  files['5-appels.csv'] = csv(['mon_crm_id', 'hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_call_status', 'associated_contact_email', 'associated_contact_mon_crm_id'], calls);
  files['6-reunions.csv'] = csv(['mon_crm_id', 'hs_timestamp', 'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_outcome', 'associated_contact_email', 'associated_contact_mon_crm_id'], meetings);
  files['7-taches.csv'] = csv(['mon_crm_id', 'hs_timestamp', 'hs_task_subject', 'hs_task_status', 'hs_task_priority', 'hs_task_type', 'associated_contact_email', 'associated_contact_mon_crm_id'],
    C.tasks.map(t => ({ mon_crm_id: t.id, hs_timestamp: t.dueDate, hs_task_subject: t.subject, hs_task_status: t.status === 'done' ? 'COMPLETED' : 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO', ...assoc(t.contactId) })));

  files['LISEZ-MOI.txt'] = [
    `Export Mon CRM vers HubSpot - ${C.exportedAt.slice(0, 10)}`,
    '',
    `${C.companies.length} sociétés, ${C.contacts.length} contacts, ${C.deals.length} affaires, ${notes.length} notes, ${calls.length} appels, ${meetings.length} réunions, ${C.tasks.length} tâches.`,
    '',
    "ORDRE D'IMPORT (HubSpot > Importer) : 1 sociétés, 2 contacts, 3 affaires, puis les activités 4 à 7.",
    "Avant l'import, créer les propriétés personnalisées : mon_crm_id (texte, valeur unique) sur chaque objet,",
    'mon_crm_source, mon_crm_entite, mon_crm_dossier_drive sur les contacts, mon_crm_secteur et mon_crm_dossier_drive sur les sociétés, mon_crm_entite sur les affaires.',
    "Les colonnes associated_contact_email / associated_contact_mon_crm_id servent à rattacher affaires et activités à leur contact :",
    "les mapper sur les colonnes d'association proposées par l'assistant d'import.",
    "Les étapes d'affaire (dealstage) correspondent au pipeline par défaut de HubSpot ; si votre pipeline est personnalisé, adaptez la colonne.",
    'Les fichiers joints ne sont pas exportés : les liens Drive sont conservés dans les notes.',
    '',
    C.warnings.length ? 'POINTS D\'ATTENTION :\n- ' + C.warnings.join('\n- ') : "Aucun point d'attention.",
  ].join('\n');
  return files;
}

// CSV générique (Pipedrive, Zoho, Salesforce... : mapper les colonnes à l'import)
export function genericContactsCsv(C) {
  const H = ['Prénom', 'Nom', 'Email', 'Téléphone', 'Poste', 'Entreprise', 'Étape', 'Montant', 'Devise', 'Entité', 'Source', 'Dossier Drive', 'Créé le'];
  const stageLabel = k => STAGES.find(s => s.key === k)?.label || k;
  const dealOf = new Map(C.deals.map(d => [d.contactId, d]));
  return csv(H, C.contacts.map(c => ({
    'Prénom': c.firstName, 'Nom': c.lastName, 'Email': c.email, 'Téléphone': c.phoneE164 || c.phone, 'Poste': c.jobTitle, 'Entreprise': c.companyName,
    'Étape': stageLabel(c.stage), 'Montant': dealOf.get(c.id)?.amount ?? '', 'Devise': dealOf.get(c.id)?.currency ?? '', 'Entité': c.entity, 'Source': c.source,
    'Dossier Drive': c.driveFolderUrl, 'Créé le': c.createdAt.slice(0, 10),
  })));
}

// ---------- ZIP minimal (sans compression) ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export function zipBytes(files) {                  // files : { nom: texte }
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255], u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of Object.entries(files)) {
    const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0)];
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...common, ...nm]);
    parts.push(local, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nm]));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0), n = Object.keys(files).length;
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(n), ...u16(n), ...u32(cdSize), ...u32(offset), 0, 0]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((t, a) => t + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
export const zip = files => new Blob([zipBytes(files)], { type: 'application/zip' });
