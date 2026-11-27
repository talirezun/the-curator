// src/routes/kit-page.js — the DEV-ONLY kit page (kit v1, 2026-11-27).
//
// /next/kit.html and /next/kit.js render every part of the shared kit in both
// themes (phase 0's acceptance picture for the Simple/Pro redesign). They
// live in src/dev/kit/, OUTSIDE src/public/, so the static mount can never
// serve them: these two routes are the only way in, and they answer ONLY when
// CURATOR_KIT_PAGE=1 is set in the server's environment:
//
//   CURATOR_KIT_PAGE=1 npm start   →  http://localhost:3333/next/kit.html
//
// WHY AN ENV FLAG ALONE, NOT "REPO MODE OR A FLAG" (the contract's wording;
// amended by the builder): a route may not branch on the install FORM in this
// repo (scripts/test-install-mode.js — `isRepoInstall()` is a negation of a
// negation, and a third install form would silently inherit the arm), and
// "repo mode" is also every real user who installed with install.sh. A flag
// nobody sets by accident is the stricter gate. Without it both paths are a
// plain 404 in every install, and nothing in the app links to them. The page fetches
// nothing and writes nothing: synthetic data, the shared modules, the tokens.
//
// Mounted in src/server.js below the Host and cross-origin guards.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.join(__dirname, '..', 'dev', 'kit');

/** Whether the kit page is served. Pure over its inputs (a test seam). */
export function kitPageAllowed({ env = process.env } = {}) {
  return !!env && env.CURATOR_KIT_PAGE === '1';
}

const router = express.Router();

const FILES = { '/next/kit.html': 'kit.html', '/next/kit.js': 'kit.js' };
for (const [route, file] of Object.entries(FILES)) {
  router.get(route, (req, res) => {
    if (!kitPageAllowed()) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(KIT_DIR, file));
  });
}

export default router;
