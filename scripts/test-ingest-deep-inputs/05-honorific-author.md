# How Diacritic-Heavy Author Names Slip Through Slug Normalisation

By Dr. Tali Režun · 2026 · The Curator team

This very short article exists to stress-test one specific failure mode
of The Curator's ingest pipeline: how it handles an originator entity
whose name includes a diacritic (in this case, "ž" → "z" after NFKD
normalisation) AND a doctoral honorific (in this case, "Dr." → stripped
by the honorific filter).

The desired behaviour: regardless of whether the LLM writes
`entities/dr-tali-rezun.md`, `entities/dr.-tali-rezun.md`,
`entities/tali-rezun.md`, or `entities/tali-režun.md`, ALL of them must
resolve to the same canonical slug `entities/tali-rezun.md`. No
duplicates. No honorific-prefixed variant on disk. No diacritic in the
filename.

The mechanisms involved:
- `extractAuthorHints` extracts "Dr. Tali Režun" from the byline
- `slugifyName` produces "tali-rezun" (NFKD strips diacritic, honorific
  filter strips "Dr." prefix)
- `validateOutline` either INJECTS the canonical slug if missing or
  REDIRECTS a variant slug if the LLM picked one
- `writePage`'s Pass A applies the same honorific filter at write time
  for any slug that the validator missed

A correct ingest produces exactly one entity file at `tali-rezun.md`
and references it from the summary's "Entities Mentioned" section.

Tags: author-resolution, slug-normalisation, originator-hint

---

Expected entities: Tali Rezun (one file, no honorific variants).
Expected concepts: slug-normalisation, originator-hint.
