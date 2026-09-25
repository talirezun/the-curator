// src/brain/domain-identity.js — each domain's RECORDED identity slot (v3.76.0)
//
// ONE DOMAIN, ONE COLOUR, AND IT STAYS PUT. The colour a domain wears on every
// screen and in the menubar widget used to be its POSITION in listDomains(),
// so deleting or adding a domain recoloured the ones after it. Now a domain's
// slot is recorded once, in a small file inside its own folder:
//
//     domains/<slug>/.curator-identity.json   {"slot": 3}
//
// WHY INSIDE THE DOMAIN FOLDER, weighed against the alternatives:
//   · a HASH of the slug needs no file and agrees across Macs, but with twelve
//     slots five domains collide more often than not (62%), and a rename would
//     change the colour. Rejected: two domains in one colour breaks the rule
//     the palette exists for.
//   · ONE map file (config, or domains/.curator-identity.json) is either not
//     synced (config is per-machine) or is one file every Mac edits at once —
//     a merge conflict waiting for two new domains on two machines.
//   · A file PER DOMAIN travels with a rename (the folder moves), rides GitHub
//     Sync (domains/ is the synced repo, and nothing in its .gitignore excludes
//     it), goes to the trash with a delete and comes back with a restore. Two
//     Macs that record the same domain write the same bytes, because the slot
//     comes from `resolveIdentitySlots`, which is deterministic.
//
// READS NEVER WRITE. `readDomainIdentities` is what every listing (the app's
// routes, the MCP, the menubar widget) calls, and it only reads. The app
// RECORDS with `recordDomainIdentities` at the moments a domain can appear:
// server start (a first run records every existing domain, in name order, which
// is the colour a sorted folder listing already gave), domain create, and after
// a GitHub Sync or Shared Brain pull. Until a domain is recorded its slot is
// still the deterministic resolution — the same on every screen.
//
// Never writes to stdout (it is reachable from mcp/).

import { readFile } from 'fs/promises';
import path from 'path';
import { listDomains, domainPath } from './files.js';
import { writeFileAtomic } from './atomic-write.js';
import { isValidIdentitySlot, resolveIdentitySlots } from './identity-palette.js';

export const IDENTITY_FILE = '.curator-identity.json';

/** The slot recorded in one domain's folder, or null (absent, unreadable, invalid). */
export async function readRecordedSlot(slug) {
  try {
    const raw = await readFile(path.join(domainPath(slug), IDENTITY_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    const s = parsed && typeof parsed === 'object' ? parsed.slot : null;
    return isValidIdentitySlot(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Every domain's identity slot (1-based), resolved from what is recorded.
 * `names` defaults to listDomains(). Returns `{ slots: Map, recorded: Map }`.
 * READ-ONLY.
 */
export async function readDomainIdentities(names) {
  const list = Array.isArray(names) ? names : await listDomains();
  const recorded = new Map();
  await Promise.all(list.map(async (n) => { recorded.set(n, await readRecordedSlot(n)); }));
  return { slots: resolveIdentitySlots(list, recorded), recorded };
}

/** A plain `{slug: slot}` object for a JSON response. READ-ONLY. */
export async function identityMap(names) {
  const { slots } = await readDomainIdentities(names);
  return Object.fromEntries(slots);
}

/**
 * Record every domain whose file is missing or disagrees with the resolution
 * (a slot another domain holds by rule 2). Idempotent: an install where every
 * domain is recorded writes nothing. Never throws; returns the slugs written.
 */
export async function recordDomainIdentities() {
  const written = [];
  try {
    const { slots, recorded } = await readDomainIdentities();
    for (const [slug, slot] of slots) {
      if (recorded.get(slug) === slot) continue;
      try {
        await writeFileAtomic(path.join(domainPath(slug), IDENTITY_FILE),
          JSON.stringify({ slot }) + '\n', 'utf8');
        written.push(slug);
      } catch (err) {
        console.error(`[domain-identity] could not record "${slug}": ${err && err.message}`);
      }
    }
  } catch (err) {
    console.error(`[domain-identity] record pass failed: ${err && err.message}`);
  }
  return written;
}
