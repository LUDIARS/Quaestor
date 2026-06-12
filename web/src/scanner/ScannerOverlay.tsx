/**
 * サイバー風スキャンオーバーレイ。
 *
 * SEED マルチロックオン + 特撮 HUD 演出:
 *   - コーナーブラケットが外→内スライドイン
 *   - ラベルが HEX フリッカーから実テキストへ
 *   - ボックス確定時に LOCK-ON フラッシュ
 *   - 左右データストリーム + 下部進捗バー
 *   - locate フェーズ: 再スキャンライン (紫)
 *   - confirm フェーズ: フィールドごとに CONFIRMED バッジを順次表示
 *
 * animated=false のときアニメーションをスキップして最終状態を即表示。
 * ボックス座標は naturalWidth/Height 座標系。letterbox は内部補正。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import "./ScannerOverlay.css";
import type { DetectedRegion, ScanPhase } from "./types.js";
import {
  DETECT_DURATION_MS,
  RESCAN_PERIOD_MS,
  RESCAN_SWEEP_MS,
  CONFIRM_SCAN_DURATION_MS,
} from "./use-scan-pipeline.js";
import { synthesizeProbes } from "./probe-regions.js";
import { layoutCallouts, type LayoutInput } from "./callout-layout.js";
import { ScannerCallouts, type CalloutItem } from "./ScannerCallouts.js";
import { ScannerSummary } from "./ScannerSummary.js";
import { useScannerAudio } from "./use-scanner-audio.js";

/** exit 演出 (上からスキャンラインで戻る) の所要時間。CSS の sc-exitline と合わせる */
const EXIT_DURATION_MS = 900;

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
// ロックオン収縮アニメ (confirm フェーズ、フィールドごと)
// ---------------------------------------------------------------------------

function LockonShrink({
  color,
  delay,
}: {
  color: string;
  delay: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(t);
  }, [delay]);
  if (!visible) return null;
  return (
    <div
      className="sc-lockon-shrink"
      style={{ "--sc-clr": color } as React.CSSProperties}
    />
  );
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
  /** exit 演出開始時 (タップ)。呼び出し側がカメラを裏で復帰させるのに使う */
  onExitStart?: () => void;
  /** OCR-GA 評価の進捗 (analyze 中の待機を埋める busy 演出)。null で非表示 */
  evolution?: { generation: number; attempt: number; total: number } | null;
  /**
   * 本物 OCR の中間マーカー (最新 attempt の検出位置 + 認識テキスト)。
   * 届いていれば再スキャンの probe をこれに昇格する。null/空なら合成 probe を使う
   * — 再スキャン演出自体はエンジンの生死に関係なく回る。
   */
  liveProbes?: DetectedRegion[] | null;
}

export function ScannerOverlay({
  imageUrl,
  naturalWidth,
  naturalHeight,
  phase,
  regions,
  animated,
  onDismiss,
  onExitStart,
  evolution,
  liveProbes,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgRect, setImgRect] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

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
      setContainerSize({ width: ew, height: eh });
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

  // noise 以外でロック済み (値あり) の数をカウント
  const lockedCount = regions.filter((r) => r.kind !== "noise" && r.value !== undefined).length;
  const totalCount  = regions.filter((r) => r.kind !== "noise").length;
  const progressPct = progressFor(phase, lockedCount, totalCount);
  const statusInfo  = statusFor(phase, lockedCount, totalCount);

  const showScan    = animated && phase === "detect";
  const showRescan  = animated && phase === "locate";
  // detect フェーズでも箱を描画 (y-based delay で scan line と同期して表示される)
  const showBoxes   = phase !== "idle" && phase !== "locate";
  const showStreams  = phase === "analyze" || phase === "result" || phase === "locate" || phase === "confirm";
  const showStamp   = phase === "result" || phase === "confirm";

  // ---- 精度替え再スキャン (analyze 中、自走ループ) ----
  // RESCAN_PERIOD_MS ごとに pass を進め、スキャンライン + probe マーカーを置き直す。
  // 外部エンジンの進捗には依存しない (届いた本物 lines は liveProbes で昇格するだけ)。
  const [rescanPass, setRescanPass] = useState(0);
  useEffect(() => {
    if (!(animated && phase === "analyze")) { setRescanPass(0); return; }
    setRescanPass(1);
    const id = window.setInterval(
      () => setRescanPass((p) => p + 1),
      RESCAN_PERIOD_MS,
    );
    return () => window.clearInterval(id);
  }, [animated, phase]);

  const probeRegions = useMemo(() => {
    if (rescanPass === 0) return [];
    if (liveProbes && liveProbes.length > 0) return liveProbes;
    return synthesizeProbes(rescanPass, naturalWidth, naturalHeight, RESCAN_SWEEP_MS);
  }, [rescanPass, liveProbes, naturalWidth, naturalHeight]);

  const showProbeScan = rescanPass > 0 && phase === "analyze";
  // probe 表示中は偽 YOLO ノイズ箱を引っ込めて混雑を抑える
  const showNoise   = phase === "analyze" && !showProbeScan;
  // 「精度を変えて」を伝える演出値 (pass ごとに決定論的に変化)
  const precisionLabel = (0.3 + ((rescanPass * 17) % 55) / 100).toFixed(2);

  // confirm フェーズ: 余韻スロースキャン (5 秒) が完走したらスタンプ表示
  const stampDelay = (phase === "confirm" && animated) ? CONFIRM_SCAN_DURATION_MS : 700;

  // ---- 本物 BB (source=real) のコールアウトを BB から離して配置 ----
  // confirm フェーズのみ。BB 枠は画像上の文字位置にタイトに残し、ラベル/値は端へ逃がす。
  const calloutItems: CalloutItem[] = useMemo(() => {
    if (phase !== "confirm" || !imgRect || containerSize.width === 0) return [];
    const reals = regions.filter((r) => r.source === "real" && r.kind !== "noise");
    if (reals.length === 0) return [];
    const inputs: LayoutInput[] = [];
    for (const r of reals) {
      const pos = toCSS(r);
      if (!pos) continue;
      inputs.push({ id: r.id, rect: pos });
    }
    const placements = layoutCallouts(inputs, containerSize);
    const byId = new Map(placements.map((p) => [p.id, p]));
    return reals.flatMap((r) => {
      const placement = byId.get(r.id);
      if (!placement) return [];
      return [{ region: r, placement, delay: animated ? (r.delay ?? 0) + 150 : 0 }];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, regions, imgRect, containerSize, animated]);

  // confirm 演出 = 余韻スロースキャン (5 秒、1 枠 1 秒の reveal)。
  // 完走したら「全項目表示のまま待機」しタップで exit。
  const [confirmDone, setConfirmDone] = useState(false);
  useEffect(() => {
    if (phase !== "confirm") { setConfirmDone(false); return; }
    const wait = animated ? CONFIRM_SCAN_DURATION_MS + 200 : 300;
    const t = window.setTimeout(() => setConfirmDone(true), wait);
    return () => window.clearTimeout(t);
  }, [phase, animated]);

  // 効果音
  useScannerAudio({ phase, animated, rescanPass, confirmDone, regions });

  // exit: 画面タップで上からスキャンラインを流して scanner (カメラ) に戻す。
  // タップで進めるのは「最後の confirm が出揃ったとき (ready)」だけ。
  const [exiting, setExiting] = useState(false);
  // サマリーは値を持つ領域すべて (heuristic 経路でも欠けない)。学習保存は real のみ (消費側)。
  const summaryRegions = regions.filter((r) => r.kind !== "noise");
  const ready = phase === "confirm" && confirmDone;
  const canExit = ready && !exiting;
  function beginExit() {
    if (exiting || !ready || !onDismiss) return;
    onExitStart?.();        // カメラを裏で復帰
    setExiting(true);
    window.setTimeout(onDismiss, EXIT_DURATION_MS);
  }

  return (
    <div
      className={`sc-root${exiting ? " is-exiting" : ""}${canExit ? " is-waiting" : ""}`}
      ref={containerRef}
      onClick={canExit ? beginExit : undefined}
    >
      <img className="sc-image" src={imageUrl} alt="" draggable={false} />

      {/* CRT ノイズオーバーレイ (detect フェーズ) */}
      {phase === "detect" && <div className="sc-crt-noise" aria-hidden />}

      {/* detect スキャンライン — JS タイマーと同じ時間で sweep */}
      {showScan && (
        <div
          className="sc-scanline"
          style={{ "--sc-dur": `${DETECT_DURATION_MS}ms` } as React.CSSProperties}
        />
      )}

      {/* locate 再スキャンライン (紫) */}
      {showRescan && <div className="sc-rescanline" />}

      {/* 精度替え再スキャン (analyze 中、pass ごとにライン+マーカーを置き直す) */}
      {showProbeScan && (
        <div
          key={`evolve-${rescanPass}`}
          className="sc-evolveline"
          style={{ "--sc-dur": `${RESCAN_SWEEP_MS}ms` } as React.CSSProperties}
        />
      )}
      {showProbeScan && imgRect && (
        <div key={`probes-${rescanPass}`} className="sc-probes" aria-hidden>
          {probeRegions.map((r) => {
            const pos = toCSS(r);
            if (!pos) return null;
            return (
              <div
                key={r.id}
                className="sc-probe"
                style={{
                  left:   pos.left,
                  top:    pos.top,
                  width:  pos.width,
                  height: pos.height,
                  animationDelay: `${r.delay ?? 0}ms`,
                } as React.CSSProperties}
              >
                {/* 中間 OCR の認識テキスト (本物の検出行があるときだけ) */}
                {r.recognizedText && (
                  <span className="sc-probe-text">
                    {r.recognizedText.length > 14
                      ? `${r.recognizedText.slice(0, 14)}…`
                      : r.recognizedText}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* confirm 余韻スロースキャンライン (5 秒かけて全体を流し、枠を順に出す) */}
      {animated && phase === "confirm" && !confirmDone && !exiting && (
        <div
          className="sc-finalline"
          style={{ "--sc-dur": `${CONFIRM_SCAN_DURATION_MS}ms` } as React.CSSProperties}
        />
      )}

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
        // ノイズボックスは analyze フェーズのみ表示
        if (r.kind === "noise" && !showNoise) return null;

        const pos = toCSS(r);
        if (!pos) return null;
        const clr      = r.color ?? "#00ffc8";
        const variant  = boxVariant(r);
        const delay    = animated ? (r.delay ?? 0) : 0;
        const barW     = `${Math.round(r.confidence * 100)}%`;
        const barDur   = animated ? `${0.35 + r.confidence * 0.55}s` : "0s";
        const isDet    = phase === "detect";
        const isAn     = phase === "analyze";
        const isRes    = phase === "result";
        const isCo     = phase === "confirm";
        const isNoise  = r.kind === "noise";
        // 本物 BB はタイト枠のみ。ラベル/値/バーは離れた callout 側で描く。
        const isReal   = r.source === "real";

        return (
          <div
            key={r.id}
            className={[
              "sc-box",
              variant,
              isDet   ? "is-detect"  : "",
              isAn    ? "is-analyze" : "",
              isCo    ? "is-confirm" : "",
              isNoise ? "is-noise"   : "",
              isReal  ? "is-real"    : "",
            ].filter(Boolean).join(" ")}
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

            {/* 中央十字線 — detect / noise は非表示 */}
            {(isAn || isRes || isCo) && !isNoise && (
              <div
                className="sc-crosshair"
                style={{
                  "--sc-clr": clr,
                  animationDelay: `${delay + 80}ms`,
                } as React.CSSProperties}
              />
            )}

            {/* TARGET 番号 (ノイズは OBJ_ ラベルのみ表示。本物 BB は callout 側に逃がすので非表示) */}
            {!isReal && (
              <div
                className="sc-target-num"
                style={{
                  "--sc-clr": clr,
                  background: clr,
                  animationDelay: `${delay}ms`,
                } as React.CSSProperties}
              >
                {isNoise ? r.label : `TARGET ${String(i + 1).padStart(2, "0")}`}
              </div>
            )}

            {/* HEX フリッカーラベル (本物 BB は callout 側) */}
            {(isAn || isRes || isCo) && !isNoise && !isReal && (
              <FlickerLabel
                text={r.label}
                animated={animated}
                delay={delay + 160}
                color={clr}
              />
            )}

            {/* 信頼度バー (本物 BB は callout 側) */}
            {(isAn || isRes || isCo) && !isReal && (
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

            {/* 値テキスト (result / confirm。本物 BB は callout 側) */}
            {(isRes || isCo) && r.value && !isNoise && !isReal && (
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

            {/* ロックオン収縮アニメ (confirm フェーズ) — per-item CONFIRMED バッジの代わり */}
            {isCo && !isNoise && (
              <LockonShrink color={clr} delay={animated ? delay + 150 : 0} />
            )}
          </div>
        );
      })}

      {/* 再スキャンのメタ表示: PASS / 精度 (演出値) / GA 実進捗 (届いていれば) */}
      {showProbeScan && (
        <div className="sc-evolve">
          <span className="sc-evolve-tag">RE-SCAN</span>
          <span className="sc-evolve-gen">PASS {String(rescanPass).padStart(2, "0")}</span>
          <span className="sc-evolve-prog">PRECISION {precisionLabel}</span>
          {evolution && evolution.total > 0 && (
            <span className="sc-evolve-gen">
              GEN {evolution.generation} · {evolution.attempt}/{evolution.total}
            </span>
          )}
        </div>
      )}

      {/* 本物 BB の演出コールアウト (BB から離して描画 + リーダー線) */}
      {calloutItems.length > 0 && (
        <ScannerCallouts container={containerSize} items={calloutItems} />
      )}

      {/* CONFIRMED スタンプ */}
      {showStamp && (
        <div
          className="sc-stamp"
          style={{ animationDelay: animated ? `${stampDelay}ms` : "0ms" }}
        >
          <div className="sc-stamp-inner">CONFIRMED</div>
        </div>
      )}

      {/* 全項目リスト + 余韻 (confirm 演出完了後に待機) */}
      {phase === "confirm" && confirmDone && (
        <ScannerSummary regions={summaryRegions} exiting={exiting} />
      )}

      {/* exit スキャンライン: タップで上から下へ流して scanner に戻す */}
      {exiting && (
        <div
          className="sc-exitline"
          style={{ "--sc-dur": `${EXIT_DURATION_MS}ms` } as React.CSSProperties}
        />
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
          {onDismiss && (phase === "result" || ready) && (
            <button
              className="sc-close"
              onClick={(e) => { e.stopPropagation(); if (ready) beginExit(); else onDismiss(); }}
            >CLOSE</button>
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
    case "locate":
      return { text: "RE-SCANNING TARGET COORDINATES...", mod: "locate" };
    case "confirm":
      return { text: "CONFIRMING FIELD POSITIONS...", mod: "confirm" };
    default:
      return { text: "", mod: "" };
  }
}

function progressFor(phase: ScanPhase, locked: number, total: number): number {
  switch (phase) {
    case "detect":  return 15;
    case "analyze": return total > 0 ? 15 + 70 * (locked / total) : 20;
    case "result":  return 100;
    case "locate":  return 100;
    case "confirm": return 100;
    default:        return 0;
  }
}
