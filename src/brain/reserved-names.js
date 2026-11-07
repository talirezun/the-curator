/**
 * src/brain/reserved-names.js — page names Windows keeps for devices.
 *
 * `entities\con.md` is the console, not a file: on Windows a write goes to a device
 * and a read can hang, and a wiki syncs to whichever computers its owner has. So The
 * Curator never CREATES such a page, on any system. A page already on disk is left
 * alone, whatever it is called, so a vault made elsewhere keeps working here.
 *
 * Windows looks only at the part before the first dot and ignores case, so `con`,
 * `CON` and `con.backup` are all the device. Superscript digits count too (COM¹).
 *
 * Reachable from mcp/: nothing here may write to stdout.
 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;

/** @param {string} slug a page name, with or without `.md` */
export function isWindowsReservedName(slug) {
  if (typeof slug !== 'string') return false;
  return RESERVED_NAME_RE.test(slug.split('.')[0].trimEnd());
}
