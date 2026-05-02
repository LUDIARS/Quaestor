/**
 * E:\calc\2025.xlsx の決算書 + 家計分析 を financial_statements テーブルに取り込む。
 *
 * 取込元 sheet:
 *   - 決算書① (損益計算書): pl section
 *   - 決算書② (月別売上 + 雑収入): monthly_sales section
 *   - 決算書④ (貸借対照表): bs_assets / bs_liabilities
 *   - 家計分析.xlsx 年間サマリー: summary section
 *
 * 使用:
 *   npx tsx scripts/import-financial-statement.mjs E:/calc/2025.xlsx 2025
 *   npx tsx scripts/import-financial-statement.mjs E:/calc/2025.xlsx 2025 \
 *     --kakei E:/calc/2025_家計分析.xlsx
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";

import { applyMigrations } from "../src/db/schema.ts";
import { FinancialStatementsRepo } from "../src/db/financial-statements-repo.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

const args = process.argv.slice(2);
const xlsxPath = args.find((a) => !a.startsWith("--") && a.endsWith(".xlsx"));
const yearArg = args.find((a) => /^\d{4}$/.test(a));
if (!xlsxPath || !yearArg) {
  console.error("usage: npx tsx scripts/import-financial-statement.mjs <xlsx> <year> [--kakei <kakei.xlsx>] [--db <db>]");
  process.exit(1);
}
const year = parseInt(yearArg, 10);
const kakeiArg = args.indexOf("--kakei");
const kakeiPath = kakeiArg >= 0 ? args[kakeiArg + 1] : null;
const dbArg = args.indexOf("--db");
const dbPath = dbArg >= 0 ? resolve(args[dbArg + 1]) : resolve(PROJECT_ROOT, "app_data", "quaestor.db");

const db = new Database(dbPath);
applyMigrations(db);
const fsRepo = new FinancialStatementsRepo(db);

function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "object" && "result" in v) return typeof v.result === "number" ? Math.round(v.result) : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[,，\s　]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
  if (typeof v === "object" && "richText" in v) {
    return v.richText.map((t) => t.text).join("").trim();
  }
  return String(v).trim();
}

// ── 決算書① 損益計算書 ──
function importPL(wb) {
  const s = wb.getWorksheet("決算書①");
  if (!s) return 0;
  fsRepo.clearSection(year, "pl");
  let order = 0;
  let inserted = 0;

  // 売上 (収入) は r13 col E に固定値
  const sales = num(s.getCell(`E13`).value);
  if (sales != null) {
    fsRepo.upsert({ year, section: "pl", label: "売上 (収入) 金額", amount: sales, display_order: ++order, source: "imported" });
    inserted++;
  }
  const grossDiff = num(s.getCell(`E22`).value);
  if (grossDiff != null) {
    fsRepo.upsert({ year, section: "pl", label: "差引金額 (1-6)", amount: grossDiff, display_order: ++order, source: "imported" });
    inserted++;
  }

  // 経費科目 (label = col C, amount = col E)。 r25 から経費領域。
  // 順次 26 件くらい走査 (重複ラベルは最後勝ちで OK)
  const seen = new Set();
  for (let i = 25; i <= s.rowCount; i++) {
    const label = str(s.getCell(`C${i}`).value);
    const amount = num(s.getCell(`E${i}`).value);
    if (!label || amount == null) continue;
    // 重複ラベル (formula merged 等) は 1 件のみ
    if (seen.has(label)) continue;
    seen.add(label);
    fsRepo.upsert({ year, section: "pl", label, amount, display_order: ++order, source: "imported" });
    inserted++;
  }
  return inserted;
}

// ── 決算書② 月別売上 ──
function importMonthlySales(wb) {
  const s = wb.getWorksheet("②");
  if (!s) return 0;
  fsRepo.clearSection(year, "monthly_sales");
  let inserted = 0;
  // r9 〜 r21 が 1 月〜12 月 (重複行ある)、 r25 が 計
  const seen = new Set();
  for (let i = 9; i <= 25; i++) {
    const monthCell = s.getCell(`B${i}`).value;
    const amountCell = s.getCell(`C${i}`).value;
    let label;
    if (typeof monthCell === "number") {
      label = `${year}-${String(monthCell).padStart(2, "0")}`;
    } else if (str(monthCell) === "計") {
      label = `${year} 計`;
    } else if (str(monthCell).includes("家事")) {
      label = "家事消費等";
    } else if (str(monthCell).includes("雑収入")) {
      label = "雑収入";
    } else {
      continue;
    }
    if (seen.has(label)) continue;
    seen.add(label);
    const amount = num(amountCell);
    if (amount == null) continue;
    fsRepo.upsert({ year, section: "monthly_sales", label, amount, display_order: i - 8, source: "imported" });
    inserted++;
  }
  return inserted;
}

// ── 決算書④ 貸借対照表 ──
function importBS(wb) {
  const s = wb.getWorksheet("④");
  if (!s) return { assets: 0, liabilities: 0 };
  fsRepo.clearSection(year, "bs_assets");
  fsRepo.clearSection(year, "bs_liabilities");
  // 資産: col B=label, col C=期首, col D=期末
  // 負債: col E=label, col F=期首, col G=期末
  // r5 = header、 r6〜30 がデータ、 r30 = 合計
  let assets = 0, liabilities = 0;
  for (let i = 6; i <= 30; i++) {
    const aLabel = str(s.getCell(`B${i}`).value);
    const aOpen = num(s.getCell(`C${i}`).value);
    const aClose = num(s.getCell(`D${i}`).value);
    if (aLabel && (aOpen != null || aClose != null)) {
      fsRepo.upsert({
        year,
        section: "bs_assets",
        label: aLabel,
        amount: aClose ?? aOpen,
        display_order: i,
        metadata: { opening: aOpen, closing: aClose },
        source: "imported",
      });
      assets++;
    }
    const lLabel = str(s.getCell(`E${i}`).value);
    const lOpen = num(s.getCell(`F${i}`).value);
    const lClose = num(s.getCell(`G${i}`).value);
    if (lLabel && (lOpen != null || lClose != null)) {
      fsRepo.upsert({
        year,
        section: "bs_liabilities",
        label: lLabel,
        amount: lClose ?? lOpen,
        display_order: i,
        metadata: { opening: lOpen, closing: lClose },
        source: "imported",
      });
      liabilities++;
    }
  }
  return { assets, liabilities };
}

// ── 家計分析.xlsx 年間サマリー ──
async function importKakei(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const s = wb.getWorksheet("年間サマリー");
  if (!s) return 0;
  fsRepo.clearSection(year, "summary");
  let inserted = 0;
  let order = 0;
  // 行を走査して label + amount のペアを取る
  for (let i = 1; i <= s.rowCount; i++) {
    const label = str(s.getCell(`A${i}`).value);
    const amount = num(s.getCell(`B${i}`).value);
    if (!label || amount == null) continue;
    if (label.startsWith("■") || label === "項目") continue;
    fsRepo.upsert({ year, section: "summary", label, amount, display_order: ++order, source: "imported" });
    inserted++;
  }
  return inserted;
}

// ── run ──
const wb = new ExcelJS.Workbook();
console.log(`reading: ${xlsxPath}`);
await wb.xlsx.readFile(xlsxPath);

const plCount = importPL(wb);
const monthlyCount = importMonthlySales(wb);
const bs = importBS(wb);
let summaryCount = 0;
if (kakeiPath) {
  console.log(`reading kakei: ${kakeiPath}`);
  summaryCount = await importKakei(kakeiPath);
}

console.log(`\n=== Year ${year} financial statement imported ===`);
console.log(` 損益計算書 (pl):       ${plCount} rows`);
console.log(` 月別売上:              ${monthlyCount} rows`);
console.log(` 貸借対照表 資産:       ${bs.assets} rows`);
console.log(` 貸借対照表 負債・資本: ${bs.liabilities} rows`);
console.log(` 家計サマリ (summary):  ${summaryCount} rows`);

db.close();
