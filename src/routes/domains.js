import { Router } from 'express';
import { existsSync } from 'fs';
import { listDomains, createDomain, deleteDomain, renameDomain, getDomainStats, generateUniqueSlug, isDomainReadonly, domainPath, countRawSources } from '../brain/files.js';
import { isConfigured } from '../brain/sync.js';
import { listProjects } from '../brain/working-state.js';
import { getTrashDir } from '../brain/paths.js';
import { isDomainActive, conflictResponse } from '../brain/write-registry.js';
import { identityMap, recordDomainIdentities } from '../brain/domain-identity.js';
import { readHealthSummaries, forgetHealthSummary, renameHealthSummary } from '../brain/health-summary.js';

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
    // v3.76.0: each domain's RECORDED identity slot (1-based), `{slug: slot}`.
    // The one mapping every view paints a domain's colour from — never the
    // domain's position in `domains` (src/brain/domain-identity.js).
    const identity = await identityMap(domains);
    res.json({ domains, readonlyDomains, identity });
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
    // v3.76.0: the identity slot rides each row as `identitySlot`, and the
    // whole map as `identity`, from the same one read.
    const identity = await identityMap(domains);
    // v3.77: the last Wiki health scan per domain, persisted across restarts
    // (src/brain/health-summary.js). `health` is null for a domain never
    // scanned on this machine; `stale` is true when the wiki changed after it.
    const health = await readHealthSummaries(domains);
    for (let i = 0; i < domains.length; i++) {
      const s = statsList[i];
      if (s && typeof s === 'object') {
        statsList[i] = { ...s, identitySlot: identity[domains[i]] ?? null, health: health[domains[i]] || null };
      }
    }
    res.json({ domains: statsList, readonlyDomains, identity });
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
    // v3.76.0: a single-row refresh carries the same identity slot the list
    // did, or the patched row would lose its colour.
    const identity = await identityMap(domains);
    const health = await readHealthSummaries([domain]);
    res.json({ ...stats, identitySlot: identity[domain] ?? null, health: health[domain] || null });
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
    // Record the new domain's colour now (the lowest free slot), so it is
    // fixed before any screen paints it. Never throws.
    await recordDomainIdentities();
    res.status(201).json({ slug, displayName: displayName.trim() });
  } catch (err) {
    // 'reserved' — the shared-* namespace guard in files.js. A user-fixable
    // input problem, so a 400 like the other two, not a 500.
    const status = err.message.includes('already exists') || err.message.includes('Invalid')
      || err.message.includes('reserved') ? 400 : 500;
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
    await renameHealthSummary(oldSlug, newSlug);
    res.json({ oldSlug, newSlug, displayName: displayName.trim(), syncWarning: isConfigured() });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already exists') || err.message.includes('Invalid')
                   || err.message.includes('reserved') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/domains/:domain/delete-preview — what a delete would take (v3.73.0)
//
// Read when the Delete confirm OPENS, so every figure it quotes is the one on
// disk at that moment (the v3.72.1 F1 rule, extended from pages to the rest):
// pages, conversations, raw sources, projects with working state. Also says
// where the domain will go (the trash) and whether Sync is configured, which
// decides whether the delete propagates to GitHub. Not polled, and not folded
// into /stats: the raw walk and the project scan are one-off costs, paid once
// per confirm, never per poll.
router.get('/:domain/delete-preview', async (req, res) => {
  try {
    const { domain } = req.params;
    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(404).json({ error: `Unknown domain: ${domain}` });
    }
    // A figure that cannot be read is `null` (shown as nothing), never 0 —
    // "0 raw sources" over a folder we failed to read is a false promise.
    const [stats, rawSources, projects] = await Promise.all([
      getDomainStats(domain),
      countRawSources(domain).catch(() => null),
      listProjects(domain).then((r) => (r && r.ok ? r.total : null)).catch(() => null),
    ]);
    res.json({
      slug: domain,
      displayName: stats.displayName,
      readonly: !!stats.readonly,
      pageCount: stats.pageCount,
      conversationCount: stats.conversationCount,
      rawSources,
      projects,
      trashDir: getTrashDir(),
      syncConfigured: isConfigured(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/domains/:domain — delete a domain (v3.73.0: confirmed, recoverable)
//
// TYPED CONFIRMATION, at the ROUTE and not only in the view — the rule the
// project route (routes/memory.js) has stated since it shipped: "A
// confirmation that lives only in a view is a confirmation any other client
// skips." Until v3.73.0 this route took none, and the domain was `rm -rf`'d;
// on 2026-09-25 that lost the maintainer's `projects` domain to one click.
//
// Body: `{ "confirm": "<slug>" }` — the folder name, exactly. The SLUG and not
// the display name, because it is the thing that is deleted (`domains/<slug>/`),
// it is unique where display names need not be, it has no case, whitespace or
// Unicode-normalisation ambiguity to argue about, and it is what the confirm
// shows next to the input. Anything else is a 400 `confirm_required`, in the
// project route's shape, and nothing on disk changes.
//
// The folder is MOVED to the trash (see deleteDomain in files.js), and the
// response names where: `{ deleted, trashPath, syncWarning }`.
router.delete('/:domain', async (req, res) => {
  const domain = req.params.domain;
  if (!domain || domain.includes('..') || domain.includes('/') || domain.includes('\\') || domain.startsWith('.')) {
    return res.status(400).json({ error: 'Invalid domain name' });
  }
  if (!existsSync(domainPath(domain))) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  const confirm = req.body && typeof req.body.confirm === 'string' ? req.body.confirm : '';
  if (confirm !== domain) {
    return res.status(400).json({
      ok: false, reason: 'confirm_required',
      error: `Type the domain's folder name to confirm. Expected "${domain}".`,
    });
  }
  // v3.0.1-beta.8: refuse to delete a domain that has an active write
  // operation in THIS process; deleteDomain() takes the cross-process file
  // lock for writes in another one (the MCP).
  if (isDomainActive(domain)) {
    const { status, body } = conflictResponse(`delete domain "${domain}"`);
    return res.status(status).json(body);
  }
  try {
    const { trashPath } = await deleteDomain(domain, { confirm });
    await forgetHealthSummary(domain);
    res.json({ deleted: true, trashPath, syncWarning: isConfigured() });
  } catch (err) {
    if (err.code === 'CONFIRM_REQUIRED') {
      return res.status(400).json({ ok: false, reason: 'confirm_required', error: err.message });
    }
    if (err.code === 'LOCKED') {
      return res.status(409).json({ error: `Another process is already writing to "${domain}" (file lock held). Nothing was deleted.`, conflict: 'file_lock' });
    }
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
