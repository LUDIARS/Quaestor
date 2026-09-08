/** Explicit discretionary categories; essential spending is never assumed reducible.
 * @implements SPEC-HOUSEHOLD-ANALYSIS-004 (spec/feature/household-bookkeeping.md) */
import type { SavingSuggestion } from "../../shared/household-cash-flow.js";

const REDUCTION_SCENARIO = 0.1;
const MAX_SUGGESTIONS = 5;
const ACTIONS: Readonly<Record<string, string>> = {
  "食費(外食)": "外食の回数や1回あたりの予算を見直し、可能な回だけ自炊へ置き換える。",
  "食費(コンビニ)": "飲料・間食など繰り返す購入を確認し、まとめ買いや持参に置き換えられるか検討する。",
  "娯楽・サブスク": "利用していない契約や重複するサービスを確認し、娯楽の予算を決める。",
  "旅行・レジャー": "予定ごとの予算を決め、頻度や宿泊・移動費を調整できるか検討する。",
  "衣服・美容": "必要な購入と延期できる購入を分け、購入頻度や予算を見直す。",
};

interface SuggestionCategory { category_id: number; name: string; current: number; count: number }

export function suggestSavings(categories: SuggestionCategory[]): SavingSuggestion[] {
  return categories.filter((category) => category.category_id !== 0 && category.current > 0 && Object.hasOwn(ACTIONS, category.name))
    .map((category) => ({
      category_id: category.category_id, name: category.name, amount: category.current, count: category.count,
      action: ACTIONS[category.name]!, scenario_saving: Math.floor(category.current * REDUCTION_SCENARIO),
      reduction_rate: REDUCTION_SCENARIO,
    }))
    .sort((a, b) => b.scenario_saving - a.scenario_saving || a.category_id - b.category_id)
    .slice(0, MAX_SUGGESTIONS);
}
