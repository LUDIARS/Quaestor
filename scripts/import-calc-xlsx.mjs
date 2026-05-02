/**
 * E:\calc\2025.xlsx (確定申告 2025) を Quaestor DB に流し込む。
 *
 * 移行対象 sheet:
 *   - クレカ(UFJ)        → transactions (credit-card, account="UFJクレカ")
 *   - クレカ(SMBC-1)     → transactions (credit-card, account="SMBC-1")
 *   - クレカ(SMBC-3)     → transactions (credit-card, account="SMBC-3")
 *   - 銀行明細(SMBC)     → transactions (bank, account="SMBC普通預金")
 *   - 銀行明細(UFJ)      → transactions (bank, account="UFJ普通預金")
 *   - 売上明細           → invoices (status="paid"、 transaction_id は後で reconcile)
 *
 * 使用 (tsx 必須 — TS source を直接読むため):
 *   npx tsx scripts/import-calc-xlsx.mjs E:/calc/2025.xlsx
 *   npx tsx scripts/import-calc-xlsx.mjs E:/calc/2025.xlsx --db ./app_data/quaestor.db
 *
 * 同一 source_id の重複は INSERT で skip される (UNIQUE 制約)。
 * 実行後に各 sheet ごとの inserted / duplicates / skipped 件数を summary 出力。
 */

import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";
import Database from "better-sqlite3";

import { applyMigrations } from "../src/db/schema.ts";
import { TransactionsRepo } from "../src/db/transactions-repo.ts";
import { InvoicesRepo } from "../src/db/invoices-repo.ts";
import { AccountCodesRepo } from "../src/db/account-codes-repo.ts";
import { ApportionmentRulesRepo } from "../src/db/apportionment-rules-repo.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

// ── 引数解析 ──
const args = process.argv.slice(2);
const xlsxPath = args.find((a) => !a.startsWith("--"));
if (!xlsxPath) {
  console.error("usage: npx tsx scripts/import-calc-xlsx.mjs <xlsx-path> [--db <db-path>]");
  process.exit(1);
}
const dbArg = args.indexOf("--db");
const dbPath = dbArg >= 0 ? resolve(args[dbArg + 1]) : resolve(PROJECT_ROOT, "app_data", "quaestor.db");

mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
applyMigrations(db);
new AccountCodesRepo(db).seedIfEmpty();
new ApportionmentRulesRepo(db).seedIfEmpty();
const txs = new TransactionsRepo(db);
const invoices = new InvoicesRepo(db);

const wb = new ExcelJS.Workbook();
console.log(`reading: ${xlsxPath}`);
await wb.xlsx.readFile(xlsxPath);

// ── helpers ──
function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "string") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

function toNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "object" && "result" in v) {
    return typeof v.result === "number" ? Math.round(v.result) : null;
  }
  if (typeof v === "string") {
    const cleaned = v.replace(/[,，\s　円¥]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
  return String(v).trim();
}

function stableSourceId(prefix, parts) {
  const h = createHash("sha1");
  h.update(parts.join("\x1f"));
  return `${prefix}:${h.digest("hex").slice(0, 16)}`;
}

// ── credit card sheets ──

/**
 * クレカ(UFJ) — header 行なし、 row 1 から data。
 * col A: date, col B: 'V0006', col C: 1回払い 等, col D: shop, col E: amount, col K: rate, col L: memo
 */
function importUfjCard() {
  const sheet = wb.getWorksheet("クレカ(UFJ)");
  if (!sheet) return { skipped: 0, inserted: 0, duplicates: 0, sheet: "(missing)" };
  const rows = [];
  let skipped = 0;
  for (let i = 1; i <= sheet.rowCount; i++) {
    const r = sheet.getRow(i);
    const date = toIsoDate(r.getCell(1).value);
    if (!date) { skipped++; continue; }
    const payee = toText(r.getCell(4).value);
    const amount = toNumber(r.getCell(5).value);
    if (!payee || !amount) { skipped++; continue; }
    const memo = toText(r.getCell(12).value);
    const sourceId = stableSourceId("ufj", ["UFJクレカ", date, amount, payee, memo, i]);
    rows.push({
      date,
      amount_in: null,
      amount_out: amount,
      currency: "JPY",
      fx_amount: null,
      fx_currency: null,
      description: memo || payee,
      payee,
      source: "credit-card",
      source_id: sourceId,
      account: "UFJクレカ",
      metadata: { brand: "ufj", calc_row: i, memo, raw_payment_kind: toText(r.getCell(3).value) },
    });
  }
  const r = txs.insertBulk(rows);
  return { sheet: "クレカ(UFJ)", inserted: r.inserted, duplicates: r.duplicates, skipped };
}

/**
 * クレカ(SMBC-N) 共通 (header 行なし、 SMBC-1 のみ row 2 がカード番号情報)。
 * col A: date, col B: shop, col C: amount, col D-E: 1 1, col F: amount dup, col H: rate, col I: rate amount, col J: code
 */
function importSmbcCard(sheetName, account, headerRows) {
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) return { skipped: 0, inserted: 0, duplicates: 0, sheet: `${sheetName} (missing)` };
  const rows = [];
  let skipped = 0;
  for (let i = headerRows + 1; i <= sheet.rowCount; i++) {
    const r = sheet.getRow(i);
    const date = toIsoDate(r.getCell(1).value);
    if (!date) { skipped++; continue; }
    const payee = toText(r.getCell(2).value);
    const amount = toNumber(r.getCell(3).value);
    if (!payee || !amount) { skipped++; continue; }
    const sourceId = stableSourceId("smbc", [account, date, amount, payee, i]);
    rows.push({
      date,
      amount_in: null,
      amount_out: amount,
      currency: "JPY",
      fx_amount: null,
      fx_currency: null,
      description: payee,
      payee,
      source: "credit-card",
      source_id: sourceId,
      account,
      metadata: { brand: "smbc", card_account: account, calc_row: i },
    });
  }
  const r = txs.insertBulk(rows);
  return { sheet: sheetName, inserted: r.inserted, duplicates: r.duplicates, skipped };
}

/**
 * 銀行明細(SMBC|UFJ) — row 1 header.
 * col A: date, col B: お引出し, col C: お預入れ, col D: 摘要, col E: 残高, col F: memo
 */
function importBank(sheetName, account) {
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) return { skipped: 0, inserted: 0, duplicates: 0, sheet: `${sheetName} (missing)` };
  const rows = [];
  let skipped = 0;
  for (let i = 2; i <= sheet.rowCount; i++) {
    const r = sheet.getRow(i);
    const date = toIsoDate(r.getCell(1).value);
    if (!date) { skipped++; continue; }
    const payout = toNumber(r.getCell(2).value);
    const deposit = toNumber(r.getCell(3).value);
    const desc = toText(r.getCell(4).value) || "(no memo)";
    const balance = toNumber(r.getCell(5).value);
    const memo = toText(r.getCell(6).value);
    if (payout == null && deposit == null) {
      // 残高のみの行 (期首残高等) は skip
      skipped++;
      continue;
    }
    const sourceId = stableSourceId("bank", [account, date, payout ?? "", deposit ?? "", desc, i]);
    rows.push({
      date,
      amount_in: deposit,
      amount_out: payout,
      currency: "JPY",
      fx_amount: null,
      fx_currency: null,
      description: desc,
      payee: desc,
      source: "bank",
      source_id: sourceId,
      account,
      metadata: { brand: account.includes("SMBC") ? "smbc-bank" : "ufj-bank", balance, memo, calc_row: i },
    });
  }
  const r = txs.insertBulk(rows);
  return { sheet: sheetName, inserted: r.inserted, duplicates: r.duplicates, skipped };
}

/**
 * 売上明細 — header 行 1 で data row 2 から。
 * col A: date, col B: client, col C: 売上, col D: 源泉徴収額, col E: 振込額
 * → invoices に status='paid' で挿入。
 */
function importSales() {
  const sheet = wb.getWorksheet("売上明細");
  if (!sheet) return { skipped: 0, inserted: 0, sheet: "売上明細 (missing)" };
  let skipped = 0;
  let inserted = 0;
  for (let i = 2; i <= sheet.rowCount; i++) {
    const r = sheet.getRow(i);
    const date = toIsoDate(r.getCell(1).value);
    if (!date) { skipped++; continue; }
    const client = toText(r.getCell(2).value);
    const amount = toNumber(r.getCell(3).value);
    const withholding = toNumber(r.getCell(4).value) ?? 0;
    if (!client || !amount) { skipped++; continue; }
    invoices.insert({
      issued_at: date,
      due_date: null,
      client,
      work_summary: `${client} ${date.slice(0, 7)} 業務`,
      amount,
      withholding_tax: withholding,
      status: "paid",
      notes: "calc xlsx 移行",
      metadata: { from: "calc/2025.xlsx", source_row: i },
    });
    inserted++;
  }
  return { sheet: "売上明細", inserted, duplicates: 0, skipped };
}

// ── run ──
const results = [
  importUfjCard(),
  importSmbcCard("クレカ(SMBC-1)", "SMBC-1", 2),
  importSmbcCard("クレカ(SMBC-3)", "SMBC-3", 1),
  importBank("銀行明細(SMBC)", "SMBC普通預金"),
  importBank("銀行明細(UFJ)", "UFJ普通預金"),
  importSales(),
];

console.log("\n=== Import summary ===");
console.log("DB:", dbPath);
console.log();
let totalIns = 0, totalDup = 0, totalSkip = 0;
for (const r of results) {
  console.log(
    `${r.sheet.padEnd(25)} | inserted ${String(r.inserted).padStart(4)} | duplicates ${String(r.duplicates ?? 0).padStart(4)} | skipped ${String(r.skipped).padStart(4)}`,
  );
  totalIns += r.inserted;
  totalDup += r.duplicates ?? 0;
  totalSkip += r.skipped;
}
console.log("─".repeat(72));
console.log(
  `${"TOTAL".padEnd(25)} | inserted ${String(totalIns).padStart(4)} | duplicates ${String(totalDup).padStart(4)} | skipped ${String(totalSkip).padStart(4)}`,
);

db.close();
