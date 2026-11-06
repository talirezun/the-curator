/**
 * Every string Wiki health may show, outside the page names that are its data.
 *
 * The word audit (v3.90.0 process): a suite renders the real section in every arm,
 * and the browser walk reads the running page; each visible line must match one of
 * these. A new word on screen is a decision, so it fails until it is added here.
 *
 * `{n}` is a figure with thousands separators, `{age}` a relative time, `{x}` a cost,
 * `{name}` free data (a page name, a model), `{msg}` a server's message.
 */
const NOTE = 'If you use GitHub Sync, changes can be undone with a git client — the app has no Undo button yet.';
const WARN = 'There is no Undo button in the app. If you use GitHub Sync this is recoverable with a git client; otherwise it cannot be undone.';

export const DECK = [
  // Section head
  'Wiki health', '{age}', 'Checked', 'Checked {age} · {n} to look at', 'Checked {age} · 1 to look at', 'Checked {age} · nothing to look at',
  '{n} to look at', 'nothing to look at', 'Checking…', 'Not checked yet',
  'Finds problems in this wiki and helps you fix them.',
  'Check again is free. It looks for broken links, pages nothing links to and gaps in the page list. It opens with the domain.',
  'Comparing pages for duplicates uses your AI model, and each action shows its cost first.',
  'Nothing changes until you press a button.', 'One merge can settle several pairs.', 'Try', 'Open the guide', 'Read the guide',
  // Control row
  'Check again', 'Check this wiki', 'Could not check this wiki', 'Scanning…',
  // Clean
  'Nothing to fix.', 'All {n} pages were checked {age}.', 'The 1 page was checked {age}.',
  // Lane 1
  'Free repairs', 'No AI, no cost, no page deleted.', 'Repair all {n}', 'Repairing {n} of {n}…', 'Repaired {n} {age}',
  'Repaired {n} of {n}. {n} could not be repaired.', 'Pages missing a link back', 'Links written with a folder name',
  'Summaries with untidy link lists', 'Broken links with a known target', 'Pages missing from the page list',
  'Repair {n}', 'Preview the rebuild', 'goes to {name}', 'Show {n} more', 'Repairing…', 'Repaired {n}',
  'Could not repair: {msg}', 'Try again', 'No link is removed.',
  // Rebuild
  'Working it out…', 'Nothing is written yet.',
  '{n} pages join the page list and {n} rows that point to missing pages are removed. {n} descriptions stay as written.',
  '{n} rows now point to the page they name.', '{n} repeated rows become one.',
  'New descriptions come from each page’s title or first line. No AI, no cost. The list is sorted into Summaries, Entities and Concepts. It grows from {name} to {name}.',
  '{n} pages have file names that cannot be linked (a leading or trailing space, or | [ ] #) and are left out. Rename them to include them.',
  '{n} concept pages share a name with an entity page and are left out. Merge those first.',
  '1 concept page shares a name with an entity page and is left out. Merge those first.',
  '1 page has a file name that cannot be linked (a leading or trailing space, or | [ ] #) and is left out. Rename it to include it.',
  '1 page joins the page list and {n} rows that point to missing pages are removed. {n} descriptions stay as written.',
  '{n} pages join the page list and 1 row that points to a missing page is removed. {n} descriptions stay as written.',
  '{n} pages join the page list and {n} rows that point to missing pages are removed. 1 description stays as written.',
  '1 row now points to the page it names.', '1 repeated row becomes one.',
  'For example, added:', 'Removed, because the page no longer exists:', 'And {n} more.', NOTE,
  'Rebuild the list', 'Cancel', 'Rebuilding…', 'The page list was rebuilt. {n} pages added, {n} rows removed.',
  'The page list already has every page.', 'The wiki changed since this was worked out. Press Preview the rebuild again.', 'Could not rebuild the list: {msg}',
  // Lane 2
  'Your decision', 'Only you can tell. Nothing happens until you choose.', 'Possible duplicates', 'Review',
  'Spelling variants', 'Same name in two folders', 'Nearly the same name', 'Pages nothing links to', 'Broken links with no target', 'Left as is',
  'deletes {n} pages', 'deletes 1 page', 'Merge {n}', 'Leave as is', 'Bring back',
  'keep {name}, delete {name}', 'becomes {name}', 'kept both', '{name} → {name}',
  'Merge {n} spelling variants?', 'Merge 1 spelling variant?', 'Each pair becomes one page. {n} pages are deleted and their links move to the page that stays.',
  'Merge {n} pages with the same name?', 'Merge 1 page with the same name?', '{n} pages are deleted and their links move to the page that stays.',
  '1 page is deleted and its links move to the page that stays.', 'Merge {n} groups with nearly the same name?', 'Merge 1 group with nearly the same name?',
  WARN, 'Merge and delete {n}', 'Merging {n} of {n}…', 'Merged {n}.', 'Merged {n}', 'Merged {n} of {n}. {n} now need your review.', 'Merged {n} {age}',
  'Could not merge: {msg}', 'Nothing left to merge.', 'Saving…', 'Left as is.', 'Undo', 'Brought back.', 'Could not save: {msg}',
  // Lane 3
  'AI help', 'Uses your AI model. Each action shows its cost first.', 'each action shows its cost', 'Change model',
  'Runs on {name} · each action shows its cost · Change model', 'Runs on {name}', 'Last run: {name}', 'Last run: {name} · {x}', '{x}',
  'Needs an AI provider key', 'Add one in Providers & keys', 'Needs an AI provider key · Add one in Providers & keys',
  'Compare pages for duplicates', 'No pairs compared yet', 'Compare the next {n}', 'Compare the next {n} {x}', '{n} of {n} pairs compared',
  'Working out the cost…', 'Compare the next…', 'All {n} pairs compared', 'No two page names look alike', 'About {n} of {n} pairs compared',
  'Comparing {n} of {n}…', '{n} pairs could not be compared because the AI call failed. They will be tried again next time.',
  'Could not compare pages: {msg}', 'Forget all comparisons',
  'Compare the next {n} of {n} pairs?', 'Sends the opening of each page to {name}. About {n} tokens and {x}. Nothing is merged.', 'Compare for', 'Compare for {x}',
  'This run is over your cost limit.', 'It would send {n} pairs: about {n} tokens, over your limit of {n}. Nothing has been sent.', 'Open scan limits', 'Close',
  'Forget all comparisons?', 'The Curator forgets which pairs it has compared in this domain, so the next run starts over and costs money again. Pairs you kept apart stay that way. Nothing in your wiki changes.',
  'Forget', 'Comparisons forgotten.', 'Could not forget: {msg}',
  'Before you use AI help.', 'These actions send the opening of the pages involved, and usually a list of your other page names, to your AI provider ({name}). The next step shows what it sends and what it costs before anything runs. The provider’s own privacy policy applies. To turn this off, remove your API key in Settings.',
  'Continue',
  'Find links for {n} pages nothing links to', 'Find links for 1 page nothing links to', 'Suggest', 'Suggest {x}',
  'Ask AI to find a page that should link to each?', 'Sends each page’s opening and the list of your page names to {name}. About {x}. Nothing is written yet.', 'Ask for', 'Ask for {x}', 'Looking…', 'Looking… {n} of {n}',
  '{n} pages found a home; {n} are left for you.', 'Each one gets one new link, from the page that should mention it.', 'Add these links', 'Discard', 'Adding…',
  'Added {n} links. {n} skipped.', 'No clear home was found for {n} pages, so nothing changed.', 'Could not add the links: {msg}',
  'Find targets for {n} broken links', 'Find targets for 1 broken link',
  'Ask AI to resolve {n} broken links?', 'Sends the text around each link and the list of your page names to {name}. About {x} for {n} links ({n} are resolved free). Nothing is written yet.',
  '{n} links will point to an existing page, and {n} become plain text because no page matches.', 'Apply', 'Applying…',
  '{n} links now point to a page and {n} became plain text, across {n} pages.', '{n} links had a suggested page that failed the safety check, so they became plain text instead.',
  'No broken link could be resolved, so nothing changed.', 'Nothing changed. The AI did not answer for {n} batches. Try again in a moment.', 'Could not build a plan: {msg}',
  'An earlier fix on this domain is still running. Wait for it to finish before starting another.',
  // Footer and details
  'Scan details', 'open issues', 'entities', 'concepts', 'summaries', 'left as is', 'checked',
  'This domain is a read-only Shared Brain mirror', 'Fixes here would be overwritten on the next Pull — fix issues in your personal contributing domain, then push from Sync.',
  'Could not check this wiki: {msg}',
];

/**
 * NOT IN THE DECK, and each one reported to the orchestrator: a state the deck has
 * no words for, kept as close to the deck's own words as it can be. Reviewed, not
 * improvised: to retire one, give the deck the state.
 */
export const OUTSIDE_THE_DECK = [
  '{n} times on this page',       // v3.92.0's fact, newer than the deck
  'Compared {n} pairs.',          // the answer on the confirm when a run ends
  'Comparing…',                   // before the first count arrives
  'Merging…', 'Checking…',        // a press with no count to give; the desk's own word
  'Nothing left to repair.',      // the deck has it only for merging
  'Resolved',                     // a row above the press, settled by the reading after it
  'Settled by another merge',     // the same, for a pair (Stage 1)
  'It shrinks from {name} to {name}.',  // the deck has only the page list growing
  'Nothing is left as is.',       // the list just emptied while open
  '1 is left for you.',
  'Loading…',
  'open issue',
  'at {name}',                    // the monitor's clock time beside "checked"
  '(your model was unavailable)', // a fallback's disclosure on the Last run line
  'free', 'cost unknown', '…',
];

/**
 * STAGE 2 ONLY: today's pair cards, which the review desk replaces in Stage 3, are
 * reached through Possible duplicates in their old words. Audited apart: only inside
 * this subtree, and the suite says how many strings it let through.
 */
export const STAGE3_SUBTREE = '[data-group-key="duplicates"] > .cur-fold-body';

// No mechanism words on screen. "confidence" joins this in Stage 3, with the badge.
export const BANNED = /\b(diff|slugs?|orphans?|backlinks?|prefix(es)?|candidates?|deterministic|quick maintenance|safe issues?|rescan|dismiss(ed)?|restore)\b/i;

// The deck's item line, in any combination: its parts are each optional.
const FACT = '(?:[\\d,]+ repeated lines?|[\\d,]+ concepts? filed under Entities|[\\d,]+ entit(?:y|ies) filed under Concepts)';
const ITEM_FACT = new RegExp('^' + FACT + '(?: · ' + FACT + ')*$');
function toRegex(line) {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{n\\\}/g, '[\\d,]+')
    .replace(/\\\{age\\\}/g, '(?:just now|.{1,24}? ago|in the future|never)')
    .replace(/\\\{x\\\}/g, '(?:≈ )?(?:< )?(?:\\$[\\d.,]+|free|cost unknown|…)')
    .replace(/\\\{(name|msg)\\\}/g, '.+?');
  return new RegExp('^' + escaped + '$');
}
const COMPILED = [...DECK, ...OUTSIDE_THE_DECK].map(toRegex);

/** Is this visible line one the deck allows? */
export function wordAllowed(line) {
  const t = String(line).replace(/\s+/g, ' ').trim();
  if (!t) return true;
  return ITEM_FACT.test(t) || COMPILED.some((re) => re.test(t));
}

/**
 * Pure figures, separators and a lone glyph are not words: a monitor value, a pill,
 * or a ≈ $0.04 on its own span.
 */
export function isFigure(line) {
  return /^[\s\d,.$≈<·→↔✓%:/-]*$/.test(String(line));
}
