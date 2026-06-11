/**
 * サイバー風スキャンオーバーレイ。
 *
 * SEED マルチロックオン + 特撮 HUD 演出:
 *   - コーナーブラケットが外→内スライドイン
 *   - ラベルが HEX フリッカーから実テキストへ
 *   - ボックス確定時に LOCK-ON フラッシュ
 *   - 左右データストリーム + 下部進捗バー
 *
 * animated=false のときアニメーションをスキップして最終状態を即表示。
 * ボックス座標は naturalWidth/Height 座標系。letterbox は内部補正。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import "./ScannerOverlay.css";
import type { DetectedRegion, ScanPhase } from "./types.js";

// ---------------------------------------------------------------------------
// HEX フリッカーラベル
// ---------------------------------------------------------------------------

const HEX_CHARS = "0123456789ABCDEF";
function randomHex(len: number) {
  return Array.from({ length: len }, () =>
    HEX_CHARS[Math.floor(Math.random() * HEX_CHARS.length)],
  ).join("");
}

function FlickerLabel({
  text,
  animated,
  delay,
  color,
}: {
  text: string;
  animated: boolean;
  delay: number;
  color: string;
}) {
  const [display, setDisplay] = useState(animated ? randomHex(text.length) : text);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    if (!animated) { setDisplay(text); return; }
    // フリッカー: 40ms × 8 回ランダム → 実テキスト
    let count = 0;
    const total = 8;
    const start = () => {
      tickRef.current = window.setTimeout(() => {
        count++;
        if (count < total) {
          setDisplay(randomHex(text.length));
          start();
        } else {
          setDisplay(text);
        }
      }, 40);
    };
    const t = window.setTimeout(start, delay);
    return () => {
      window.clearTimeout(t);
      if (tickRef.current !== null) window.clearTimeout(tickRef.current);
    };
  }, [text, animated, delay]);

  return (
    <div
      className="sc-label"
      style={{ "--sc-clr": color } as React.CSSProperties}
    >
      {display}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ストリームテキスト生成
// ---------------------------------------------------------------------------
const STREAM_CHARS = "0123456789ABCDEF:./!?@#*";
function makeStream(lines: number): string {
  return Array.from({ length: lines * 2 }, () =>
    Array.from({ length: 3 }, () =>
      STREAM_CHARS[Math.floor(Math.random() * STREAM_CHARS.length)],
    ).join(""),
  ).join("\n");
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

interface Props {
  imageUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  phase: ScanPhase;
  /** detect: main bbox。 analyze/result: フィールド bbox リスト */
  regions: DetectedRegion[];
  animated: boolean;
  onDismiss?: () => void;
}

export function ScannerOverlay({
  imageUrl,
  naturalWidth,
  naturalHeight,
  phase,
  regions,
  animated,
  onDismiss,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgRect, setImgRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);

  // ストリームテキストはマウント時に一度だけ生成
  const streamL = useMemo(() => makeStream(60), []);
  const streamR = useMemo(() => makeStream(60), []);

  // letterbox 矩形を ResizeObserver で追跡
  useEffect(() => {
    const el = containerRef.current;
    if (!el || naturalWidth === 0) return;
    const calc = () => {
      const ew = el.offsetWidth;
      const eh = el.offsetHeight;
      const s  = Math.min(ew / naturalWidth, eh / naturalHeight);
      const iw = naturalWidth  * s;
      const ih = naturalHeight * s;
      setImgRect({ x: (ew - iw) / 2, y: (eh - ih) / 2, w: iw, h: ih });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [naturalWidth, naturalHeight]);

  function toCSS(r: DetectedRegion) {
    if (!imgRect) return null;
    const { x: ox, y: oy, w: iw, h: ih } = imgRect;
    const sx = iw / naturalWidth;
    const sy = ih / naturalHeight;
    return {
      left:   ox + r.x * sx,
      top:    oy + r.y * sy,
      width:  r.width  * sx,
      height: r.height * sy,
    };
  }

  const lockedCount   = regions.filter((r) => r.value !== undefined).length;
  const totalCount    = regions.length;
  const progressPct   = progressFor(phase, lockedCount, totalCount);
  const statusInfo    = statusFor(phase, lockedCount, totalCount);

  const showScan      = animated && phase === "detect";
  const showBoxes     = phase !== "idle" && (phase !== "detect" || !animated);
  const showStreams    = phase === "analyze" || phase === "result";
  const showStamp     = phase === "result";

  return (
    <div className="sc-root" ref={containerRef}>
      <img className="sc-image" src={imageUrl} alt="" draggable={false} />

      {/* スキャンライン */}
      {showScan && <div className="sc-scanline" />}

      {/* データストリーム */}
      {showStreams && (
        <>
          <div className="sc-stream sc-stream--left"  aria-hidden>
            <div className="sc-stream-text">{streamL}</div>
          </div>
          <div className="sc-stream sc-stream--right" aria-hidden>
            <div className="sc-stream-text">{streamR}</div>
          </div>
        </>
      )}

      {/* 検知ボックス群 */}
      {showBoxes && imgRect && regions.map((r, i) => {
        const pos = toCSS(r);
        if (!pos) return null;
        const clr     = r.color ?? "#00ffc8";
        const variant = boxVariant(r);
        const delay   = animated ? (r.delay ?? 0) : 0;
        const barW    = `${Math.round(r.confidence * 100)}%`;
        const barDur  = animated ? `${0.35 + r.confidence * 0.55}s` : "0s";
        const isAn    = phase === "analyze";
        const isRes   = phase === "result";

        return (
          <div
            key={r.id}
            className={`sc-box ${variant}${isAn ? " is-analyze" : ""}`}
            style={{
              left:   pos.left,
              top:    pos.top,
              width:  pos.width,
              height: pos.height,
              animationDelay: `${delay}ms`,
              "--sc-clr": clr,
            } as React.CSSProperties}
          >
            {/* コーナーブラケット */}
            {(["tl","tr","bl","br"] as const).map((c) => (
              <div
                key={c}
                className={`sc-corner sc-corner--${c}`}
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}

            {/* 中央十字線 */}
            {(isAn || isRes) && (
              <div
                className="sc-crosshair"
                style={{
                  "--sc-clr": clr,
                  animationDelay: `${delay + 80}ms`,
                } as React.CSSProperties}
              />
            )}

            {/* TARGET 番号 */}
            <div
              className="sc-target-num"
              style={{
                "--sc-clr": clr,
                background: clr,
                animationDelay: `${delay}ms`,
              } as React.CSSProperties}
            >
              {`TARGET ${String(i + 1).padStart(2, "0")}`}
            </div>

            {/* HEX フリッカーラベル */}
            {(isAn || isRes) && (
              <FlickerLabel
                text={r.label}
                animated={animated}
                delay={delay + 160}
                color={clr}
              />
            )}

            {/* 信頼度バー */}
            {(isAn || isRes) && (
              <div className="sc-bar-wrap">
                <div
                  className="sc-bar"
                  style={{
                    "--sc-bar-w":   barW,
                    "--sc-bar-dur": barDur,
                    animationDelay: `${delay}ms`,
                  } as React.CSSProperties}
                />
              </div>
            )}

            {/* LOCK-ON フラッシュ (analyze 開始時) */}
            {isAn && animated && (
              <LockOnFlash key={`flash-${r.id}-${phase}`} color={clr} delay={delay + 200} />
            )}

            {/* 値テキスト (Phase 3) */}
            {isRes && r.value && (
              <div
                className="sc-value"
                style={{
                  "--sc-clr": clr,
                  animationDelay: `${delay + 180}ms`,
                } as React.CSSProperties}
              >
                {r.value}
              </div>
            )}
          </div>
        );
      })}

      {/* CONFIRMED スタンプ */}
      {showStamp && (
        <div
          className={`sc-stamp${phase === "result" ? "" : " sc-stamp--error"}`}
          style={{ animationDelay: animated ? "700ms" : "0ms" }}
        >
          <div className="sc-stamp-inner">CONFIRMED</div>
        </div>
      )}

      {/* HUD ステータスバー */}
      {phase !== "idle" && (
        <div className={`sc-status sc-status--${statusInfo.mod}`}>
          <div className="sc-status-dot" />
          <span>{statusInfo.text}</span>
          {totalCount > 0 && (
            <span className="sc-lockon-counter">
              {lockedCount}/{totalCount} LOCKED
            </span>
          )}
          {onDismiss && phase === "result" && (
            <button className="sc-close" onClick={onDismiss}>CLOSE</button>
          )}
        </div>
      )}

      {/* 下部進捗バー */}
      {phase !== "idle" && (
        <div className="sc-progress-bar">
          <div
            className="sc-progress-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOCK-ON フラッシュサブコンポーネント
// ---------------------------------------------------------------------------

function LockOnFlash({ color, delay }: { color: string; delay: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(t);
  }, [delay]);
  if (!visible) return null;
  return (
    <div
      className="sc-lockon-flash"
      style={{ "--sc-clr": color } as React.CSSProperties}
    />
  );
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function boxVariant(r: DetectedRegion): string {
  if (r.id === "receipt" || r.id === "main") return "sc-box--main";
  if (r.id === "total")                      return "sc-box--total";
  if (r.color === "#fb923c")                 return "sc-box--food";
  return "sc-box--field";
}

function statusFor(
  phase: ScanPhase,
  locked: number,
  total: number,
): { text: string; mod: string } {
  switch (phase) {
    case "detect":
      return { text: "INITIALIZING SCAN SYSTEM...", mod: "detect" };
    case "analyze":
      return {
        text: locked < total
          ? `ACQUIRING TARGET ${String(locked + 1).padStart(2,"0")}...`
          : "LOCK-ON COMPLETE — EXTRACTING...",
        mod: "analyze",
      };
    case "result":
      return { text: "ALL TARGETS CONFIRMED", mod: "result" };
    default:
      return { text: "", mod: "" };
  }
}

function progressFor(phase: ScanPhase, locked: number, total: number): number {
  switch (phase) {
    case "detect":  return 15;
    case "analyze": return total > 0 ? 15 + 70 * (locked / total) : 20;
    case "result":  return 100;
    default:        return 0;
  }
}
