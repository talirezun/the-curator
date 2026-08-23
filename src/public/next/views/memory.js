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
      '<div class="sidebar-note">No memory domains in this shell yet.</div>',
      mountToken
    );
    setMain(
      eyebrow('your agents’ brain') +
      '<h1 class="view-title">Agent memory</h1>' +
      emptyCard({
        title: 'This feature doesn’t exist yet',
        body: 'Agent memory will show read-only rollups — Done, Decided, Blocked — composed from every active MCP ' +
              'scope a coding agent has written for a project, plus an Active scopes list showing which sessions are ' +
              'still live. It is rewritten on each compose rather than appended to, so it reflects current state, not ' +
              'a log. Distinguished from knowledge domains everywhere in the app by a square marker instead of a ' +
              'round one. None of the read side exists yet — this slot is here so the rail’s shape (your brain → ' +
              'your team’s brain → your agents’ brain) is honest about what’s coming, not just what’s built.',
      }),
      mountToken
    );
  },
});
