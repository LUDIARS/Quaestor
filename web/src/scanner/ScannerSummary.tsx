/**
 * confirm 演出が終わったあとの「全項目リスト」サマリーカード。
 *
 * 確定値 (店名 / 日付 / 合計 / 各品目) を読みやすいリストで提示し、
 * 余韻 (やわらかい呼吸グロー) を出しながら待機する。画面タップで戻る。
 * 値さえあれば出す — heuristic (Fallback) 経路でもサマリーは欠けない。
 * 見出し直下に分類バッジ (書類種別 / サンプル区分) を添える。
 */

import type { DetectedRegion, ScanBadge } from "./types.js";

interface Props {
  regions: DetectedRegion[];
  exiting: boolean;
  badges?: ScanBadge[];
}

const ORDER: Record<string, number> = { payee: 0, date: 1, items: 2, total: 9 };

function rank(r: DetectedRegion): number {
  if (r.id.startsWith("item-")) return 3;
  return ORDER[r.id] ?? 5;
}

export function ScannerSummary({ regions, exiting, badges }: Props) {
  const rows = regions
    .filter((r) => r.kind !== "noise" && (r.value || r.recognizedText))
    .sort((a, b) => rank(a) - rank(b));

  if (rows.length === 0 && (!badges || badges.length === 0)) return null;

  return (
    <div className={`sc-summary${exiting ? " is-exiting" : ""}`}>
      <div className="sc-summary-head">SCAN COMPLETE</div>
      {badges && badges.length > 0 && (
        <div className="sc-summary-badges">
          {badges.map((b) => (
            <span
              key={b.id}
              className="sc-badge"
              style={{ "--sc-clr": b.color ?? "#00ffc8" } as React.CSSProperties}
            >
              {b.text}
            </span>
          ))}
        </div>
      )}
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
