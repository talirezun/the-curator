import { Router } from 'express';
import { listDomains, createDomain, deleteDomain, renameDomain, getDomainStats, generateUniqueSlug, isDomainReadonly } from '../brain/files.js';
import { isConfigured } from '../brain/sync.js';
import { isDomainActive, conflictResponse } from '../brain/write-registry.js';

const router = Router();

// GET /api/domains — list all domains
router.get('/', async (req, res) => {
  try {
    const domains = await listDomains();
    // v3.0.2: also report which domains are read-only Shared Brain
    // mirrors so the UI can exclude them from write-target dropdowns
    // (ingest). Additive field — older clients ignore it.
    const readonlyDomains = [];
    for (const d of domains) {
      if (await isDomainReadonly(d)) readonlyDomains.push(d);
    }
    res.json({ domains, readonlyDomains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/domains/stats — bulk stats for every domain in one call
// (additive, v3.1.x). Powers a sidebar/list view without one HTTP round
// trip per domain. MUST be registered before '/:domain/stats' would ever
// matter for a route with a matching segment count — it doesn't here
// ('/stats' is one segment, '/:domain/stats' is two) but the two are kept
// adjacent for readability.
//
// NO LLM AND NO NETWORK — but it is NOT free, and an earlier version of this
// comment claimed "no file-content reads, just readdir calls", which its own
// callee contradicts: getDomainStats reads each domain's CLAUDE.md, and
// reads wiki/log.md to find the newest ingest date. On the maintainer's tree
// that was 598 KB per request, and THIS ENDPOINT IS POLLED — the /next
// first-run guide re-checks it for as long as it is open. A comment
// asserting a cost profile the code does not have is what let that sit
// unnoticed; the real profile is one readdir walk of wiki/ per domain, one
// small CLAUDE.md read, and a stat of log.md that only turns into a read
// when the log has actually changed (see lastIngestDate in files.js).
//
// `readonly` now comes OUT of each domain's stats rather than from a second
// isDomainReadonly() pass over the same CLAUDE.md files — that pass doubled
// this endpoint's CLAUDE.md reads for a flag getDomainStats already had in
// hand. isDomainReadonly is still imported and still used, for the single
// domain on GET /api/domains and as the fallback below.
//
// Each domain's stats are individually try/caught so one domain with a
// missing/partial wiki/ folder can never take down the whole response;
// getDomainStats already degrades every sub-read to a safe default
// (0 / null / not-readonly), so this is a defensive second layer, not the
// only one. That layer is why the fallback exists: a stats entry that FAILED
// carries no readonly flag, and silently treating "we could not tell" as
// "writable" on a mirror is the wrong direction — so those (and only those)
// domains are asked directly, which is what every domain used to cost.
// readonlyDomains stays exactly as distinguishable here as on GET /api/domains.
router.get('/stats', async (req, res) => {
  try {
    const domains = await listDomains();
    const statsList = await Promise.all(domains.map(d =>
      getDomainStats(d).catch(err => ({ slug: d, error: err.message }))
    ));
    const readonlyDomains = [];
    for (let i = 0; i < domains.length; i++) {
      const s = statsList[i];
      const flag = (s && typeof s.readonly === 'boolean')
        ? s.readonly
        : await isDomainReadonly(domains[i]);
      if (flag) readonlyDomains.push(domains[i]);
    }
    res.json({ domains: statsList, readonlyDomains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/domains/:domain/stats — domain stats (MUST be before /:domain handlers)
//
// The `domain` param is checked against listDomains() before it reaches the
// filesystem (v3.2.0 audit finding L1). Express URL-decodes route params, so
// `GET /api/domains/%2e%2e/stats` arrived here as the literal string ".."
// and getDomainStats happily read `<domainsDir>/../CLAUDE.md` — returning
// 200 and leaking the first heading of a CLAUDE.md outside the domains
// folder as `displayName`. Every other route on this router already gates
// on a real domain (the bulk /stats route above only ever passes
// listDomains() output); this one was the outlier. An allow-list is used
// rather than a character blacklist because the set of valid values is
// small, known, and already computed.
router.get('/:domain/stats', async (req, res) => {
  try {
    const { domain } = req.params;
    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }
    const stats = await getDomainStats(domain);
    res.json(stats);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/domains — create a new domain
router.post('/', async (req, res) => {
  try {
    const { displayName, description = '', template = 'generic' } = req.body;
    if (!displayName?.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }
    const validTemplates = ['tech', 'business', 'personal', 'generic'];
    if (!validTemplates.includes(template)) {
      return res.status(400).json({ error: 'Invalid template' });
    }

    const slug = await generateUniqueSlug(displayName.trim());
    await createDomain(slug, displayName.trim(), description.trim(), template);
    res.status(201).json({ slug, displayName: displayName.trim() });
  } catch (err) {
    const status = err.message.includes('already exists') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// PUT /api/domains/:domain — rename a domain
router.put('/:domain', async (req, res) => {
  // Refuse to rename a domain that has an active write. Verified empirically,
  // and the failure is silent rather than loud: renameDomain() moves the
  // directory with rename(2), but an in-flight ingest rebuilds its paths PER
  // PAGE from the slug it captured at request time (wikiPath() calls
  // getDomainsDir() on every call — the v3.1.0 per-call invariant), so it keeps
  // writing to the OLD path. writePage() does `mkdir(dir, {recursive:true})`
  // (files.js:999), so instead of failing it RECREATES the old directory and
  // writes the document's remaining pages into it. That ghost has no
  // CLAUDE.md, so listDomains() filters it out (the v2.3.4 ghost-domain rule)
  // and those pages are invisible in every UI surface — Domains, Wiki, Health,
  // chat retrieval and the MCP alike. The ingest then dies at appendLog() with
  // a raw ENOENT, after the spend and after the pages are on disk.
  //
  // Predicate is per-domain (isDomainActive), matching the DELETE handler
  // below rather than the global hasActiveWrites(): a rename affects exactly
  // one domain, so blocking it because an unrelated domain is busy would be
  // broader than the harm.
  //
  // Guards BOTH branches, not just the slug-changing one: a display-name-only
  // rename still rewrites log.md's header via writeFileAtomic, which races
  // appendLog() writing the same file at the end of an ingest.
  if (isDomainActive(req.params.domain)) {
    const { status, body } = conflictResponse(`rename domain "${req.params.domain}"`);
    return res.status(status).json(body);
  }
  try {
    const oldSlug = req.params.domain;
    const { displayName } = req.body;
    if (!displayName?.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    const newSlug = await generateUniqueSlug(displayName.trim(), oldSlug);

    if (newSlug === oldSlug) {
      // Only display name changed, not slug — just update the display name in files
      await renameDomain(oldSlug, oldSlug, displayName.trim());
      return res.json({ oldSlug, newSlug: oldSlug, displayName: displayName.trim(), syncWarning: false });
    }

    await renameDomain(oldSlug, newSlug, displayName.trim());
    res.json({ oldSlug, newSlug, displayName: displayName.trim(), syncWarning: isConfigured() });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already exists') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/domains/:domain — delete a domain
router.delete('/:domain', async (req, res) => {
  // v3.0.1-beta.8: refuse to delete a domain that has an active write
  // operation. The `rm -rf` of the domain folder would race the ingest's
  // writePage calls and produce undefined behaviour.
  if (isDomainActive(req.params.domain)) {
    const { status, body } = conflictResponse(`delete domain "${req.params.domain}"`);
    return res.status(status).json(body);
  }
  try {
    await deleteDomain(req.params.domain);
    res.json({ deleted: true, syncWarning: isConfigured() });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
