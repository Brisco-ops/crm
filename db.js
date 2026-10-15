// Couche de stockage (IndexedDB). Remplaçable plus tard par une synchro cloud.
const STORES = ['contacts', 'tasks', 'notes', 'docs'];
let dbp;

function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('crm', 1);
    r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s, { keyPath: 'id' }));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  });
}

export const all = s => tx(s, 'readonly', o => o.getAll());
export const put = (s, v) => tx(s, 'readwrite', o => o.put(v));
export const del = (s, id) => tx(s, 'readwrite', o => o.delete(id));
export const clear = s => tx(s, 'readwrite', o => o.clear());
export { STORES };
