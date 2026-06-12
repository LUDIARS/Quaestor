/**
 * 検知 BB から離して描く「演出コールアウト」レイヤー。
 *
 * confirm フェーズで source=real の領域に対して:
 *   - リーダー線 (SVG): BB の辺 → callout
 *   - callout ボックス: ラベル / 認識テキスト / 値 / 信頼度バー
 * を描画する。BB 本体 (枠) は ScannerOverlay 側がタイトに描く。
 *
 * 配置座標は callout-layout.layoutCallouts() が計算済 (純関数)。
 */

import type { DetectedRegion } from "./types.js";
import type { CalloutPlacement } from "./callout-layout.js";

export interface CalloutItem {
  region: DetectedRegion;
  placement: CalloutPlacement;
  /** BB アニメと同期させる遅延 (ms) */
  delay: number;
}

interface Props {
  container: { width: number; height: number };
  items: CalloutItem[];
}

export function ScannerCallouts({ container, items }: Props) {
  if (items.length === 0) return null;

  return (
    <>
      {/* リーダー線 (SVG オーバーレイ) */}
      <svg
        className="sc-leaders"
        width={container.width}
        height={container.height}
        viewBox={`0 0 ${container.width} ${container.height}`}
        aria-hidden
      >
        {items.map(({ region, placement, delay }) => {
          const clr = region.color ?? "#00ffc8";
          return (
            <g key={`leader-${region.id}`}>
              <line
                className="sc-leader-line"
                x1={placement.from.x} y1={placement.from.y}
                x2={placement.to.x}   y2={placement.to.y}
                stroke={clr}
                style={{ animationDelay: `${delay}ms` }}
              />
              <circle
                className="sc-leader-dot"
                cx={placement.from.x} cy={placement.from.y}
                r={2.5}
                fill={clr}
                style={{ animationDelay: `${delay}ms` }}
              />
            </g>
          );
        })}
      </svg>

      {/* callout ボックス群 */}
      {items.map(({ region, placement, delay }) => {
        const clr = region.color ?? "#00ffc8";
        const text = region.recognizedText ?? region.value;
        return (
          <div
            key={`callout-${region.id}`}
            className={`sc-callout sc-callout--${placement.side}`}
            style={{
              left: placement.callout.left,
              top: placement.callout.top,
              width: placement.callout.width,
              animationDelay: `${delay}ms`,
              "--sc-clr": clr,
            } as React.CSSProperties}
          >
            <div className="sc-callout-label">{region.label}</div>
            {text && <div className="sc-callout-value">{text}</div>}
            <div className="sc-callout-bar-wrap">
              <div
                className="sc-callout-bar"
                style={{
                  width: `${Math.round(region.confidence * 100)}%`,
                  animationDelay: `${delay}ms`,
                } as React.CSSProperties}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
