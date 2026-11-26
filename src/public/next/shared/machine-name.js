// shared/machine-name.js — a computer's NAME as a person reads it (v4.2.0 fix,
// e2e A confusion 7: "Machine names are raw ids (saved on studio-mac-aa11bb)").
//
// A machine folder is `<hostname-slug>-<install-id>` (src/brain/working-state.js,
// D9): the install id is what keeps two Macs with one default hostname apart
// on disk, and it is not the interesting half for a reader. Context shows the
// HOST part — the same display the menu-bar widget has always used
// (desktop/lib/tray-model.js `hostPart` / `shortMachineNames`, which
// scripts/test-machine-name.js cross-checks this copy against) — and adds a
// short tag only when two computers on screen share a host part.
//
// The id is stripped only when its last hyphen-segment LOOKS like one (4+ hex
// characters and nothing else): `build-box` keeps both words. The raw id stays
// in every data attribute, route and file — this is display only.
//
// DOM-free (imported by src/brain/setup-check.js for its sentences, and by the
// views); pure.

/** The host part of a machine folder name, or the name as it is. */
export function hostPart(machine) {
  if (typeof machine !== 'string' || !machine) return null;
  const i = machine.lastIndexOf('-');
  if (i <= 0) return machine;
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? machine.slice(0, i) : machine;
}

function installTag(machine) {
  if (typeof machine !== 'string') return '';
  const i = machine.lastIndexOf('-');
  if (i <= 0) return '';
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? tail.slice(0, 4) : '';
}

/**
 * Short names for the machines a screen shows, disambiguated only where two
 * DISTINCT machines share a host part (`studio-mac·aa11`). A Map raw → name.
 */
export function shortMachineNames(machines) {
  const list = (Array.isArray(machines) ? machines : []).filter((m) => typeof m === 'string' && m);
  const distinct = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    if (!distinct.has(h)) distinct.set(h, new Set());
    distinct.get(h).add(m);
  }
  const out = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    const tag = installTag(m);
    out.set(m, distinct.get(h).size > 1 && tag ? h + '·' + tag : h);
  }
  return out;
}

/** One machine's display name among `others` (the machines on the same screen). */
export function machineDisplayName(machine, others = []) {
  if (typeof machine !== 'string' || !machine) return machine;
  return shortMachineNames([machine, ...(Array.isArray(others) ? others : [])]).get(machine) || machine;
}
