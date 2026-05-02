/**
 * 既存 transactions に対し is_transfer フラグを retroactive に update。
 * パターンに合致する bank の引落 / 入金を「振替」 と判定する。
 *
 * 使用: npx tsx scripts/mark-transfers.mjs [--db <path>]
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const dbArg = process.argv.indexOf("--db");
const dbPath = dbArg >= 0
  ? resolve(process.argv[dbArg + 1])
  : resolve(PROJECT_ROOT, "app_data", "quaestor.db");

const TRANSFER_PATTERNS = [
  "ﾐﾂﾋﾞｼ.*-ﾄﾞ",          // ﾐﾂﾋﾞｼ ｴﾌｼﾞｴｲｶｰﾄﾞ (UFJ クレカ引落、 全角混在)
  "ﾐﾂｲｽﾐﾄﾓｶ.*-ﾄﾞ",       // ﾐﾂｲｽﾐﾄﾓｶｰﾄﾞ (SMBC クレカ引落)
  "カード\\s*ﾐﾂﾋﾞｼ",       // SMBC bank の "カード ﾐﾂﾋﾞｼ" 表記
  "カード\\s*ﾐﾂｲｽﾐﾄﾓ",
  "カード\\s*[Vｖ][Iiｉ][Sｓ][Aａ]",
  "カ[－－ー]ド",          // UFJ bank の "カ－ド" 表記 (全角/長音記号 ハイフン揺れ)
  "^ｸﾚｼﾞｯﾄ",
  "クレジット",
  "ことら送金",
  "ｴｽﾋﾞ-?ｱｲｼﾖｳｹﾝ",       // パソコン振込 SBI 証券
  "ＳＢＩ\\s*証券",
  "振替\\s*[ＳS][ＢB][ＩI]",
  "ﾌﾘｺﾐ\\s*ｴｽﾋﾞ",
];

const db = new Database(dbPath);
applyMigrations(db);

// better-sqlite3 に REGEXP は無いので JS-side で filter する
const rows = db
  .prepare(`SELECT id, description FROM transactions WHERE source='bank' AND is_transfer=0`)
  .all();
const compiled = TRANSFER_PATTERNS.map((p) => new RegExp(p));
const upd = db.prepare(`UPDATE transactions SET is_transfer = 1, updated_at = ? WHERE id = ?`);
const tx = db.transaction((ids) => {
  const now = Math.floor(Date.now() / 1000);
  for (const id of ids) upd.run(now, id);
});
const targetIds = rows
  .filter((r) => compiled.some((re) => re.test(r.description ?? "")))
  .map((r) => r.id);
tx(targetIds);
console.log(`scanned ${rows.length} bank rows, marked ${targetIds.length} as is_transfer=1`);

const inflow = db
  .prepare(`SELECT COALESCE(SUM(amount_in),0) AS s FROM transactions WHERE is_transfer=0`)
  .get();
const outflow = db
  .prepare(`SELECT COALESCE(SUM(amount_out),0) AS s FROM transactions WHERE is_transfer=0`)
  .get();
console.log(`non-transfer totals: in=¥${inflow.s.toLocaleString()} / out=¥${outflow.s.toLocaleString()}`);

db.close();
