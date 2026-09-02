/**
 * 家計費目の初期 seed。 calc/2025_家計分析.xlsx「生活費の内訳」の分類を基にした 2 階層。
 * ユーザは UI から追加・改名できる。 名前は UNIQUE なので seed は「無ければ入れる」。
 */

export interface HouseholdCategorySeed {
  name: string;
  parent?: string;
  order: number;
}

export const HOUSEHOLD_FALLBACK_CATEGORY = "その他";

export const HOUSEHOLD_CATEGORY_SEED: HouseholdCategorySeed[] = [
  { name: "食費", order: 10 },
  { name: "食費(外食)", parent: "食費", order: 11 },
  { name: "食費(スーパー)", parent: "食費", order: 12 },
  { name: "食費(コンビニ)", parent: "食費", order: 13 },
  { name: "日用品", order: 20 },
  { name: "旅行・レジャー", order: 30 },
  { name: "交通", order: 40 },
  { name: "医療", order: 50 },
  { name: "教育", order: 60 },
  { name: "通信", order: 70 },
  { name: "光熱", order: 80 },
  { name: "住居", order: 90 },
  { name: "保険", order: 100 },
  { name: "税金・社会保険", order: 110 },
  { name: "ATM現金引出", order: 120 },
  { name: "娯楽・サブスク", order: 130 },
  { name: "衣服・美容", order: 140 },
  { name: HOUSEHOLD_FALLBACK_CATEGORY, order: 999 },
];

export interface HouseholdRuleSeed {
  pattern: string;
  category: string;
  priority: number;
  note?: string;
}

/** 明らかな店名だけを既定ルールにする。 迷うものは按分シート / 家計ルール画面でユーザが足す。 */
export const HOUSEHOLD_RULE_SEED: HouseholdRuleSeed[] = [
  { pattern: "セブン[-‐]?イレブン|ファミリーマート|ローソン|ミニストップ", category: "食費(コンビニ)", priority: 10 },
  { pattern: "イオン|イトーヨーカドー|ライフ|サミット|マルエツ|西友|業務スーパー|オーケー", category: "食費(スーパー)", priority: 20 },
  { pattern: "マクドナルド|スターバックス|ドトール|すき家|吉野家|松屋|サイゼリヤ|ガスト|丸亀製麺", category: "食費(外食)", priority: 30 },
  { pattern: "JR|ＪＲ|SUICA|PASMO|モバイルスイカ|東京メトロ|タクシー", category: "交通", priority: 40 },
  { pattern: "ドラッグ|マツモトキヨシ|ウエルシア|薬局|病院|クリニック|歯科", category: "医療", priority: 50 },
  { pattern: "電気|ガス|水道", category: "光熱", priority: 60 },
  { pattern: "ATM|引出|引き出し", category: "ATM現金引出", priority: 70 },
  { pattern: "NETFLIX|ネットフリックス|SPOTIFY|YOUTUBE|ニンテンドー|PLAYSTATION", category: "娯楽・サブスク", priority: 80 },
  { pattern: "ユニクロ|UNIQLO|GU|ZARA|美容|理容", category: "衣服・美容", priority: 90 },
  { pattern: "ホテル|旅館|JAL|ANA|航空|エクスペディア|EXPEDIA|BOOKING", category: "旅行・レジャー", priority: 100 },
];
