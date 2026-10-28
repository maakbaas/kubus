import type { SourceConfig } from "./connector.ts";
import { HttpTableConnector } from "./httpTable.ts";

// CSV over HTTP (kind "csv"), e.g. a published Google Sheet (File → Share → Publish to web → CSV):
// one document (and its next pages) whose first row names the columns. Read as RFC 4180 has it
// (quoted values with "" for a quote and line breaks inside, CRLF or LF) by its own parser; the
// delimiter is the one of `,` `;` and tab the header row has most of. Every value is text, so
// numbers, true / false and dates are inferred (httpTable.ts), "1,5" a number only when the
// delimiter isn't a comma and no value of the column has a dot. A header left empty is named by its
// place ("Column 3"), one used twice gets a number ("Name 2").

const ACCEPTS = /^(text\/(csv|plain|comma-separated-values|tab-separated-values)|application\/(csv|octet-stream|vnd\.ms-excel))\b/;

const DELIMITERS = [",", ";", "\t"];

/** The delimiter of a CSV text: the one its first row has most of outside quotes (a comma when none). */
export function csvDelimiter(text: string): string {
  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  return DELIMITERS.reduce((best, d) => (counts.get(d)! > counts.get(best)! ? d : best));
}

/** CSV text as rows of values (RFC 4180; empty lines left out). An unclosed quote is a problem. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let openedOn = 0;
  const endField = () => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "" && !wasQuoted) {
      quoted = wasQuoted = true;
      openedOn = line;
    } else if (c === delimiter) endField();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRow();
    } else field += c;
  }
  if (quoted) throw new Error(`The CSV has a quoted value that isn't closed (from line ${openedOn})`);
  if (field !== "" || row.length) endRow();
  return rows;
}

/** Column names from a header row, `count` of them: trimmed, an empty one named by its place, each its own (case aside). */
export function csvHeader(names: string[], count = names.length): string[] {
  const taken = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = (names[i] ?? "").trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** A CSV text's rows as records by column name, and whether "1,5" may be a number. */
export function csvRecords(text: string): { records: Record<string, unknown>[]; options: { text: true; decimalComma: boolean } } {
  const delimiter = csvDelimiter(text);
  const [header, ...rows] = parseCsv(text, delimiter);
  const options = { text: true as const, decimalComma: delimiter !== "," };
  if (!header) return { records: [], options };
  const names = csvHeader(header, rows.reduce((n, r) => Math.max(n, r.length), header.length));
  return { records: rows.map((r) => Object.fromEntries(names.map((name, i) => [name, r[i] ?? null]))), options };
}

export class CsvConnector extends HttpTableConnector {
  constructor(config: SourceConfig) {
    super(config, { kind: "csv", what: "CSV", accepts: (t) => ACCEPTS.test(t), table: "rows", records: (doc) => csvRecords(doc.text) });
  }
}
