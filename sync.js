// Fusion de deux jeux de données : dernier modifié gagne, par enregistrement. Fonction pure.
const TOMB_TTL = 90 * 864e5;

export function merge(local, remote, stores, now = Date.now()) {
  const tombs = new Map();
  for (const t of [...(local.tombs || []), ...(remote?.tombs || [])]) {
    const o = tombs.get(t.id);
    if (!o || t.at > o.at) tombs.set(t.id, t);
  }
  const out = {};
  for (const k of stores) {
    const m = new Map();
    for (const r of [...(local[k] || []), ...(remote?.[k] || [])]) {
      const o = m.get(r.id);
      if (!o || (r.updatedAt || 0) > (o.updatedAt || 0)) m.set(r.id, r);
    }
    for (const [id, r] of m) {
      const t = tombs.get(id);
      if (t && t.at >= (r.updatedAt || 0)) m.delete(id);
    }
    out[k] = [...m.values()];
  }
  out.tombs = [...tombs.values()].filter(t => t.at > now - TOMB_TTL);
  return out;
}
