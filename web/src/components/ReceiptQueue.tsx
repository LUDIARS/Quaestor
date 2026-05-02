import { useEffect, useState } from "react";

interface QueueRow {
  id: string;
  captured_at: number;
  ocr_status: string;
  payee: string | null;
  total: number | null;
  date: string | null;
  image_path: string | null;
}

interface Props {
  /** 何件まで表示するか (既定 12) */
  limit?: number;
  /** 自動 refresh 間隔 (既定 5000ms)、 0 で停止 */
  pollMs?: number;
  /** 表示する status (既定 ["pending","processing","failed","manual"]) */
  statuses?: string[];
  /** タイトル左に出る subtitle (Scan / Receipts どちらから呼ばれたか分かるよう) */
  origin?: string;
}

/**
 * レシート解析キューウィジェット。
 *
 * 「scan で取り込んだ画像 → OCR 待ち / failed / manual」 を可視化する共有 UI。
 * Claude Code 等の外部 agent が `GET /v1/receipts?status=pending` を叩いて
 * 順次処理する想定。 OcrWorker (Anthropic SDK 経由) も並走可能、 排他ではない。
 */
export function ReceiptQueue({
  limit = 12,
  pollMs = 5000,
  statuses = ["pending", "processing", "failed", "manual"],
  origin,
}: Props) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const promises = statuses.map((s) =>
        fetch(`/v1/receipts?status=${encodeURIComponent(s)}&limit=${limit}`).then(
          (r) => r.json() as Promise<{ items: QueueRow[] }>,
        ),
      );
      const results = await Promise.all(promises);
      const merged = results.flatMap((r) => r.items);
      merged.sort((a, b) => b.captured_at - a.captured_at);
      setRows(merged.slice(0, limit));
      setErr(null);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    if (pollMs <= 0) return;
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [pollMs, limit, statuses.join(",")]);

  async function runOcr(id: string) {
    try {
      // OCR 無効時 (503) も silently 続行 — Claude Code 側で処理する想定なので alert 不要
      await fetch(`/v1/receipts/${id}/ocr/run`, { method: "POST" });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div className="fd-card text-subtle text-sm">queue loading…</div>;

  const counts = {
    pending: rows.filter((r) => r.ocr_status === "pending").length,
    processing: rows.filter((r) => r.ocr_status === "processing").length,
    failed: rows.filter((r) => r.ocr_status === "failed").length,
    manual: rows.filter((r) => r.ocr_status === "manual").length,
    done: rows.filter((r) => r.ocr_status === "done").length,
  };

  return (
    <section className="fd-section" style={{ marginTop: "0.75rem" }}>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-sm font-semibold m-0">📋 レシート解析キュー</h3>
        {origin && <span className="text-xs text-subtle">({origin})</span>}
        <div className="flex gap-2 text-xs ml-auto">
          {counts.pending > 0 && <span className="fd-badge fd-badge-warn">pending {counts.pending}</span>}
          {counts.processing > 0 && <span className="fd-badge fd-badge-muted">processing {counts.processing}</span>}
          {counts.failed > 0 && <span className="fd-badge fd-badge-danger">failed {counts.failed}</span>}
          {counts.manual > 0 && <span className="fd-badge fd-badge-warn">manual {counts.manual}</span>}
        </div>
      </div>

      {err && <p className="error text-xs">{err}</p>}
      {rows.length === 0 ? (
        <p className="text-subtle text-xs m-0">キュー空 — scan で取り込むとここに出る</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {rows.map((r) => (
            <QueueCard key={r.id} row={r} onRunOcr={() => void runOcr(r.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function QueueCard({ row, onRunOcr }: { row: QueueRow; onRunOcr: () => void }) {
  const statusColor =
    row.ocr_status === "pending"
      ? "var(--c-warn)"
      : row.ocr_status === "processing"
        ? "var(--c-accent)"
        : row.ocr_status === "failed"
          ? "var(--c-danger)"
          : row.ocr_status === "manual"
            ? "var(--c-warn)"
            : "var(--c-subtle)";
  return (
    <div
      style={{
        background: "var(--c-muted)",
        border: `1px solid ${statusColor}`,
        borderRadius: 4,
        padding: "0.3rem",
        fontSize: "0.7rem",
      }}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "3 / 4",
          background: "var(--c-bg)",
          borderRadius: 3,
          overflow: "hidden",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {row.image_path ? (
          <img
            src={`/v1/receipts/${row.id}/image`}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ color: "var(--c-subtle)" }}>(no image)</span>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: statusColor, fontWeight: 600 }}>{row.ocr_status}</span>
        <span style={{ color: "var(--c-subtle)" }}>{new Date(row.captured_at * 1000).toLocaleTimeString()}</span>
      </div>
      {row.payee && <div style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.payee}</div>}
      {row.total != null && <div style={{ color: "var(--c-ok)" }}>¥{row.total.toLocaleString()}</div>}
      {(row.ocr_status === "pending" || row.ocr_status === "failed") && (
        <button
          className="fd-btn-ghost"
          style={{ marginTop: 2, padding: "0.1rem 0.3rem", fontSize: "0.7rem", width: "100%" }}
          onClick={onRunOcr}
        >
          OCR
        </button>
      )}
    </div>
  );
}
