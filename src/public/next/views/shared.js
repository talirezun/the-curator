// View: Shared Brain — "your team's brain". A collective wiki a cohort
// writes together.
//
// Owns views/shared.css (currently empty — the inline "beta" pill style
// on the sidebar title is the only view-specific styling here today, and
// it's small/one-off enough it was left inline rather than promoted to a
// class; a real Shared Brain view will need its own rules).

import { registerView, setSidebar, setMain, eyebrow, emptyCard } from '../app.js';

registerView('shared', {
  onEnter(mountToken) {
    setSidebar(
      '<div class="sidebar-title">Shared Brain <span style="font:var(--weight-medium) 10px/1.6 var(--font-mono);' +
      'color:var(--accent-text);background:var(--accent-tint);border:1px solid var(--accent-border);' +
      'border-radius:999px;padding:2px 7px;margin-left:4px;vertical-align:middle">beta</span></div>' +
      '<div class="sidebar-hint">A collective wiki a cohort writes together.</div>' +
      '<div class="sidebar-note">Not connected to any Shared Brain in this shell.</div>',
      mountToken
    );
    setMain(
      eyebrow('your team’s brain') +
      '<h1 class="view-title">Shared Brain</h1>' +
      '<div class="view-body">A Shared Brain is a collective wiki a cohort writes together. Contributors push ' +
      'synthesised summaries of the domains they opt in; the merged wiki comes back as a read-only mirror. Nothing ' +
      'else on your machine moves.</div>' +
      emptyCard({
        title: 'Not connected — this shell doesn’t wire either path yet',
        body: 'The real view has two entry points here: “I have an invite token” to join a cohort someone ' +
              'already set up, and “Start a new Shared Brain” to create one. Both open the existing five-step ' +
              'wizard from the shipping app, restyled — that reuse, and the connected-state maintenance surface ' +
              '(contributors, your attribution share, per-domain opt-in), is Phase 2 work.',
      }),
      mountToken
    );
  },
});
