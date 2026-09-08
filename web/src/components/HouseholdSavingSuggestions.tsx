import type { SavingSuggestion } from "../../../src/shared/household-cash-flow";

/** サーバーが選んだ節制候補を、試算の前提を明示したまま表示する。
 * @implements SPEC-HOUSEHOLD-ANALYSIS-004 (spec/feature/household-bookkeeping.md) */

const yen = (amount: number): string => `¥${amount.toLocaleString("ja-JP")}`;

export function HouseholdSavingSuggestions({ suggestions }: { suggestions: SavingSuggestion[] }) {
  return <section aria-label="節制の見直し候補">
    <h3>節制の見直し候補</h3>
    <p>今期に記録された家計支出から、頻度や予算を調整しやすい費目を表示します。削減額は仮定の試算で、実現を保証するものではありません。期間途中の記録も含むため、取込状況を確認してください。</p>
    {suggestions.length === 0 ? <p>対象費目の支出記録がありません。家計費目の分類・取込状況を確認してください。</p> :
      <ul>{suggestions.map((suggestion) => <li key={suggestion.category_id}>
        <b>{suggestion.name}</b>：{yen(suggestion.amount)} / {suggestion.count}件。
        {suggestion.action} <strong>{suggestion.reduction_rate * 100}%削減の試算：{yen(suggestion.scenario_saving)}</strong>
      </li>)}</ul>}
  </section>;
}
