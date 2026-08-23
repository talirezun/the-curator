// View: Ingest — "the way material gets in". Drop a folder or a stack of
// files; each is decomposed into entity, concept and summary pages.
//
// Owns views/ingest.css (currently empty — nothing view-specific yet).

import { registerView, setSidebar, setMain, eyebrow, emptyCard } from '../app.js';

registerView('ingest', {
  onEnter(mountToken) {
    setSidebar(
      '<div class="sidebar-title">Ingest queue</div>' +
      '<div class="sidebar-hint">Files are meant to be processed one at a time so a failure never costs you the ' +
      'whole batch. That queue isn’t wired into this shell yet.</div>' +
      '<div class="sidebar-note">No batch is running in this shell.</div>',
      mountToken
    );
    setMain(
      eyebrow('the way material gets in') +
      '<h1 class="view-title">Ingest</h1>' +
      '<div class="view-body">Drop a folder or a stack of files. Each one is decomposed into entity, concept and ' +
      'summary pages, and merged into what is already there.</div>' +
      emptyCard({
        title: 'Single-file ingest already exists — the batch queue this view is for does not, yet',
        body: 'The shipping app can ingest one source today (PDF, MD, TXT) through its own Ingest tab. What this ' +
              'design specifically adds is a resumable batch queue: drop a folder or a stack of files, they process ' +
              'one at a time so a single failure costs one file instead of the whole batch, a paused or interrupted ' +
              'queue picks back up where it left off, and a failed row states the cause — “no text layer”, not just ' +
              '“failed”. None of that queue exists in this shell. It’s Track 3 on the roadmap; no date is set.',
      }),
      mountToken
    );
  },
});
