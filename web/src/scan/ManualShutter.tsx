import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./ManualShutter.css";
import { useCamera } from "./useCamera.js";
import { ScanGuide } from "./ScanGuide.js";
import {
  captureFrame,
  uploadReceipt,
  kickOcr,
  kickDetect,
  commitReceipt,
  tryGetGeo,
  saveRegions,
} from "./captureUpload.js";
import { ReceiptEditor, type EditableReceipt } from "../components/ReceiptEditor.js";
import { DocKindLabels } from "./DocKindLabels.js";
import { withDefaultLabels, type LabeledReceipt } from "./receiptLabelsApi.js";
import { scanBadgesFor } from "./scan-badges.js";
import { DOC_KIND_INFO } from "../../../src/shared/document-kinds.js";
import { ScannerOverlay } from "../scanner/ScannerOverlay.js";
import { useScanPipeline } from "../scanner/use-scan-pipeline.js";
import { ChainedFieldLocator, FallbackFieldLocator, TesseractFieldLocator } from "../scanner/field-locator.js";
import { BackendDetectFieldLocator } from "../scanner/backend-detect-locator.js";
import type { FieldLocatorEngine, ScanBadge } from "../scanner/types.js";

const ANIM_KEY = "quaestor.scan.animated";
function loadAnimated(): boolean {
  try { return localStorage.getItem(ANIM_KEY) !== "0"; } catch { return true; }
}
function saveAnimated(v: boolean) {
  try { localStorage.setItem(ANIM_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

/** 撮影 1 枚。 種別・サンプルラベル列 (LabeledReceipt) は poll で追随し、 上書き UI で更新する。 */
interface Shot extends LabeledReceipt {
  capturedAt: number;
  imageUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
  committed: boolean;
  note?: string;
}

/** GET /v1/receipts/:id が返す列のうち Shot が追随するもの */
type PolledReceipt = Partial<LabeledReceipt> & {
  ocr_status: string;
  date: string | null; payee: string | null;
  total: number | null; items: string | null;
  committed_at: number | null;
};

function isComplete(s: Shot): boolean {
  return !!s.date && !!s.payee && s.payee.trim() !== "" && s.total != null;
}

/**
 * ブラウザ内の段階フォールバック locator (シングルトン、ステートレス):
 *   Tesseract (ブラウザ word BB) → Fallback (比率推定)
 * 本命の PaddleOCR は backend の `POST /v1/receipts/:id/detect` 経由で、
 * receipt ごとに ScanAnimation が先頭へ挿す (BackendDetectFieldLocator)。
 */
const defaultFieldLocator: FieldLocatorEngine = new ChainedFieldLocator([
  new TesseractFieldLocator("jpn+eng"),
  new FallbackFieldLocator(),
]);

/**
 * 手動シャッター撮影画面 (表示見出し無し、 カメラがファーストビュー)。
 *
 * フロー: 撮影 → スキャンアニメ (DETECT→ANALYZE→RESULT→LOCATE→CONFIRM) → 投入。
 * カメラは常時 9:16 ポートレート + ループスキャンライン。
 * アニメーションはカメラ下のトグルでオフ可能。
 */
export function ManualShutter() {
  const { videoRef, running, error } = useCamera();
  const [shots, setShots] = useState<Shot[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  // exit 演出中はカメラ映像を裏で復帰させ、スキャンライン通過でカメラへ戻す
  const [exitingScan, setExitingScan] = useState(false);
  const [animated, setAnimated] = useState(loadAnimated);
  const [flashKey, setFlashKey] = useState(0);
  const captureLockRef = useRef(false);

  const activeShot = shots.find((s) => s.id === activeScanId) ?? null;

  const shoot = useCallback(async () => {
    if (captureLockRef.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    captureLockRef.current = true;
    setFlashKey((k) => k + 1); // シャッターフラッシュ
    setCapturing(true);
    try {
      const frame = await captureFrame(video, { maxDim: 1080, quality: 0.9 });
      const geo   = await tryGetGeo();
      const up    = await uploadReceipt({
        b64: frame.b64,
        geo,
        metadata: { source: "manual-shutter", kind: "manual", w: frame.w, h: frame.h },
      });
      const r = up.receipt;
      setShots((prev) => {
        if (prev.some((s) => s.id === r.id)) return prev;
        return [
          {
            // 撮影直後は未分類 (doc_kind='receipt' 既定、 sample は NULL)。 OCR 完了で poll が埋める
            ...withDefaultLabels({ id: r.id }),
            capturedAt: Math.floor(Date.now() / 1000),
            imageUrl: `/v1/receipts/${r.id}/image`,
            naturalWidth:  frame.w,
            naturalHeight: frame.h,
            ocr_status: r.ocr_status,
            date: r.date, payee: r.payee, total: r.total, items: null,
            committed: r.committed_at != null,
          },
          ...prev,
        ];
      });
      // アニメ ON: スキャン演出を表示 (タップで戻るまで占有)。
      // アニメ OFF: 演出を出さず、従来どおり連続撮影 → キューイングを許す。
      setExitingScan(false);
      if (animated) setActiveScanId(r.id);
      if (!up.deduped) void kickOcr(r.id).catch(() => { /* poll が拾う */ });
    } catch {
      /* 1 枚失敗してもスルー */
    } finally {
      captureLockRef.current = false;
      setCapturing(false);
    }
  }, [videoRef, animated]);

  /**
   * OCR 真値が揃った撮影に 1 回だけ detect をキックする ref。
   * 演出 (スキャンアニメ) を出さない設定でも運用評価レコードが発行されるよう、
   * 演出ではなく poll 側から呼ぶ。backend が 1 receipt = 1 本に畳む。
   */
  const detectKickedRef = useRef(new Set<string>());

  // OCR 結果を 3 秒毎に poll
  useEffect(() => {
    const pending = shots.some((s) => !s.committed);
    if (!pending) return;
    const id = window.setInterval(async () => {
      const targets = shots.filter((s) => !s.committed && s.id !== editingId);
      if (targets.length === 0) return;
      const updates = await Promise.all(
        targets.map(async (s) => {
          try {
            const j = (await (await fetch(`/v1/receipts/${s.id}`)).json()) as { receipt?: PolledReceipt };
            return j.receipt ? { id: s.id, r: j.receipt } : null;
          } catch { return null; }
        }),
      );
      for (const u of updates) {
        if (!u) continue;
        const ready = u.r.ocr_status === "done" || u.r.ocr_status === "manual";
        if (ready && !detectKickedRef.current.has(u.id)) {
          detectKickedRef.current.add(u.id);
          kickDetect(u.id);
        }
      }
      setShots((prev) =>
        prev.map((s) => {
          const u = updates.find((x) => x?.id === s.id);
          if (!u) return s;
          const labels = withDefaultLabels({ id: s.id, ...u.r });
          return {
            ...s,
            ocr_status: u.r.ocr_status,
            date: u.r.date, payee: u.r.payee,
            total: u.r.total, items: u.r.items,
            committed: u.r.committed_at != null,
            doc_kind: labels.doc_kind,
            sample_role: labels.sample_role,
            sample_tags: labels.sample_tags,
            sample_reason: labels.sample_reason,
            sample_source: labels.sample_source,
            content_tags: labels.content_tags,
          };
        }),
      );
    }, 3000);
    return () => window.clearInterval(id);
  }, [shots, editingId]);

  async function commit(s: Shot) {
    const res = await commitReceipt(s.id);
    setShots((prev) =>
      prev.map((x) => {
        if (x.id !== s.id) return x;
        return res.ok
          ? { ...x, committed: true, note: undefined }
          : { ...x, note: res.message ?? res.error };
      }),
    );
  }

  const committedCount = shots.filter((s) => s.committed).length;

  /** 種別・サンプルラベルの上書き (PATCH /labels) を一覧へ反映する。 */
  function onLabelsChanged(u: LabeledReceipt) {
    setShots((prev) => prev.map((s) => (s.id === u.id ? { ...s, ...u } : s)));
  }

  return (
    <div>
      {/* 視覚的な見出しは置かず、 カメラをそのままファーストビューにする */}
      {/* カメラ + スキャンアニメーション — 常時 9:16 ポートレート */}
      <div
        className="scan-stage"
        style={{
          position: "relative",
          maxWidth: 360,
          aspectRatio: "9/16",
        }}
      >
        {/* カメラ映像 (アニメ表示中は後ろに隠れる) */}
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 8,
            background: "#000",
            objectFit: "cover",
            position: activeShot ? "absolute" : "relative",
            // exit 中はカメラを表に出す (オーバーレイがフェードして奥のカメラが現れる)
            opacity: activeShot && !exitingScan ? 0 : 1,
            transition: "opacity 0.5s ease-out",
          }}
        />

        {/* 右上: 撮影対象と自動仕訳の説明 (カメラに乗せる) */}
        <ScanGuide />

        {/* シャッターフラッシュ (key で毎回アニメ再生) */}
        {flashKey > 0 && (
          <div
            key={flashKey}
            className="shutter-flash"
            onAnimationEnd={() => setFlashKey(0)}
          />
        )}

        {/* カメラ常時スキャンライン (撮影待機中) */}
        {!activeShot && running && (
          <div className="camera-scanline" />
        )}

        {/* スキャンアニメーション */}
        {activeShot && (
          <ScanAnimation
            shot={activeShot}
            animated={animated}
            fieldLocator={defaultFieldLocator}
            badges={scanBadgesFor(activeShot)}
            onExitStart={() => setExitingScan(true)}
            onDismiss={() => { setActiveScanId(null); setExitingScan(false); }}
          />
        )}

        {/* シャッターボタン */}
        <button
          onClick={() => void shoot()}
          disabled={!running || capturing || !!activeShot}
          aria-label="シャッター"
          style={{
            position: "absolute",
            bottom: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            width: 68, height: 68,
            borderRadius: "50%",
            border: "4px solid rgba(255,255,255,0.9)",
            background: capturing ? "var(--c-accent)" : "rgba(255,255,255,0.35)",
            cursor: (running && !activeShot) ? "pointer" : "not-allowed",
            boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
            transition: "background 120ms, opacity 300ms",
            zIndex: 20,
            // スキャン演出中は disabled ボタンがタップを飲み込み、 下の
            // オーバーレイ (タップで exit) に届かなくなる → 素通しにする
            pointerEvents: activeShot ? "none" : "auto",
            opacity: activeShot ? 0 : 1,
          }}
        />
      </div>

      <div className="scan-meta" style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.75rem", maxWidth: 360 }}>
        {error
          ? <span className="error">{error}</span>
          : <span>camera: {running ? "ready" : "starting…"} ｜ 撮影 {shots.length} 枚 ｜ 投入済 {committedCount}</span>
        }
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.75rem", color: "var(--c-subtle)", cursor: "pointer", marginLeft: "auto", whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={animated}
            onChange={(e) => { setAnimated(e.target.checked); saveAnimated(e.target.checked); }}
            style={{ margin: 0 }}
          />
          スキャンアニメ
        </label>
      </div>

      {/* 使い方はカメラの下 (カメラをファーストビューに置く) */}
      <p style={{ color: "var(--c-subtle)", fontSize: "0.85rem", marginTop: "0.5rem", maxWidth: 360 }}>
        レシートを画面に収めて <strong>シャッター</strong> を押すだけ。
        撮影 → OCR → <strong>日付・場所・金額</strong> が揃えば自動で投入。 揃わない / 重複したものだけ手で直す。
      </p>

      {shots.length > 0 && (
        <section style={{ marginTop: "1rem" }}>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>📸 このセッションの撮影</h3>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {shots.map((s) => (
              <ShotCard
                key={s.id}
                shot={s}
                editing={editingId === s.id}
                onToggleEdit={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                onCommit={() => void commit(s)}
                onSaved={() => setEditingId(null)}
                onReplay={() => { setExitingScan(false); setActiveScanId(s.id); }}
                onLabelsChanged={onLabelsChanged}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// スキャンアニメーション領域
// ---------------------------------------------------------------------------

function ScanAnimation({
  shot,
  animated,
  fieldLocator,
  badges,
  onDismiss,
  onExitStart,
}: {
  shot: Shot;
  animated: boolean;
  fieldLocator?: FieldLocatorEngine;
  /** CONFIRMED / サマリーに添える種別・サンプル区分バッジ */
  badges?: ScanBadge[];
  onDismiss: () => void;
  onExitStart?: () => void;
}) {
  // confirm の検出は backend detect (勝ち遺伝子で 1 回) を先頭に置き、
  // 間に合わなければブラウザ側の fallback (Tesseract → 比率推定) に落ちる。
  const liveLocator = useMemo(
    () => (fieldLocator
      ? new ChainedFieldLocator([new BackendDetectFieldLocator(shot.id), fieldLocator])
      : undefined),
    [fieldLocator, shot.id],
  );

  const { phase, regions } = useScanPipeline({
    imageUrl: shot.imageUrl,
    naturalWidth:  shot.naturalWidth,
    naturalHeight: shot.naturalHeight,
    ocrStatus: shot.ocr_status,
    ocrFields: {
      date: shot.date, payee: shot.payee,
      total: shot.total, items: shot.items,
    },
    animated,
    fieldLocator: liveLocator,
    mode: "receipt",
  });

  // fieldLocator あり (confirm) は全項目表示のまま待機し、画面タップで戻る
  // (ScannerOverlay 内の exit 演出 → onDismiss)。なし (result) は従来どおり自動 dismiss。
  const dismissPhase = fieldLocator ? "confirm" : "result";

  useEffect(() => {
    if (dismissPhase === "confirm") return; // タップ待ち (自動で閉じない)
    if (phase !== dismissPhase) return;
    const t = window.setTimeout(onDismiss, 3500);
    return () => window.clearTimeout(t);
  }, [phase, onDismiss, dismissPhase]);

  // confirm フェーズ到達時、本物 BB (source=real) を学習データへ永続化 (1 回だけ)。
  const savedRef = useRef(false);
  useEffect(() => {
    if (phase !== "confirm" || savedRef.current) return;
    // backend detect 由来 (persisted) は backend が保存済なので送り返さない (二重記録を作らない)
    const reals = regions.filter((r) => r.source === "real" && !r.persisted);
    if (reals.length === 0) return;
    savedRef.current = true;
    const engine = reals.some((r) => r.polygon) ? "paddle" : "tesseract";
    void saveRegions(shot.id, {
      engine,
      naturalWidth: shot.naturalWidth,
      naturalHeight: shot.naturalHeight,
      regions: reals.map((r) => ({
        label: r.id,
        x: r.x, y: r.y, width: r.width, height: r.height,
        recognizedText: r.recognizedText,
        polygon: r.polygon,
        confidence: r.confidence,
        source: r.source,
      })),
    });
  }, [phase, regions, shot.id, shot.naturalWidth, shot.naturalHeight]);

  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: 8, overflow: "hidden" }}>
      <ScannerOverlay
        imageUrl={shot.imageUrl}
        naturalWidth={shot.naturalWidth}
        naturalHeight={shot.naturalHeight}
        phase={phase}
        regions={regions}
        animated={animated}
        onDismiss={onDismiss}
        onExitStart={onExitStart}
        expectConfirm={!!fieldLocator}
        badges={badges}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ショットカード
// ---------------------------------------------------------------------------

function ShotCard({
  shot,
  editing,
  onToggleEdit,
  onCommit,
  onSaved,
  onReplay,
  onLabelsChanged,
}: {
  shot: Shot;
  editing: boolean;
  onToggleEdit: () => void;
  onCommit: () => void;
  onSaved: () => void;
  onReplay: () => void;
  onLabelsChanged: (r: LabeledReceipt) => void;
}) {
  const complete    = isComplete(shot);
  // 投入先が未配線の種別 (請求書 / 検針票 / 明細 / その他) は投入ボタンを出さない (種別を直してから)
  const kindInfo    = DOC_KIND_INFO[shot.doc_kind];
  const kindAllows  = kindInfo.commitPolicy !== "not_wired";
  const canCommit   = complete && kindAllows;
  const commitTitle = !kindAllows
    ? `${kindInfo.label} は ${kindInfo.destination}`
    : complete ? "投入" : "日付・場所・金額が揃うと投入できます";
  const borderColor = shot.committed ? "var(--c-ok)" : canCommit ? "var(--c-accent)" : "var(--c-border)";

  return (
    <div
      style={{
        display: "flex", gap: "0.75rem", alignItems: "flex-start",
        background: "var(--c-muted)",
        border: `1px solid ${borderColor}`,
        borderRadius: 6, padding: "0.5rem",
      }}
    >
      {/* サムネイル (クリックでリプレイ) */}
      <button
        onClick={onReplay}
        style={{
          padding: 0, border: "none", background: "none",
          cursor: "pointer", flex: "0 0 64px",
        }}
        title="スキャンアニメをリプレイ"
      >
        <img
          src={shot.imageUrl}
          alt=""
          style={{
            width: 64, height: 85, objectFit: "cover",
            borderRadius: 4, background: "var(--c-bg)",
            display: "block",
          }}
        />
      </button>

      <div style={{ flex: 1, minWidth: 0, fontSize: "0.8rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: shot.committed ? "var(--c-ok)" : "var(--c-subtle)" }}>
            {shot.committed ? "✅ 投入済" : statusLabel(shot.ocr_status)}
          </span>
          <span style={{ color: "var(--c-subtle)" }}>
            {new Date(shot.capturedAt * 1000).toLocaleTimeString()}
          </span>
        </div>
        <div style={{ marginTop: 2 }}>
          <Field label="日付" value={shot.date} />
          {" ｜ "}
          <Field label="場所" value={shot.payee} />
          {" ｜ "}
          <Field label="金額" value={shot.total != null ? `¥${shot.total.toLocaleString()}` : null} />
        </div>
        {/* 種別 / サンプルラベル / タグ — バッジをタップして 1 タップで直す */}
        <DocKindLabels receipt={shot} onChanged={onLabelsChanged} />
        {shot.note && (
          <div className="error" style={{ marginTop: 2, fontSize: "0.75rem" }}>{shot.note}</div>
        )}
        {!shot.committed && (
          <div style={{ marginTop: 4, display: "flex", gap: "0.4rem" }}>
            <button
              className="fd-btn-ghost"
              style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
              onClick={onToggleEdit}
            >
              {editing ? "閉じる" : "確認・編集"}
            </button>
            <button
              className="fd-btn"
              style={{ padding: "0.15rem 0.6rem", fontSize: "0.75rem" }}
              onClick={onCommit}
              disabled={!canCommit}
              title={commitTitle}
            >
              投入
            </button>
          </div>
        )}
        {editing && (
          <ReceiptEditor
            receipt={shot as EditableReceipt}
            onSaved={onSaved}
            onClose={onSaved}
          />
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <span>
      <span style={{ color: "var(--c-subtle)" }}>{label}:</span>{" "}
      {value
        ? <strong>{value}</strong>
        : <span style={{ color: "var(--c-danger)" }}>—</span>
      }
    </span>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":    return "⏳ OCR待ち";
    case "processing": return "🔄 OCR中";
    case "done":       return "📝 OCR完了";
    case "failed":     return "⚠️ OCR失敗";
    case "manual":     return "✍️ 手入力";
    default:           return status;
  }
}
