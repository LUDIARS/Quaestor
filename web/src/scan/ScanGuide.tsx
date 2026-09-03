import { useState } from "react";
import "./ScanGuide.css";

/**
 * カメラ右上に乗せる 「撮影対象と自動仕訳」 ボタンと、 押したときの説明パネル。
 * カメラをファーストビューに置いたまま、 何を撮れるか / 撮った後に何が起きるかを
 * その場で読めるようにする。 パネルはカメラステージ全面のオーバーレイ。
 *
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
 * @implements SPEC-RECEIPT-AUTO-INTAKE-002 (spec/feature/receipt-auto-intake.md)
 * @implements SPEC-HOUSEHOLD-ANALYSIS-001 (spec/feature/household-bookkeeping.md)
 */
export function ScanGuide() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="scan-guide-btn"
        aria-expanded={open}
        aria-controls="scan-guide-panel"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "閉じる" : "撮影対象と自動仕訳"}
      </button>

      {open && (
        <div
          id="scan-guide-panel"
          className="scan-guide-panel"
          role="region"
          aria-label="撮影対象と自動仕訳"
          onClick={() => setOpen(false)}
        >
          <h3>撮影対象</h3>
          <ul>
            <li>レシート・領収書 (店頭でもらう紙)</li>
            <li>請求書・明細書 (電気・ガス・水道・通信など)</li>
            <li>手書きの領収書やメモでも、 <strong>日付・場所・金額</strong> が読めれば投入できる</li>
          </ul>
          <h3>自動仕訳</h3>
          <ul>
            <li>撮影 → OCR → 日付・場所・金額が揃えば <strong>自動で投入</strong></li>
            <li>投入後、 クレカ明細と自動で突合 (レシートと明細のどちらが先でも可)</li>
            <li>突合した分は取引側で数え、 未突合は現金払いとして家計分析に載る</li>
            <li>家計分析では、 按分シートで作ったルールに沿って家計分と業務分に分ける</li>
            <li>揃わない / 重複 (同じ日付・場所・金額) のものだけ、 撮影一覧から手で直す</li>
          </ul>
          <p className="scan-guide-hint">パネルをタップすると閉じます。</p>
        </div>
      )}
    </>
  );
}
