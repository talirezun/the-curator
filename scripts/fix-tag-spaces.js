#!/usr/bin/env node
/**
 * Fix spaces in Obsidian tags across all wiki markdown files.
 * Handles both YAML inline format  → tags: [foo bar, baz]
 * and block format                 → tags:\n  - foo bar
 *
 * Spaces within a tag token are replaced with hyphens.
 * type/concept, type/summary etc. (slashes) are left untouched.
 * Dry-run by default — pass --write to apply changes.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const DRY_RUN = !process.argv.includes('--write');

// ── helpers ──────────────────────────────────────────────────────────────────

const slugTag = (t) => t.trim().toLowerCase()
  .replace(/&/g, 'and')
  .replace(/\s+/g, '-')
  .replace(/[^a-z0-9\-_/]/g, '')
  .replace(/-{2,}/g, '-')
  .replace(/^-|-$/g, '');

/** Fix inline tags: [foo bar, baz quux, ok] → [foo-bar, baz-quux, ok] */
function fixInlineTags(line) {
  return line.replace(/^(tags:\s*\[)(.+)(\])/, (_, open, inner, close) => {
    const fixed = inner.split(',').map(slugTag).join(', ');
    return open + fixed + close;
  });
}

/** Fix block tag: "  - foo bar" → "  - foo-bar" */
function fixBlockTag(line) {
  return line.replace(/^(\s*-\s*)(.+)$/, (_, prefix, tag) => prefix + slugTag(tag));
}

// ── process files ─────────────────────────────────────────────────────────────

const root = new URL('../domains', import.meta.url).pathname;
const files = execSync(`find ${root} -name "*.md"`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);

let totalFiles = 0;
let fixedFiles = 0;
let fixedTags  = 0;

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');

  // Only operate inside the YAML frontmatter (between the two --- fences)
  let inFrontmatter = false;
  let inTagsBlock   = false;  // true after bare "tags:" until next non-list line
  let fenceCount    = 0;
  let changed       = false;

  const result = lines.map((line) => {
    if (line.trim() === '---') {
      fenceCount++;
      inFrontmatter = fenceCount === 1;
      if (fenceCount === 2) { inFrontmatter = false; inTagsBlock = false; }
      return line;
    }

    if (!inFrontmatter) { inTagsBlock = false; return line; }

    // Inline format: tags: [foo bar, baz]
    if (/^tags:\s*\[/.test(line)) {
      inTagsBlock = false;
      const fixed = fixInlineTags(line);
      if (fixed !== line) { changed = true; fixedTags++; }
      return fixed;
    }

    // Block format header: "tags:"
    if (/^tags:\s*$/.test(line)) {
      inTagsBlock = true;
      return line;
    }

    // Block format list item: "  - foo bar"
    if (inTagsBlock && /^\s*-\s/.test(line)) {
      const fixed = fixBlockTag(line);
      if (fixed !== line) { changed = true; fixedTags++; }
      return fixed;
    }

    // Any other frontmatter key ends the tags block
    if (inTagsBlock && /^\S/.test(line)) inTagsBlock = false;

    return line;
  });

  totalFiles++;
  if (changed) {
    fixedFiles++;
    if (!DRY_RUN) {
      writeFileSync(file, result.join('\n'), 'utf8');
    } else {
      console.log(`[dry-run] would fix: ${file.replace(root, 'domains')}`);
    }
  }
}

console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Scanned ${totalFiles} files.`);
console.log(`Files with space-in-tag fixes: ${fixedFiles}`);
console.log(`Individual tag lines fixed:    ${fixedTags}`);
if (DRY_RUN) console.log('\nRun with --write to apply changes.');
