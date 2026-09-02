# Maintenance — the clean-up dialogue and the call shapes

Read this when the user asks you to check, clean up or repair a wiki. The tier table and
the four safety rules that govern *whether* to call anything are in [SKILL.md](SKILL.md)
§6; this file is *how* to make the calls.

## The standard "clean up" dialogue

```
1. scan_wiki_health(domain)
2. Loop the auto-fixable ones via fix_wiki_issue
   — count a call as a success ONLY when it returns fixed: 1
3. List the review-only ones; ask the user one by one (or in batch)
4. For each user-approved fix → fix_wiki_issue
   — brokenLinks / folderPrefixLinks / crossFolderDupes / hyphenVariants /
     missingBacklinks: pass the scan object through unchanged
   — an ORPHAN: type="orphanLink" with a composed
     {orphanSlug, targetSlug, description}, target agreed with the user
5. For each user dismissal → dismiss_wiki_issue (persists across scans + machines)
   — this IS where type="orphans" is the correct value
```

## `type` is the scan CATEGORY, not a field on the issue

`scan_wiki_health` returns issues grouped under `brokenLinks`, `orphans`,
`folderPrefixLinks`, `crossFolderDupes`, `hyphenVariants`, `missingBacklinks` — and the
individual objects do **not** carry that name. (A `folderPrefixLinks` issue is just
`{sourceFile, linkText}`; an `orphans` issue *does* have a `type` field, but it holds the
page kind — `"entity"` / `"concept"` — which is not a fixable issue type.) Pass the key you
found the issue under, and pass the issue object through unchanged:

```
fix_wiki_issue(domain, type="folderPrefixLinks", issue=<the object>)
```

**`orphans` is NOT a `fix_wiki_issue` type.** It is a scan category and a
`dismiss_wiki_issue` type, and those are the only two places the word is accepted.
`fix_wiki_issue` takes exactly seven types — `brokenLinks`, `folderPrefixLinks`,
`crossFolderDupes`, `hyphenVariants`, `missingBacklinks`, `orphanLink`, `semanticDupe` —
and passing `"orphans"` is rejected outright.

## `orphanLink` is the one issue you compose rather than pass through

The scanner emits an orphan as `{path, type, slug}`, but the fixer needs
`{orphanSlug, targetSlug, description}`. Forwarding the scan object unchanged is refused,
because the scanner cannot know which page *ought* to link to the orphan — only you and the
user can.

```
scan gives you:   { path: "concepts/lonely.md", type: "concept", slug: "lonely" }
the fixer needs:  { orphanSlug: "lonely", targetSlug: "<an existing page>", description: "<one clause>" }

fix_wiki_issue(domain, type="orphanLink", issue={
  orphanSlug:  "lonely",              # the scan entry's `slug`, verbatim
  targetSlug:  "knowledge-graphs",    # an EXISTING entity or concept — never a summary, never itself
  description: "a related idea",      # short prose for the bullet
})
```

Because `targetSlug` is your judgement and not the scanner's, treat it exactly like an
invented `suggestedTarget`: **propose it to the user and get agreement before calling.** It
writes `- [[orphanSlug]] — description` into the target's Related section. If no existing
page is a genuine home, say so and leave the orphan alone — the app's bulk
**✨ Rescue orphans** flow (Domains → the domain → Wiki health → Quick maintenance) plans
them in one batch and previews before writing.

## When there is no scanner target

A `suggestedTarget` you compose is rejected outright unless it names a page that exists —
and even then it is your guess, not the scanner's. For a broken link with no scanner
target, the right move is to say so and leave the link alone, or tell the user about the
app's bulk **✨ Fix broken links** flow (Domains → the domain → Wiki health → Quick
maintenance), which plans the whole domain, previews it, and applies its own
version/polarity safety gate before writing.

## Reading `fixed: 0`

Never read `fixed: 0` as "already fine". It has several causes and the response tells you
which one in a `reason` field, with the prose in `report`. Only `link-not-present` and
`link-already-present` mean the issue really had already been resolved. Everything else —
`target-not-found`, `orphan-fields-missing`, `no-suggested-target`, `orphan-not-found`,
`self-link`, `slug-shape-invalid`, `source-file-not-found` — means **nothing was written
and the issue is still there**; the `report` names the next action. Do not count such a
call as a success, and do not report a clean sweep to the user on the strength of it.

## Dismissals

`dismiss_wiki_issue` writes to a file synced across the user's machines. Items dismissed in
an MCP conversation also disappear from the app's Wiki health panel; same store. Use
`get_health_dismissed` to list previously skipped issues if the user asks, and
`undismiss_wiki_issue` when they change their mind.

## Health on Shared Brain mirror domains

`scan_wiki_health` works fine on `shared-*` mirrors — you can show the user the report. But
`fix_wiki_issue` is **refused** on mirrors: fixes would not propagate to other contributors
and would be overwritten on the next Pull. To resolve a Health issue in the shared brain,
the contributor who introduced it must fix it in their personal opted-in domain, then Push
+ run synthesis. Tell the user this explicitly when their scan request targets a `shared-*`
domain. See [shared-brain.md](shared-brain.md).

A worked clean-up dialogue is Example 4 in [examples.md](examples.md).
