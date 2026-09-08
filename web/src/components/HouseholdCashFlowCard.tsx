import type { HouseholdCashFlow } from "../../../src/shared/household-cash-flow";

const yen = (amount: number): string => `¥${amount.toLocaleString("ja-JP")}`;
const rate = (value: number | null): string => value === null ? "算出不可" : `${(value * 100).toFixed(1)}%`;
const TRENDS: Record<HouseholdCashFlow["trend"], string> = {
  improving: "貯蓄率は上昇傾向", declining: "貯蓄率は低下傾向", stable: "貯蓄率は横ばい", insufficient_data: "貯蓄傾向は評価保留",
};

/** サーバーの収支・貯蓄傾向をそのまま表示し、画面側で判定し直さない。
 * @implements SPEC-HOUSEHOLD-ANALYSIS-004 (spec/feature/household-bookkeeping.md) */
export function HouseholdCashFlowCard({ flow }: { flow: HouseholdCashFlow }) {
  return <section aria-label="収入・支出と貯蓄傾向">
    <h3>収入・支出と貯蓄傾向</h3>
    <table>
      <thead><tr><th>項目</th><th>今期</th><th>前期</th></tr></thead>
      <tbody>
        <tr><th>入金（インカム）</th><td>{yen(flow.current.income)}</td><td>{yen(flow.previous.income)}</td></tr>
        <tr><th>家計支出</th><td>{yen(flow.current.household)}</td><td>{yen(flow.previous.household)}</td></tr>
        <tr><th>事業支出</th><td>{yen(flow.current.business)}</td><td>{yen(flow.previous.business)}</td></tr>
        <tr><th>支出合計（アウトカム）</th><td>{yen(flow.current.outflow)}</td><td>{yen(flow.previous.outflow)}</td></tr>
        <tr><th>収支差額（貯蓄余力の目安）</th><td>{yen(flow.current.balance)}</td><td>{yen(flow.previous.balance)}</td></tr>
        <tr><th>貯蓄率の目安</th><td>{rate(flow.current.savings_rate)}</td><td>{rate(flow.previous.savings_rate)}</td></tr>
      </tbody>
    </table>
    <p><b>{TRENDS[flow.trend]}</b>{flow.savings_rate_delta !== null &&
      `（前期比 ${flow.savings_rate_delta > 0 ? "+" : ""}${(flow.savings_rate_delta * 100).toFixed(1)} ポイント）`}</p>
    {flow.reasons.length > 0 && <ul>{flow.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    <p>収支差額 = 入金 − 家計支出 − 事業支出。貯蓄率 = 収支差額 ÷ 入金です。振替指定の取引は除外します。入金には売上・返金・借入などが含まれる可能性があり、未取込の取引や仕訳帳だけの手入力は含みません。実際の預金残高の増減とは異なります。</p>
    <h4>月別の収支（今期・前期）</h4>
    <table>
      <thead><tr><th>月</th><th>入金</th><th>支出</th><th>収支差額</th><th>貯蓄率</th></tr></thead>
      <tbody>{flow.monthly.map((month) => <tr key={month.month}>
        <th>{month.month}{month.is_partial ? "（期間の一部）" : ""}</th>
        <td>{yen(month.income)}</td><td>{yen(month.outflow)}</td><td>{yen(month.balance)}</td><td>{rate(month.savings_rate)}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
