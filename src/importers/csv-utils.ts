/**
 * CSV パーサー (RFC 4180 準拠 + 日本クレカ CSV の癖を吸収)
 *
 * Node 標準にパーサーが無いので最小実装。 quote / escaped quote / CRLF を扱う。
 */

import iconv from "iconv-lite";

export function decodeBuffer(buf: Buffer, hint?: "utf8" | "sjis"): string {
  if (hint === "utf8") return buf.toString("utf8");
  if (hint === "sjis") return iconv.decode(buf, "Shift_JIS");
  // sniff: 最初の数 KB に UTF-8 で復号できないバイトが多いなら sjis
  return likelySjis(buf) ? iconv.decode(buf, "Shift_JIS") : buf.toString("utf8");
}

function likelySjis(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  // BOM があれば utf8 確定
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return false;
  let invalidUtf8 = 0;
  let i = 0;
  while (i < head.length) {
    const b = head[i]!;
    if (b < 0x80) { i++; continue; }
    // multi-byte utf8
    let len = 0;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else { invalidUtf8++; i++; continue; }
    let ok = true;
    for (let k = 1; k < len; k++) {
      const c = head[i + k];
      if (c == null || (c & 0xc0) !== 0x80) { ok = false; break; }
    }
    if (!ok) invalidUtf8++;
    i += len;
  }
  return invalidUtf8 > 4;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cur); cur = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; continue; }
    cur += ch;
    i++;
  }
  // 終端
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  // 末尾の空行除去
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}
