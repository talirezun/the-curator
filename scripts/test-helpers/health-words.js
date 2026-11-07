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
const NOTE = 'Every change here can be undone in Recent changes for 30 days, on this computer, while its pages stay unchanged.';
const WARN = 'You can undo this in Recent changes for 30 days, on this computer only, while none of these pages has changed since.';

export const DECK = [
  // Section head
  'Wiki health', '{age}', 'Checked', 'Checked {age} · {n} to look at', 'Checked {age} · 1 to look at', 'Checked {age} · nothing to look at',
  '{n} to look at', 'nothing to look at', 'Checking…', 'Not checked yet',
  'Finds problems in this wiki and helps you fix them.',
  // The ⓘ's two points, cut to fit its standing limit (12 words, no "cost"): reported.
  'Check again finds broken links, unlinked pages and page list gaps.',
  'Comparing pages for duplicates uses your AI model.',
  'Nothing changes until you press a button.', 'One merge can settle several pairs.', 'Try', 'User guide', 'Wiki Health', 'Opens in your browser',
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
  // Recent changes (Undo, owner's decision 2026-11-07). The change's own title is
  // page data (mono) and not audited here; test-health-undo.js pins its words.
  'Recent changes',
  'Kept for 30 days on this computer. Undo puts back every page of a change exactly as it was, or none: it refuses if any of them has changed since, and never reaches other computers.',
  '{n} pages · {age}', '1 page · {age}', '{n} pages and the page list · {age}', '1 page and the page list · {age}',
  'Undone', 'Could not finish undoing · {n} pages', 'Could not finish undoing · 1 page',
  'Undo “{name}”?',
  'Puts back these {n} pages exactly as they were before this change: {name}.',
  'Puts back these {n} pages and the page list exactly as they were before this change: {name}.',
  'Puts back these {n} pages exactly as they were before this change: {name}. {name} comes back.',
  'Puts back these {n} pages and the page list exactly as they were before this change: {name}. {name} comes back.',
  'Puts back these {n} pages exactly as they were before this change: {name}. {name} come back.',
  'Puts back these {n} pages and the page list exactly as they were before this change: {name}. {name} come back.',
  'Puts back this page exactly as it was before this change: {name}.',
  'Puts back this page and the page list exactly as they were before this change: {name}.',
  'This works on this computer only. Another computer that already has this change gets these pages back after both computers sync again.',
  'Undoing…', 'Undone. {n} pages are back as they were.', 'Undone. The page is back as it was.',
  'Nothing was undone. {name} was changed after this change: an edit, a later ingest, or a sync from another computer. Undo puts back every page or none, and never overwrites a newer change.',
  'Nothing was undone. {name} was deleted after this change: an edit, a later ingest, or a sync from another computer. Undo puts back every page or none, and never overwrites a newer change.',
  'Nothing was undone. {name} was created again after this change: an edit, a later ingest, or a sync from another computer. Undo puts back every page or none, and never overwrites a newer change.',
  'Nothing was undone. {name} was changed by a later change, "{name}". Undo that one first. Undo puts back every page or none, and never overwrites a newer change.',
  'This change was already undone.', 'Could not undo: {msg}', 'Could not check this change: {msg}',
  // Lane 3
  'AI help', 'Uses your AI model. Each action shows its cost first.', 'each action shows its cost', 'Change model',
  'Runs on {name} · each action shows its cost · Change model', 'Runs on {name}', 'Last run: {name}', 'Last run: {name} · {x}', '{x}',
  'Needs an AI provider key', 'Add one in Providers & keys', 'Needs an AI provider key · Add one in Providers & keys',
  'Compare pages for duplicates', 'Compare all {n}', 'Compare all {n} {x}', 'Compare all for', 'Compare all for {x}', 'Compare all {n} remaining pairs?', 'Compare all 1 remaining pair?', 'No pairs compared yet', 'Compare the next {n}', 'Compare the next {n} {x}', '{n} of {n} pairs compared',
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
  // The review desk
  'Pair {n} of {n}', '{n} decided · {n} left', 'Previous', 'Next', 'Done',
  'Spelling variant', 'Version numbers differ', 'Different names', 'The AI gave no reason.',
  'Goes away', 'Stays', '{name} · {n} links point here · {name}', '{name} · 1 link points here · {name}', '{name} · nothing links here · {name}', 'The AI says: "{msg}"',
  'Loading the page…', '(showing the first {n} characters)', 'Read full page', 'Keep this one instead',
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name, and everything else moves under "Merged from {name}". {n} links move to it.',
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name, and everything else moves under "Merged from {name}". 1 link moves to it.',
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name, and everything else moves under "Merged from {name}". No links move, because nothing links here.',
  'Keep both', 'Merge into {name}', 'Merging deletes {name}. ' + WARN,
  'Merged {name} into {name}.', 'Merged {name} into {name}. {n} links moved.', 'Merged {name} into {name}. 1 link moved.',
  'Merged {name} into {name}. {n} links moved. {n} other pairs settled.', 'Merged {name} into {name}. {n} links moved. 1 other pair settled.',
  'Merged {name} into {name}. 1 link moved. {n} other pairs settled.', 'Merged {name} into {name}. 1 link moved. 1 other pair settled.',
  'Merged {name} into {name}. {n} other pairs settled.', 'Merged {name} into {name}. 1 other pair settled.',
  'Kept {name} and {name} apart. They will not come back.',
  'This page changed since you compared it. The comparison has been refreshed.', 'This pair is settled: {name} no longer exists. Moving on.',
  'Could not load the comparison: {msg}', 'All pairs decided.', '{n} merged · {n} kept both · {n} settled by another merge',
  '{n} pairs have not been compared yet, shown in AI help.', '1 pair has not been compared yet, shown in AI help.',
  'All {n} pairs', 'waiting', 'merged', 'settled by another merge', 'this pair', '{name} → {name}',
  // A family (families/COPY.md). Step 1
  'Family of {n} pages', 'Decision {n} of {n}',
  '{n} pages, {n} links pointing to them, {name} of text. The AI compared {n} of the {n} possible pairs here. A match between two pages says nothing about a third.',
  '{n} pages, 1 link pointing to them, {name} of text. The AI compared {n} of the {n} possible pairs here. A match between two pages says nothing about a third.',
  'Which page stays?', 'Press it. Nothing is merged yet: the others then come up one at a time, beside it, for you to decide.',
  '{n} links · {name} · AI compared it with {n} of the other {n}', '1 link · {name} · AI compared it with {n} of the other {n}',
  'Read', 'Show the other {n}', 'No page in this family has that in its name.',
  'Different things that only look alike?', 'Keep all {n} apart',
  'Kept these {n} pages apart. They will not come back. Pairs the AI has not compared may still come up later.',
  // Step 2: the walk
  'Page {n} of {n} · {n} merged · {n} kept · {n} left',
  '{name} stays.', '{name} stays. It has taken in {n} pages so far.', '{name} stays. It has taken in 1 page so far.', 'Choose again',
  'The AI compared these two pages and said they are the same.', 'The AI compared these two pages and said they are not the same.',
  'The AI never compared these two pages.', 'Only your reading decides this one.',
  'It is here because the AI matched it with {name}. That says nothing about {name}. Only your reading decides this one.',
  'It is here because the AI matched it with {name}, which you have since merged in. That says nothing about {name}. Only your reading decides this one.',
  'Merge {name} into {name}', 'All {n} pages', 'this page',
  'Merged {name} into {name}.', 'Kept {name} and {name} apart. This pair will not come back.', 'Brought back {name}.',
  'Now {name} stays, and {name} is one of the pages to go through.', 'You chose {name} earlier. {n} merged, {n} kept, {n} left.',
  'This page is settled: {name} no longer exists. Moving on.',
  'Merged', 'This page no longer exists', 'Its text is on the page that stays, under Merged from {name}.',
  'Merged into {name}. Nothing more to decide here.', 'You kept {name} and {name} apart.',
  'The AI said these are the same as {name} ({n})', 'The AI never compared these with {name} ({n})', 'The AI said these are not the same as {name} ({n})',
  // Finished
  'All decided', '{n} pages not decided', '1 page not decided', 'Go back to it', 'Go back to them',
  'Took in {n} pages. Links pointing to it went from {n} to {n}, its text from {name} to {name}.', 'Took in 1 page. Links pointing to it went from {n} to {n}, its text from {name} to {name}.',
  'Took in {n} pages.', 'Took in 1 page.', 'Nothing was merged into it.',
  'You merged {n} pages the AI never compared with {name}: {name} and {name}. Only your reading decided them.',
  'You merged 1 page the AI never compared with {name}: {name}. Only your reading decided it.',
  'You merged {n} pages the AI never compared with {name}. Only your reading decided them.',
  'Kept both', 'Merged in', '{n} pages deleted', '1 page deleted', 'Their text is on {name}, each under "Merged from" and its name.', 'the AI never compared it',
  '{n} pages kept', '1 page kept', 'These stay separate from {name}, and that pair will not come back.',
  'Not decided', '{n} pages waiting', '1 page waiting', 'Nothing happened to these.',
  '{n} pages left over still match one another, so they may be a smaller family of their own.', 'Review those {n}',
];

/**
 * NOT IN THE DECK, and each one reported to the orchestrator: a state the deck has
 * no words for, kept as close to the deck's own words as it can be. Reviewed, not
 * improvised: to retire one, give the deck the state.
 */
export const OUTSIDE_THE_DECK = [
  '{n} times on this page',       // v3.92.0's fact, newer than the deck
  'Compared {n} pairs.', 'Compared 1 pair.',  // the answer on the confirm when a run ends
  'The 1 pair was compared', '{n} of 1 pair compared',
  'Merged {n} of {n}. 1 now needs your review.',
  'Comparing…',                   // before the first count arrives
  'Merging…', 'Checking…',        // a press with no count to give; the desk's own word
  'Nothing left to repair.',      // the deck has it only for merging
  'Rows in the page list with no page',  // a stale-only list: "missing" would say the wrong thing
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
  // The review desk: facts the deck has no line for.
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name. {n} links move to it.',
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name. 1 link moves to it.',
  'After the merge there is one page, {name}. Lists from {name} join the sections of the same name. No links move, because nothing links here.',
  'All 1 pair',
  // Why Merge is shut, when the half second alone does not explain it.
  'Move the pointer off Merge and back to press it.', 'Merge opens once you have had both pages on screen.', 'Merge opens in a moment, so both pages can be read.',
  'Read the comparison for this pair before merging it.',       // the gate's re-check at execution
  'Could not merge: this merge would lose text, so nothing was changed.',
  'Could not merge: the pages did not pass the check on disk, so nothing was changed.',
  // A family, where COPY.md has no line for what the server really holds. A comparison made on
  // other text or another model is neither "compared" nor "never compared". An old "not the
  // same" answer has no reason to quote: the cache kept none until this release.
  'The AI compared older versions of these two pages.', 'Its answer no longer applies. Only your reading decides this one.',
  'The AI compared these two pages on another model.', 'The AI compared these two pages on another model, {name}.', 'The AI compared these two pages when the app asked it differently.',
  'The AI\'s answer no longer applies for these and {name} ({n})', 'the AI\'s answer no longer applied', 'The reason it gave was not kept.',
  // A "same" at low confidence: the AI's own hesitation, reported as that.
  'The AI leaned towards these two pages being the same, but was not sure.', 'The AI was unsure whether these are the same as {name} ({n})', 'the AI was unsure',
  // Leftovers in more than one group, and a walk from before a reload.
  '{n} pages left over still match one another, in {n} separate groups, so they may be smaller families of their own.', 'Review the first {n}',
  'These are {n} of the {n} pages left over. The other groups come up after them.',
  'The walk for {name} is still there, with {n} pages not decided. Next reaches it.', 'The walk for {name} is still there, with 1 page not decided. Next reaches it.',
  'These are {n} of the {n} pages left over. The other groups come up after them. The walk for {name} is still there, with {n} pages not decided. Next reaches it.',
  'These are {n} of the {n} pages left over. The other groups come up after them. The walk for {name} is still there, with 1 page not decided. Next reaches it.',
  'You chose {name} earlier. {n} pages are still waiting.', 'You chose {name} earlier. 1 page is still waiting.',
  // The list of decisions, when a family is in it.
  'All {n} decisions',
];


// No mechanism words on screen. "confidence" joined in Stage 3, when the badge went.
export const BANNED = /\b(diff|slugs?|orphans?|backlinks?|prefix(es)?|candidates?|deterministic|quick maintenance|safe issues?|rescan|dismiss(ed)?|restore|confidence)\b/i;

// The deck's item line, in any combination: its parts are each optional.
const FACT = '(?:[\\d,]+ repeated lines?|[\\d,]+ concepts? filed under Entities|[\\d,]+ entit(?:y|ies) filed under Concepts)';
const ITEM_FACT = new RegExp('^' + FACT + '(?: · ' + FACT + ')*$');
// All N pairs' summary: the deck's row states and facts, counted. Each part only when it is not zero.
const STATE = '[\\d,]+ (?:waiting|merged|kept both|settled by another merge)';
const RELATION = '(?:Spelling variant|Version numbers differ|Different names) [\\d,]+';
const MARK = '[\\d,]+ (?:the AI said (?:is|are) the same|it never compared|it was unsure about|with an answer that no longer applies|it said (?:is|are) not the same)';
const MARKS_LINE = new RegExp('^' + MARK + '(?: · ' + MARK + ')*$');
const FOLD_LINE = new RegExp('^(?:' + STATE + '(?: · ' + STATE + ')*|' + RELATION + '(?: · ' + RELATION + ')*)$');
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
  return ITEM_FACT.test(t) || FOLD_LINE.test(t) || MARKS_LINE.test(t) || COMPILED.some((re) => re.test(t));
}

/**
 * Pure figures, separators and a lone glyph are not words: a monitor value, a pill,
 * or a ≈ $0.04 on its own span.
 */
export function isFigure(line) {
  return /^[\s\d,.$≈<·→↔✓%:/-]*$/.test(String(line));
}
