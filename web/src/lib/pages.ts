/** ページ定義の正本。 Nav / MobileHome / App が共有する。
 * @implements SPEC-MOBILE-HOME-001 (spec/feature/mobile-home.md) */

export type Page =
  | "dashboard" | "bookkeeping" | "financial" | "depreciation" | "apportionment-sheet"
  | "scan" | "receipts" | "imports" | "profiles" | "transactions" | "reconcile"
  | "household" | "cost-structure" | "invest" | "portfolio"
  | "invoices" | "business-plan" | "subsidies"
  | "export" | "settings";

export type NavSection = "記帳" | "取込" | "家計・資産" | "事業" | "設定";

export interface PageDef {
  key: Page;
  label: string;
  section: NavSection;
}

export const NAV_SECTIONS: readonly NavSection[] = ["記帳", "取込", "家計・資産", "事業", "設定"];

export const PAGES: readonly PageDef[] = [
  { key: "dashboard", label: "ダッシュボード", section: "記帳" },
  { key: "bookkeeping", label: "簿記", section: "記帳" },
  { key: "financial", label: "決算書", section: "記帳" },
  { key: "depreciation", label: "減価償却", section: "記帳" },
  { key: "apportionment-sheet", label: "按分シート", section: "記帳" },
  { key: "scan", label: "スキャン", section: "取込" },
  { key: "receipts", label: "レシート", section: "取込" },
  { key: "imports", label: "明細取込", section: "取込" },
  { key: "profiles", label: "明細プロファイル", section: "取込" },
  { key: "transactions", label: "取引", section: "取込" },
  { key: "reconcile", label: "突合", section: "取込" },
  { key: "household", label: "家計分析", section: "家計・資産" },
  { key: "cost-structure", label: "固定費・変動費", section: "家計・資産" },
  { key: "invest", label: "投資・優待", section: "家計・資産" },
  { key: "portfolio", label: "積立・資産", section: "家計・資産" },
  { key: "invoices", label: "請求書", section: "事業" },
  { key: "business-plan", label: "事業計画", section: "事業" },
  { key: "subsidies", label: "補助金", section: "事業" },
  { key: "export", label: "エクスポート", section: "設定" },
  { key: "settings", label: "設定", section: "設定" },
];

/** 訪問履歴が無いときの「よく使うページ」 */
export const DEFAULT_FREQUENT: readonly Page[] = ["scan", "receipts", "household", "bookkeeping", "transactions", "reconcile"];

export function isPage(v: string | null | undefined): v is Page {
  return PAGES.some((p) => p.key === v);
}

export function pageLabel(key: Page): string {
  return PAGES.find((p) => p.key === key)?.label ?? key;
}
