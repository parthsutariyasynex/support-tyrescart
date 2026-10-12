// Reads quick replies from a phpMyAdmin/mysqldump file of the TyresCart site's `klever_tyres_chat` table.
// Only the INSERT ... VALUES rows are parsed, as data: nothing in the file is executed (no DROP/CREATE).

export type ImportedQuickReply = {
  shortcut: string;
  description: string | null;
  category: string | null;
  createdBy: bigint | null;
  updatedBy: bigint | null;
  status: number;
  sortOrder: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type Value = string | number | null;

// MySQL string escapes used by dumps
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a' };

// Parses `(v1, v2, ...), (...), ...;` starting at `i`. Returns the rows and where parsing stopped.
function parseTuples(sql: string, i: number): Value[][] {
  const rows: Value[][] = [];
  let row: Value[] | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ';' && !row) break;
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' && !row) {
      row = [];
      i++;
      continue;
    }
    if (ch === ')' && row) {
      rows.push(row);
      row = null;
      i++;
      continue;
    }
    if (!row) throw new Error(`Unexpected "${ch}" at ${i}`);
    if (ch === "'") {
      let out = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw new Error('Unterminated string');
        const c = sql[i];
        if (c === '\\') {
          const next = sql[i + 1];
          out += ESCAPES[next] ?? next; // \' \" \\ and the named escapes
          i += 2;
        } else if (c === "'" && sql[i + 1] === "'") {
          out += "'";
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else {
          out += c;
          i++;
        }
      }
      row.push(out);
      continue;
    }
    const m = /^(NULL|-?\d+(?:\.\d+)?)/i.exec(sql.slice(i));
    if (!m) throw new Error(`Unexpected value at ${i}: ${sql.slice(i, i + 20)}`);
    row.push(m[1].toUpperCase() === 'NULL' ? null : Number(m[1]));
    i += m[1].length;
  }
  return rows;
}

// Dump timestamps are written with time_zone = "+00:00", so they are UTC
const utc = (v: Value) => (typeof v === 'string' && v ? new Date(`${v.replace(' ', 'T')}Z`) : null);
const big = (v: Value) => (v === null ? null : BigInt(v));

export function parseQuickReplyDump(sql: string): ImportedQuickReply[] {
  const replies: ImportedQuickReply[] = [];
  const insert = /INSERT INTO `klever_tyres_chat`\s*\(([^)]*)\)\s*VALUES/gi;
  for (let m = insert.exec(sql); m; m = insert.exec(sql)) {
    const columns = m[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    for (const values of parseTuples(sql, m.index + m[0].length)) {
      if (values.length !== columns.length) throw new Error(`Row has ${values.length} values for ${columns.length} columns`);
      const r = Object.fromEntries(columns.map((c, k) => [c, values[k]])) as Record<string, Value>;
      if (typeof r.shortcut !== 'string' || !r.shortcut.trim()) continue;
      replies.push({
        shortcut: r.shortcut.trim(),
        description: (r.description as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        createdBy: big(r.created_by ?? null),
        updatedBy: big(r.updated_by ?? null),
        status: Number(r.status ?? 1),
        sortOrder: Number(r.sort_order ?? 0),
        createdAt: utc(r.created_at ?? null),
        updatedAt: utc(r.updated_at ?? null),
      });
    }
  }
  return replies;
}

// Emojis lost before the export: a 4-byte emoji written through a 3-byte (utf8/utf8mb3) MySQL connection
// becomes "?", often still followed by its invisible variation selector (U+FE0F, which fits in 3 bytes).
// Counts the likely spots: "?" + U+FE0F, or a "?" standing on its own (not ending a word). Report only:
// the original emoji can't be recovered from the text, so nothing is replaced.
export function possibleLostEmojis(text: string | null): number {
  if (!text) return 0;
  return (text.match(/\?️|(?:^|[\s"(])\?(?=$|[\s")])/gm) ?? []).length;
}
