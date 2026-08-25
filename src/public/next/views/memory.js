// View: Agent memory — "your agents' brain". Read-only rollups written by
// coding agents through MCP.
//
// Owns views/memory.css (currently empty — nothing view-specific yet).

import { registerView, setSidebar, setMain, eyebrow, emptyCard } from '../app.js';

registerView('memory', {
  onEnter(mountToken) {
    setSidebar(
      '<div class="sidebar-title">Agent memory</div>' +
      '<div class="sidebar-hint">Written by your agents through MCP. Read-only here.</div>' +
      // "in this shell yet" leaked build vocabulary at users. Post-cutover
      // this IS the product, and Agent memory is genuinely future work — so
      // the copy says that in product language instead.
      '<div class="sidebar-note">No memory domains yet — coming soon.</div>',
      mountToken
    );
    setMain(
      eyebrow('your agents’ brain') +
      '<h1 class="view-title">Agent memory</h1>' +
      emptyCard({
        title: 'Agent memory — coming soon',
        body: 'Agent memory will show read-only rollups — Done, Decided, Blocked — composed from every active MCP ' +
              'scope a coding agent has written for a project, plus an Active scopes list showing which sessions are ' +
              'still live. It is rewritten on each compose rather than appended to, so it reflects current state, not ' +
              'a log. Distinguished from knowledge domains everywhere in the app by a square marker instead of a ' +
              'round one. None of it is built yet. It has a place in the rail because that is the shape the product ' +
              'is heading for: your brain, then your team’s brain, then your agents’ brain.',
      }),
      mountToken
    );
  },
});
