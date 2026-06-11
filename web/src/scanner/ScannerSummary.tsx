/**
 * confirm 演出が終わったあとの「全項目リスト」サマリーカード。
 *
 * 検出した本物 BB の値 (店名 / 日付 / 合計 / 各品目) を読みやすいリストで提示し、
 * 余韻 (やわらかい呼吸グロー) を出しながら待機する。画面タップで戻る。
 */

import type { DetectedRegion } from "./types.js";

interface Props {
  regions: DetectedRegion[];
  exiting: boolean;
}

const ORDER: Record<string, number> = { payee: 0, date: 1, items: 2, total: 9 };

function rank(r: DetectedRegion): number {
  if (r.id.startsWith("item-")) return 3;
  return ORDER[r.id] ?? 5;
}

export function ScannerSummary({ regions, exiting }: Props) {
  const rows = regions
    .filter((r) => r.source === "real" && r.kind !== "noise" && (r.value || r.recognizedText))
    .sort((a, b) => rank(a) - rank(b));

  if (rows.length === 0) return null;

  return (
    <div className={`sc-summary${exiting ? " is-exiting" : ""}`}>
      <div className="sc-summary-head">SCAN COMPLETE</div>
      <ul className="sc-summary-list">
        {rows.map((r, i) => (
          <li
            key={r.id}
            className="sc-summary-row"
            style={{
              "--sc-clr": r.color ?? "#00ffc8",
              // 一つずつ丁寧に: 行を順番にゆっくり出す
              animationDelay: `${i * 320}ms`,
            } as React.CSSProperties}
          >
            <span className="sc-summary-label">{r.label}</span>
            <span className="sc-summary-value">{r.value ?? r.recognizedText}</span>
          </li>
        ))}
      </ul>
      <div className="sc-summary-hint">タップで戻る</div>
    </div>
  );
}
