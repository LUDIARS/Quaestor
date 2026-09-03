import { useState } from "react";
import "./ScanGuide.css";
import { DOC_KINDS, DOC_KIND_INFO } from "../../../src/shared/document-kinds.js";
import { DOC_KIND_COLORS } from "./scan-badges.js";

/**
 * カメラ右上に乗せる 「撮影対象と自動仕訳」 ボタンと、 押したときの説明パネル。
 * カメラをファーストビューに置いたまま、 何を撮れるか / 撮った後どこへ流れるかを
 * その場で読めるようにする。 パネルはカメラステージ全面のオーバーレイ。
 *
 * 内容は書類種別 (6 種) ごとの投入先の一覧で、 語彙 (shared/document-kinds) から組み立てる。
 * 実装と説明がずれないよう、 静的な文章は持たない。
 *
 * @implements SPEC-SCAN-KIND-001 (spec/feature/scan-document-kinds.md)
 * @implements SPEC-RECEIPT-AUTO-INTAKE-001 (spec/feature/receipt-auto-intake.md)
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
          <h3>撮影対象と投入先</h3>
          <ul className="scan-guide-kinds">
            {DOC_KINDS.map((k) => {
              const info = DOC_KIND_INFO[k];
              return (
                <li key={k}>
                  <span
                    className="scan-guide-kind"
                    style={{ "--sg-clr": DOC_KIND_COLORS[k] } as React.CSSProperties}
                  >
                    {info.label}
                  </span>
                  <span className="scan-guide-desc">{info.description}</span>
                  <span className="scan-guide-dest">→ {info.destination}</span>
                </li>
              );
            })}
          </ul>
          <p className="scan-guide-hint">
            種別は撮影後に自動判定され、 撮影一覧のバッジをタップして直せます。 パネルをタップすると閉じます。
          </p>
        </div>
      )}
    </>
  );
}
