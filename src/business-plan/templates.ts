/**
 * 事業計画の書類テンプレート定義 (書類形式の正本)。
 *
 * 各テンプレが「必要な記述セクション」と「必要な数字スペック」を宣言する。
 * 数字カテゴリは全テンプレ共通語彙 (quant.ts が統一解釈)。 spec/feature/business-plan.md 参照。
 */

export type PlanPurpose = "funding" | "subsidy" | "internal";

/** 数字の周期。 years=Y1..Yn / months=M1..M12 / single=base 1値 */
export type FigurePeriods = "years" | "months" | "single";

/** 全テンプレ共通の数字カテゴリ語彙 */
export type FigureCategory =
  | "sales"
  | "cogs"
  | "sga"
  | "fixed_cost"
  | "use_of_funds"
  | "funding"
  | "repayment"
  | "cashflow"
  | "value_added"
  | "labor_cost"
  | "depreciation";

export interface TemplateSection {
  key: string;
  title: string;
  hint?: string;
}

export interface TemplateFigureSpec {
  category: FigureCategory;
  label: string;
  periods: FigurePeriods;
  /** 自己資金など、 定量検算で特別扱いするためのフラグ */
  tag?: "own_funds" | "subsidy_grant";
  required?: boolean;
}

export interface PlanTemplate {
  id: string;
  name: string;
  purpose: PlanPurpose;
  /** 推奨計画年数 (horizon_years 既定) */
  horizonYears: number;
  description: string;
  sections: TemplateSection[];
  figures: TemplateFigureSpec[];
}

const JFC_STARTUP: PlanTemplate = {
  id: "jfc_startup",
  name: "日本政策金融公庫 創業計画書",
  purpose: "funding",
  horizonYears: 2,
  description:
    "日本政策金融公庫の創業融資で提出する創業計画書。 動機・略歴・商品・取引先・資金計画・事業見通しを記載する。",
  sections: [
    { key: "motive", title: "創業の動機", hint: "なぜこの事業を始めるのか。 きっかけ・想いを具体的に。" },
    { key: "career", title: "経営者の略歴・事業経験", hint: "勤務先・役職・在籍期間・身につけた経験。 事業との関連を示す。" },
    { key: "products", title: "取扱商品・サービスの内容", hint: "商品/サービスと売り。 セールスポイント・価格帯。" },
    { key: "customers", title: "取引先・取引関係等", hint: "販売先・仕入先・外注先。 シェアと掛取引条件。" },
    { key: "workforce", title: "従業員", hint: "常勤役員・従業員数 (家族従業員を含む)。" },
    { key: "borrowings", title: "お借入の状況", hint: "現在の借入 (住宅・車・カード等) の使途と残高・年間返済額。" },
    { key: "funds_plan", title: "必要な資金と調達方法 (補足)", hint: "設備/運転の内訳根拠と、 調達 (自己資金・借入) の裏付け。" },
    { key: "outlook", title: "事業の見通し", hint: "創業当初と軌道に乗った後の売上・原価・経費の根拠 (客数×単価 等)。" },
  ],
  figures: [
    { category: "use_of_funds", label: "設備資金", periods: "single", required: true },
    { category: "use_of_funds", label: "運転資金", periods: "single", required: true },
    { category: "funding", label: "自己資金", periods: "single", tag: "own_funds", required: true },
    { category: "funding", label: "親・兄弟・知人等からの借入", periods: "single" },
    { category: "funding", label: "日本政策金融公庫からの借入", periods: "single", required: true },
    { category: "funding", label: "その他金融機関等からの借入", periods: "single" },
    { category: "sales", label: "売上高", periods: "years", required: true },
    { category: "cogs", label: "売上原価 (仕入高)", periods: "years", required: true },
    { category: "sga", label: "人件費", periods: "years" },
    { category: "sga", label: "家賃", periods: "years" },
    { category: "sga", label: "支払利息", periods: "years" },
    { category: "sga", label: "その他経費", periods: "years" },
    { category: "repayment", label: "年間返済額", periods: "years", required: true },
  ],
};

const JIZOKUKA: PlanTemplate = {
  id: "jizokuka",
  name: "小規模事業者持続化補助金 経営計画書",
  purpose: "subsidy",
  horizonYears: 3,
  description:
    "小規模事業者持続化補助金の経営計画書 + 補助事業計画。 企業概要・市場・強み・経営方針と補助事業の内容/効果を記載。",
  sections: [
    { key: "overview", title: "企業概要", hint: "事業内容・売上構成・主要商品。 現状の経営状況。" },
    { key: "market", title: "顧客ニーズと市場の動向", hint: "ターゲット顧客のニーズと、 市場/競合の動向。" },
    { key: "strength", title: "自社や商品・サービスの強み", hint: "競合と比べた優位性。 顧客に選ばれる理由。" },
    { key: "policy", title: "経営方針・目標と今後のプラン", hint: "中期の方針と数値目標。 補助事業との関連。" },
    { key: "project_content", title: "補助事業で行う事業名・内容", hint: "今回の取組 (販路開拓・生産性向上) の具体的内容。" },
    { key: "project_effect", title: "補助事業の効果", hint: "売上・利益・認知への効果を定量で示す。" },
  ],
  figures: [
    { category: "use_of_funds", label: "補助対象経費", periods: "single", required: true },
    { category: "funding", label: "補助金交付申請額", periods: "single", tag: "subsidy_grant", required: true },
    { category: "funding", label: "自己負担額", periods: "single", tag: "own_funds", required: true },
    { category: "sales", label: "売上高", periods: "years", required: true },
    { category: "cogs", label: "売上原価", periods: "years" },
    { category: "sga", label: "販管費", periods: "years" },
  ],
};

const MONODUKURI: PlanTemplate = {
  id: "monodukuri",
  name: "ものづくり補助金 事業計画書",
  purpose: "subsidy",
  horizonYears: 3,
  description:
    "ものづくり補助金の事業計画書。 取組内容・将来展望・付加価値額 (年率+3%) の算出根拠を記載する。",
  sections: [
    { key: "current", title: "現状・課題", hint: "自社の現状と、 本事業で解決する課題。" },
    { key: "plan_content", title: "補助事業の具体的な取組内容", hint: "導入する設備/システムと、 革新的サービスの開発・生産プロセス。" },
    { key: "future", title: "将来の展望 (事業化に向けて)", hint: "想定market・顧客、 競合優位、 事業化スケジュール。" },
    { key: "value_added_basis", title: "付加価値額の算出根拠", hint: "付加価値額 = 営業利益+人件費+減価償却費。 年率3%以上の向上根拠。" },
  ],
  figures: [
    { category: "use_of_funds", label: "機械装置・システム構築費", periods: "single", required: true },
    { category: "funding", label: "補助金申請額", periods: "single", tag: "subsidy_grant", required: true },
    { category: "funding", label: "自己資金", periods: "single", tag: "own_funds", required: true },
    { category: "sales", label: "売上高", periods: "years", required: true },
    { category: "cogs", label: "売上原価", periods: "years" },
    { category: "sga", label: "販管費", periods: "years" },
    { category: "value_added", label: "付加価値額", periods: "years", required: true },
    { category: "labor_cost", label: "人件費", periods: "years" },
    { category: "depreciation", label: "減価償却費", periods: "years" },
  ],
};

const FREEFORM: PlanTemplate = {
  id: "freeform",
  name: "自由形式 (3期 P&L + 資金繰り)",
  purpose: "internal",
  horizonYears: 3,
  description: "汎用の事業計画。 3期の損益と初年度の月次資金繰りを持つ。",
  sections: [
    { key: "summary", title: "事業概要", hint: "何を・誰に・どう提供するか。" },
    { key: "market", title: "市場・競合", hint: "市場規模と競合、 自社のポジション。" },
    { key: "strategy", title: "事業戦略", hint: "売上を作る具体策と成長シナリオ。" },
    { key: "risks", title: "リスクと対策", hint: "想定リスクと低減策。" },
  ],
  figures: [
    { category: "sales", label: "売上高", periods: "years", required: true },
    { category: "cogs", label: "売上原価", periods: "years", required: true },
    { category: "sga", label: "販管費", periods: "years", required: true },
    { category: "use_of_funds", label: "設備資金", periods: "single" },
    { category: "use_of_funds", label: "運転資金", periods: "single" },
    { category: "funding", label: "自己資金", periods: "single", tag: "own_funds" },
    { category: "funding", label: "借入金", periods: "single" },
    { category: "repayment", label: "年間返済額", periods: "years" },
    { category: "cashflow", label: "期首残高", periods: "single" },
    { category: "cashflow", label: "月次純増減", periods: "months" },
  ],
};

export const TEMPLATES: PlanTemplate[] = [JFC_STARTUP, JIZOKUKA, MONODUKURI, FREEFORM];

export function getTemplate(id: string): PlanTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** period スペックを実 period キー配列に展開する */
export function expandPeriods(periods: FigurePeriods, horizonYears: number): string[] {
  if (periods === "single") return ["base"];
  if (periods === "months") return Array.from({ length: 12 }, (_, i) => `M${i + 1}`);
  return Array.from({ length: horizonYears }, (_, i) => `Y${i + 1}`);
}
