import type { HouseholdEvaluation } from "../../../src/shared/household-evaluation";

const LABELS: Record<HouseholdEvaluation["status"], string> = {
  increased: "家計支出が増加", decreased: "家計支出が減少",
  stable: "家計支出は横ばい", insufficient_data: "評価保留",
};
const dailyYen = (amount: number): string => `¥${amount.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}/日`;

/** Display the server's evaluation and its evidence without recalculating the verdict.
 * @implements SPEC-HOUSEHOLD-ANALYSIS-003 (spec/feature/household-bookkeeping.md) */
export function HouseholdEvaluationCard({ evaluation }: { evaluation: HouseholdEvaluation }) {
  return (
    <section aria-label="家計支出の評価">
      <h3>{LABELS[evaluation.status]}</h3>
      {evaluation.reasons.length > 0 && <ul>{evaluation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      {evaluation.change_rate !== null && <p>
        今期 {dailyYen(evaluation.current_daily)} / 前期 {dailyYen(evaluation.previous_daily)}
        {" "}（前期比 {evaluation.change_rate > 0 ? "+" : ""}{(evaluation.change_rate * 100).toFixed(1)}%）
      </p>}
      <p>事業経費を除いた家計支出を期間の日数で割り、前期比 ±{evaluation.threshold * 100}% 以上を増加・減少としています。</p>
      <p>取込済みデータに基づく参考評価です。明細の取込漏れは判別できません。収入・予算に対する健全性や支出の必要性は評価していません。</p>
      {evaluation.drivers.length > 0 && <>
        <h4>増減への影響が大きい費目</h4>
        <ul>{evaluation.drivers.map((driver) => <li key={driver.category_id}>
          {driver.name}: {driver.daily_delta > 0 ? "+" : "−"}{dailyYen(Math.abs(driver.daily_delta))}
        </li>)}</ul>
      </>}
    </section>
  );
}
