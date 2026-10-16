import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',      // fichier de synchro caché de l'appli
  'https://www.googleapis.com/auth/calendar.readonly',  // réunions
  'https://www.googleapis.com/auth/drive.readonly',     // lire les comptes rendus Gemini
].join(' ');
const FILE = 'crm-data.json';

export const clientId = () => localStorage.getItem('gcid') || GOOGLE_CLIENT_ID || '';
export const configured = () => !!clientId();

function stored() {
  try {
    const t = JSON.parse(localStorage.getItem('gtok'));
    return t && t.exp > Date.now() + 60000 ? t : null;
  } catch { return null; }
}
export const connected = () => !!stored();

let gis;
export function preload() {
  return (gis ||= new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => { gis = null; rej(new Error('Google injoignable (hors ligne ?)')); };
    document.head.appendChild(s);
  }));
}

// À appeler depuis un clic (fenêtre de connexion Google).
export async function signIn() {
  await preload();
  return new Promise((res, rej) => {
    const c = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        localStorage.setItem('gtok', JSON.stringify({ token: r.access_token, exp: Date.now() + r.expires_in * 1000 }));
        res(r.access_token);
      },
      error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'Connexion annulée' : e.message || e.type)),
    });
    c.requestAccessToken();
  });
}
export function signOut() {
  const t = stored();
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.token, () => {});
  localStorage.removeItem('gtok');
}

async function gfetch(url, opts = {}) {
  const t = stored();
  if (!t) throw new Error('Non connecté à Google');
  const r = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + t.token } });
  if (r.status === 401) { localStorage.removeItem('gtok'); throw new Error('Session Google expirée, reconnectez-vous'); }
  if (!r.ok) throw new Error(`Google ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return r;
}

// ---- synchro : un fichier JSON dans l'espace caché de l'appli sur Drive ----
export async function pullRemote() {
  const q = encodeURIComponent(`name='${FILE}'`);
  const l = await (await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
  const id = l.files?.[0]?.id;
  if (!id) return { id: null, data: null };
  return { id, data: await (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json() };
}
export async function pushRemote(id, data) {
  const body = JSON.stringify(data);
  if (id) return gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  const b = 'crmboundary';
  const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
  return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multipart });
}

// ---- réunions : événements récents avec pièces jointes (comptes rendus, enregistrements) ----
export async function recentEvents(days = 45) {
  const items = [];
  let pageToken = '';
  do {
    const u = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    u.search = new URLSearchParams({
      timeMin: new Date(Date.now() - days * 864e5).toISOString(),
      timeMax: new Date(Date.now() + 864e5).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      fields: 'nextPageToken,items(id,summary,start,attendees(email,self),attachments(fileId,title,mimeType,fileUrl))',
      ...(pageToken ? { pageToken } : {}),
    });
    const j = await (await gfetch(u)).json();
    items.push(...(j.items || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return items;
}
export async function docText(fileId) {
  return (await gfetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`)).text();
}

// ---- planning : événements de tous les agendas affichés dans Google Agenda ----
// (agenda principal + agendas ajoutés ou partagés et cochés dans « Mes agendas »)
async function visibleCalendars() {
  try {
    const j = await (await gfetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,selected,primary,backgroundColor)')).json();
    const cals = (j.items || []).filter(c => c.selected || c.primary).sort((a, b) => !!b.primary - !!a.primary).slice(0, 12);
    if (cals.length) return cals;
  } catch { /* repli sur l'agenda principal */ }
  return [{ id: 'primary', summary: '', primary: true }];
}
export async function eventsBetween(fromISO, toISO) {
  const cals = await visibleCalendars();
  const lists = await Promise.all(cals.map(async c => {
    try {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events`);
      u.search = new URLSearchParams({
        timeMin: fromISO, timeMax: toISO, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
        fields: 'items(id,iCalUID,summary,status,start,end,hangoutLink,htmlLink,location,attendees(email,self,responseStatus))',
      });
      const items = (await (await gfetch(u)).json()).items || [];
      return items.map(e => ({ ...e, _cal: { name: c.primary ? '' : c.summary, color: c.backgroundColor } }));
    } catch (err) {
      if (c.primary) throw err; // l'agenda principal doit fonctionner ; un agenda partagé en échec est ignoré
      return [];
    }
  }));
  const seen = new Set(), out = [];
  for (const e of lists.flat()) {
    const k = (e.iCalUID || e.id) + '|' + (e.start?.dateTime || e.start?.date);
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  }
  return out;
}
