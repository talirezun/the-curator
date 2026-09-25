/**
 * /api/trash — Settings › Trash (v3.76.0).
 *
 *   GET    /api/trash                        everything in the trash, newest first
 *   POST   /api/trash/:kind/:id/restore      put one entry back   body { as? }
 *   DELETE /api/trash/:kind/:id              delete one entry FOREVER   body { confirm }
 *
 * `:kind` is `domains`, `projects` or `scopes` (a scope is a handoff on
 * screen); `:id` is the entry's folder name in the trash, exactly as the
 * listing returned it. The store (src/brain/trash-items.js) matches the id
 * against the real listing before it builds any path, so a traversal id is a
 * 404, never a path.
 *
 * Both mutating routes sit behind server.js's cross-origin guard like every
 * other /api route. A restore also refuses while a write is in flight on the
 * domain it writes into (the in-process registry — the same 409 a delete
 * gives) and registers itself as a write while it runs, so a Sync or an
 * update cannot start in the middle of it. The store adds the domain's
 * cross-process file lock for a project or handoff restore.
 *
 * THE TRASH IS NEVER SYNCED (it is outside the domains folder, paths.js
 * getTrashDir). A restore puts the folder back into the domains folder, and
 * the next Sync carries it like any other change; `syncConfigured` lets the
 * view say so only when it is true.
 *
 * DELETE's typed confirmation is checked HERE as well as in the store: a
 * confirmation that lives only in a view is one any other client skips.
 */
import { Router } from 'express';
import {
  listTrash, restoreFromTrash, emptyTrashItem, trashEntryDomain, TRASH_KINDS,
} from '../brain/trash-items.js';
import {
  isDomainActive, isUpdateInProgress, conflictResponse, registerWrite,
} from '../brain/write-registry.js';
import { isConfigured } from '../brain/sync.js';

const router = Router();

const STATUS = {
  'invalid-kind': 400,
  'invalid-name': 400,
  'unsafe-path': 400,
  'confirm-required': 400,
  'not-found': 404,
  readonly: 403,
  exists: 409,
  'no-parent': 409,
  'unknown-origin': 409,
  locked: 409,
  io: 500,
};

function refusal(res, out) {
  const reason = out && typeof out.reason === 'string' ? out.reason : 'io';
  const body = { ok: false, reason: reason.replace(/-/g, '_'), error: out && out.message ? out.message : 'Refused.' };
  if (out && typeof out.suggestedName === 'string') body.suggestedName = out.suggestedName;
  if (out && typeof out.expected === 'string') body.expected = out.expected;
  return res.status(STATUS[reason] || 500).json(body);
}

function syncConfigured() {
  try { return !!isConfigured(); } catch { return false; }
}

router.get('/', async (req, res) => {
  try {
    const out = await listTrash();
    res.json({ ...out, syncConfigured: syncConfigured() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:kind/:id/restore', async (req, res) => {
  const { kind, id } = req.params;
  if (!TRASH_KINDS.includes(kind)) return refusal(res, { reason: 'invalid-kind', message: `"${kind}" is not a kind of trash entry.` });
  const as = req.body && typeof req.body.as === 'string' && req.body.as !== '' ? req.body.as : undefined;
  let release = null;
  try {
    const domain = await trashEntryDomain(kind, id);
    // A domain restore writes the domain folder under its (possibly new)
    // name; a project or handoff restore writes into its domain.
    const target = kind === 'domains' ? (as || domain) : domain;
    if (isUpdateInProgress() || (target && isDomainActive(target))) {
      const { status, body } = conflictResponse('restore from the trash');
      return res.status(status).json(body);
    }
    if (target) release = registerWrite(target, 'restore-from-trash');
    const out = await restoreFromTrash(kind, id, { as });
    if (!out || out.ok !== true) return refusal(res, out);
    res.json({ ...out, restored: true, syncConfigured: syncConfigured() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (release) release();
  }
});

router.delete('/:kind/:id', async (req, res) => {
  const { kind, id } = req.params;
  if (!TRASH_KINDS.includes(kind)) return refusal(res, { reason: 'invalid-kind', message: `"${kind}" is not a kind of trash entry.` });
  const confirm = req.body && typeof req.body.confirm === 'string' ? req.body.confirm : '';
  if (!confirm) {
    return res.status(400).json({
      ok: false, reason: 'confirm_required',
      error: 'Deleting a trash entry forever cannot be undone. Send { "confirm": "<its name>" }.',
    });
  }
  try {
    const out = await emptyTrashItem(kind, id, { confirm });
    if (!out || out.ok !== true) return refusal(res, out);
    res.json({ ...out, deleted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
