// Three-way merge for KROFT's saved data, so two devices editing at once never lose each other's
// changes. Each area (finance, contacts, projects…) is saved as one JSON value; when a save finds
// that the server's copy changed since this device last saw it, the two versions are merged
// against the last version both had in common (base):
//
//   - objects: field by field;
//   - lists of items with an id (invoices, expenses, tasks, contacts…): item by item, so an item
//     added on either device is kept, an item deleted on one device is deleted unless the other
//     device changed it meanwhile (then the changed item is kept: data beats a delete), and an
//     item edited on both is merged field by field;
//   - lists of plain values (category names, linked ids): additions from both kept, removals from
//     both applied;
//   - a single value changed on both devices: this device's value wins, except numbers that both
//     raised (e.g. the next invoice number), which take the larger.
//
// Pure functions, no storage, so it's easy to test.

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const hasIds = arr => Array.isArray(arr) && arr.length > 0 && arr.every(x => isObj(x) && x.id != null);
const idList = (...arrs) => arrs.every(a => a === undefined || Array.isArray(a)) && arrs.some(hasIds) && arrs.every(a => !a || !a.length || hasIds(a));
const plainList = arr => Array.isArray(arr) && arr.every(x => x === null || ["string", "number", "boolean"].includes(typeof x));

export function merge3(base, local, remote) {
  if (same(local, remote)) return local;
  if (same(base, local)) return remote;   // only the other device changed it
  if (same(base, remote)) return local;   // only this device changed it

  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(b)])) {
      const v = merge3(b[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  if (Array.isArray(local) && Array.isArray(remote) && idList(base, local, remote)) return mergeById(Array.isArray(base) ? base : [], local, remote);
  if (plainList(local) && plainList(remote) && (base === undefined || plainList(base))) return mergeValues(base || [], local, remote);

  // Deleted on one side, changed on the other: keep the changed data.
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (typeof local === "number" && typeof remote === "number" && typeof base === "number" && local > base && remote > base) return Math.max(local, remote);
  return local;
}

function mergeById(base, local, remote) {
  const key = x => String(x.id);
  const B = new Map(base.map(x => [key(x), x]));
  const L = new Map(local.map(x => [key(x), x]));
  const R = new Map(remote.map(x => [key(x), x]));
  const pick = id => {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    if (l && r) return merge3(b, l, r);
    if (l && !r) return b && same(b, l) ? undefined : l;   // deleted elsewhere: gone, unless edited here
    if (r && !l) return b && same(b, r) ? undefined : r;   // deleted here: gone, unless edited elsewhere
    return undefined;
  };
  // This device's order, with items only the other device has placed after the item they follow there.
  const out = [];
  const placed = new Set();
  const put = id => { if (placed.has(id)) return; placed.add(id); const v = pick(id); if (v !== undefined) out.push(v); };
  const remoteOnly = remote.map(key).filter(id => !L.has(id));
  const after = new Map();   // id → remote-only ids that follow it in the remote list
  let prev = null;
  for (const id of remote.map(key)) {
    if (!L.has(id)) { if (!after.has(prev)) after.set(prev, []); after.get(prev).push(id); }
    else prev = id;
  }
  (after.get(null) || []).forEach(put);
  for (const id of local.map(key)) { put(id); (after.get(id) || []).forEach(put); }
  remoteOnly.forEach(put);
  return out;
}

function mergeValues(base, local, remote) {
  const removed = new Set([...base.filter(v => !local.includes(v)), ...base.filter(v => !remote.includes(v))]);
  return [...new Set([...local, ...remote])].filter(v => !removed.has(v) || (local.includes(v) && !base.includes(v)) || (remote.includes(v) && !base.includes(v)));
}
