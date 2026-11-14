// Does a source carry hard data? The ONE implementation, pure (no imports, no DOM, no
// Node), served to the browser and imported by src/brain/ingest.js, so the estimate the
// browser asks for and the run the server makes decide with the same function on the
// same text. The measurements behind every number are in ingest.js, beside the rule.
// Callers pass the text as the gate reads it: the first 80,000 characters.

export const HARD_DATA_MIN_PER_1000 = 7;
export const HARD_DATA_MIN_ITEMS = 6;
export const HARD_DATA_MIN_CODE_SPANS = 20;
export const HARD_DATA_MIN_CODE_PER_1000 = 1;
export const HARD_DATA_MIN_TABLE_ROWS = 8;
export const HARD_DATA_MIN_TABLE_ROWS_PER_1000 = 0.5;

export function hardDataDensity(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const numbers = (body.match(/[€$£¥]?\d[\d,.:/–-]*%?/g) || [])
    .map((x) => x.replace(/[.,:/–-]+$/, ''))
    .filter((x) => !/^((19|20)\d\d)([–-]((19|20)?\d\d))?$/.test(x) && !/^\d$/.test(x));
  const code = (body.match(/`[^`\n]+`/g) || []).length;
  const tableRows = (body.match(/^\|.*\|[ \t]*$/gm) || []).length;
  const rows = (body.match(/^\|.*\|[ \t]*$/gm) || []).filter((r) => !/^\|[\s|:-]+\|[ \t]*$/.test(r)).length;
  const items = numbers.length + code + rows;
  const k = body.length / 1000;
  return {
    items, code, tableRows,
    perThousand: body.length ? items / k : 0,
    codePerThousand: body.length ? code / k : 0,
    tableRowsPerThousand: body.length ? tableRows / k : 0,
  };
}

export function sourceHasHardData(text) {
  const d = hardDataDensity(text);
  if (d.items < HARD_DATA_MIN_ITEMS) return false;
  return d.perThousand >= HARD_DATA_MIN_PER_1000
    || (d.code >= HARD_DATA_MIN_CODE_SPANS && d.codePerThousand >= HARD_DATA_MIN_CODE_PER_1000)
    || (d.tableRows >= HARD_DATA_MIN_TABLE_ROWS && d.tableRowsPerThousand >= HARD_DATA_MIN_TABLE_ROWS_PER_1000);
}
