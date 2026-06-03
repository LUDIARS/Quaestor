import { useState } from "react";
import { ManualShutter } from "../scan/ManualShutter.js";
import { ArScanner } from "../scan/ArScanner.js";
import { ReceiptQueue } from "../components/ReceiptQueue.js";

type ScanMode = "manual" | "ar";

const MODE_KEY = "quaestor.scan.mode";
function loadMode(): ScanMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "manual" || v === "ar") return v;
  } catch { /* ignore */ }
  return "manual"; // 既定は手動シャッター
}

/**
 * レシート取り込みページ。
 *  - manual : パシャパシャ手動シャッター (既定)。 撮影 → OCR → 投入 (日付-場所-金額 でユニーク判定)
 *  - ar     : 端で白枠を自動検出して安定したら自動キャプチャ (旧来方式、 opt-in)
 * 解析キュー ([[ReceiptQueue]]) はモード問わず下部に出す。
 */
export function Scan() {
  const [mode, setMode] = useState<ScanMode>(loadMode());
  function changeMode(m: ScanMode) {
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="flex items-center gap-2" style={{ marginBottom: "0.5rem" }}>
        <span className="text-xs text-subtle">撮影方式:</span>
        <ModeButton active={mode === "manual"} onClick={() => changeMode("manual")}>手動シャッター</ModeButton>
        <ModeButton active={mode === "ar"} onClick={() => changeMode("ar")}>AR 自動検出</ModeButton>
      </div>

      {mode === "manual" ? <ManualShutter /> : <ArScanner />}

      <ReceiptQueue origin="scan tab" />
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={active ? "fd-btn" : "fd-btn-ghost"}
      style={{ padding: "0.15rem 0.6rem", fontSize: "0.8rem" }}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
