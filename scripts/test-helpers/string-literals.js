// scripts/test-helpers/string-literals.js — every string literal in a JS source.
//
// Used by the plain-language error census (test-user-errors.js), which must see
// EVERY message The Curator writes on purpose and prove the error translator
// leaves each one alone. A tokenizer-grade scan, not a regex over the file:
//   - '…', "…" and `…` literals are returned with escapes decoded;
//   - a template's `${…}` is replaced by the placeholder `X` in the template's
//     own text, and literals INSIDE the expression are returned too;
//   - // and /* */ comments are skipped (a comment is not a message);
//   - a regex literal is skipped, using the usual "what came before the /"
//     rule (after an operator, an opening bracket or a keyword it is a regex;
//     after an identifier, a number or a closing bracket it is division).
//
// NOT ENFORCED (stated, not hidden): a message built at run time from pieces
// that are each too short to look like anything is seen only as those pieces;
// a string produced by code (String.fromCharCode, Array.join of computed
// parts) is invisible; JSX/HTML in a template is just text. The census pairs
// this scan with EXECUTED builders (llm.js, model-gone.js, sync.js) for the
// messages that matter most.

const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'throw', 'new', 'delete', 'instanceof',
]);

function decode(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_m, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e === '\n' || e === '\r\n') return '';
    return e;
  });
}

/**
 * @param {string} src
 * @returns {{text: string, line: number}[]}
 */
export function extractStringLiterals(src) {
  const out = [];
  const lineAt = (i) => { let l = 1; for (let k = 0; k < i; k++) if (src.charCodeAt(k) === 10) l++; return l; };

  // Returns the index just past where it stopped. With `untilBrace`, stops at
  // the `}` that closes the `${` it was called for.
  function scan(i, untilBrace) {
    let depth = 0;
    let prev = '';   // the last significant token's tail: a char, or a word
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out.push({ text: decode(src.slice(i + 1, j)), line: lineAt(i) });
        i = j + 1; prev = 'a'; continue;
      }
      if (c === '`') {
        let j = i + 1;
        let text = '';
        let seg = j;
        while (j < src.length && src[j] !== '`') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') {
            text += decode(src.slice(seg, j)) + 'X';
            j = scan(j + 2, true);
            seg = j;
            continue;
          }
          j++;
        }
        text += decode(src.slice(seg, j));
        out.push({ text, line: lineAt(i) });
        i = j + 1; prev = 'a'; continue;
      }
      if (c === '/') {
        const regexOk = prev === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || REGEX_AFTER_WORD.has(prev);
        if (regexOk) {
          let j = i + 1;
          let inClass = false;
          while (j < src.length && src[j] !== '\n') {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '[') inClass = true;
            else if (src[j] === ']') inClass = false;
            else if (src[j] === '/' && !inClass) break;
            j++;
          }
          j++;
          while (j < src.length && /[a-z]/i.test(src[j])) j++;
          i = j; prev = 'a'; continue;
        }
        prev = '/'; i++; continue;
      }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) return i + 1; depth--; }
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prev = src.slice(i, j);
        if (/^[0-9]/.test(prev)) prev = 'a';
        i = j; continue;
      }
      if (!/\s/.test(c)) prev = c === ')' || c === ']' || c === '}' ? 'a' : c;
      i++;
    }
    return i;
  }

  scan(0, false);
  return out;
}
