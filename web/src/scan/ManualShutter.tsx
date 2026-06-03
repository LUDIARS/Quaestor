import { useCallback, useEffect, useRef, useState } from "react";
import { useCamera } from "./useCamera.js";
import {
  captureFrame,
  uploadReceipt,
  kickOcr,
  commitReceipt,
  tryGetGeo,
} from "./captureUpload.js";
import { ReceiptEditor, type EditableReceipt } from "../components/ReceiptEditor.js";

/** このセッションで撮影した 1 枚の状態 (画面ローカル)。 */
interface Shot {
  id: string;
  capturedAt: number;
  ocr_status: string;
  date: string | null;
  payee: string | null;
  total: number | null;
  items: string | null;
  committed: boolean;
  /** 投入を弾かれた時のメッセージ (重複 / 不備) */
  note?: string;
}

function isComplete(s: Shot): boolean {
  return !!s.date && !!s.payee && s.payee.trim() !== "" && s.total != null;
}

/**
 * 手動シャッター方式の撮影画面。
 *
 * フロー: パシャっと撮る → OCR (自動キック) → 日付・場所・金額が揃ったら投入。
 * 投入時に (日付-場所-金額) で重複判定 (server: POST /v1/receipts/:id/commit)。
 * 端で自動検出はしない (= AR モードと対照)。
 */
export function ManualShutter() {
  const { videoRef, running, error } = useCamera();
  const [shots, setShots] = useState<Shot[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const captureLockRef = useRef(false);

  // 撮影: 二度押し対策に短い lock。 連打 (パシャパシャ) は lock 解放後に次が通る。
  const shoot = useCallback(async () => {
    if (captureLockRef.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    captureLockRef.current = true;
    setCapturing(true);
    try {
      const frame = await captureFrame(video, { maxDim: 1080, quality: 0.9 });
      const geo = await tryGetGeo();
      const up = await uploadReceipt({
        b64: frame.b64,
        geo,
        metadata: { source: "manual-shutter", kind: "manual", w: frame.w, h: frame.h },
      });
      const r = up.receipt;
      // server-side image-hash dedup で既存が返ったら list に重複追加しない
      setShots((prev) => {
        if (prev.some((s) => s.id === r.id)) return prev;
        return [
          {
            id: r.id,
            capturedAt: Math.floor(Date.now() / 1000),
            ocr_status: r.ocr_status,
            date: r.date,
            payee: r.payee,
            total: r.total,
            items: null,
            committed: r.committed_at != null,
          },
          ...prev,
        ];
      });
      // OCR をキック (自動)。 完了は poll で拾う。
      if (!up.deduped) void kickOcr(r.id).catch(() => { /* poll が拾う */ });
    } catch {
      /* 1 枚失敗してもスルー (連写を止めない) */
    } finally {
      captureLockRef.current = false;
      setCapturing(false);
    }
  }, [videoRef]);

  // 未投入かつ未編集中の shot を 3 秒毎に poll して OCR 結果を反映。
  useEffect(() => {
    const pending = shots.some((s) => !s.committed);
    if (!pending) return;
    const id = window.setInterval(async () => {
      const targets = shots.filter((s) => !s.committed && s.id !== editingId);
      if (targets.length === 0) return;
      const updates = await Promise.all(
        targets.map(async (s) => {
          try {
            const j = (await (await fetch(`/v1/receipts/${s.id}`)).json()) as {
              receipt?: { ocr_status: string; date: string | null; payee: string | null; total: number | null; items: string | null; committed_at: number | null };
            };
            return j.receipt ? { id: s.id, r: j.receipt } : null;
          } catch {
            return null;
          }
        }),
      );
      setShots((prev) =>
        prev.map((s) => {
          const u = updates.find((x) => x && x.id === s.id);
          if (!u) return s;
          return {
            ...s,
            ocr_status: u.r.ocr_status,
            date: u.r.date,
            payee: u.r.payee,
            total: u.r.total,
            items: u.r.items,
            committed: u.r.committed_at != null,
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
        if (res.ok) return { ...x, committed: true, note: undefined };
        return { ...x, note: res.message ?? res.error };
      }),
    );
  }

  const committedCount = shots.filter((s) => s.committed).length;

  return (
    <div>
      <h2>レシート撮影</h2>
      <p style={{ color: "var(--c-subtle)", fontSize: "0.85rem" }}>
        レシートを画面に収めて <strong>シャッター</strong> を押すだけ。 何枚でも続けて撮れます。
        撮影 → OCR (自動) → <strong>日付・場所・金額</strong> が揃ったら投入。
        投入は (日付-場所-金額) が同じものを重複として弾きます。
      </p>

      <div className="scan-stage" style={{ position: "relative", maxWidth: 480 }}>
        <video ref={videoRef} muted playsInline style={{ width: "100%", borderRadius: 8, background: "#000" }} />
        <button
          onClick={() => void shoot()}
          disabled={!running || capturing}
          aria-label="シャッター"
          style={{
            position: "absolute",
            bottom: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            width: 68,
            height: 68,
            borderRadius: "50%",
            border: "4px solid rgba(255,255,255,0.9)",
            background: capturing ? "var(--c-accent)" : "rgba(255,255,255,0.35)",
            cursor: running ? "pointer" : "not-allowed",
            boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
            transition: "background 120ms, transform 80ms",
          }}
        />
      </div>

      <div className="scan-meta" style={{ marginTop: "0.5rem" }}>
        {error ? (
          <span className="error">{error}</span>
        ) : (
          <>camera: {running ? "ready" : "starting…"} ｜ 撮影 {shots.length} 枚 ｜ 投入済 {committedCount}</>
        )}
      </div>

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
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ShotCard({
  shot,
  editing,
  onToggleEdit,
  onCommit,
  onSaved,
}: {
  shot: Shot;
  editing: boolean;
  onToggleEdit: () => void;
  onCommit: () => void;
  onSaved: () => void;
}) {
  const complete = isComplete(shot);
  const borderColor = shot.committed
    ? "var(--c-ok)"
    : complete
      ? "var(--c-accent)"
      : "var(--c-border)";
  return (
    <div
      style={{
        display: "flex",
        gap: "0.75rem",
        alignItems: "flex-start",
        background: "var(--c-muted)",
        border: `1px solid ${borderColor}`,
        borderRadius: 6,
        padding: "0.5rem",
      }}
    >
      <img
        src={`/v1/receipts/${shot.id}/image`}
        alt=""
        style={{ width: 64, height: 85, objectFit: "cover", borderRadius: 4, background: "var(--c-bg)" }}
      />
      <div style={{ flex: 1, minWidth: 0, fontSize: "0.8rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: shot.committed ? "var(--c-ok)" : "var(--c-subtle)" }}>
            {shot.committed ? "✅ 投入済" : statusLabel(shot.ocr_status)}
          </span>
          <span style={{ color: "var(--c-subtle)" }}>{new Date(shot.capturedAt * 1000).toLocaleTimeString()}</span>
        </div>
        <div style={{ marginTop: 2 }}>
          <Field label="日付" value={shot.date} />
          {" ｜ "}
          <Field label="場所" value={shot.payee} />
          {" ｜ "}
          <Field label="金額" value={shot.total != null ? `¥${shot.total.toLocaleString()}` : null} />
        </div>
        {shot.note && <div className="error" style={{ marginTop: 2, fontSize: "0.75rem" }}>{shot.note}</div>}

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
              disabled={!complete}
              title={complete ? "投入" : "日付・場所・金額が揃うと投入できます"}
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
      {value ? <strong>{value}</strong> : <span style={{ color: "var(--c-danger)" }}>—</span>}
    </span>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending": return "⏳ OCR待ち";
    case "processing": return "🔄 OCR中";
    case "done": return "📝 OCR完了";
    case "failed": return "⚠️ OCR失敗";
    case "manual": return "✍️ 手入力";
    default: return status;
  }
}
