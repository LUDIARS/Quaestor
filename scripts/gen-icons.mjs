/**
 * Quaestor 用 icon set を生成。
 *
 * 出力:
 *   src-tauri/icons/icon.png  (1024×1024、 macOS / Linux 用 + tauri.conf.json 参照)
 *   src-tauri/icons/icon.ico  (Windows 用、 16/32/48/64/128/256 multi-resolution)
 *
 * デザイン: 角丸 1024×1024 の濃灰背景 + 中央に大きな白文字 "Q" + アクセント色の小さな下線。
 * 「Quaestor (財務官) のサイン」風に Q の足を強調する。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "src-tauri", "icons");
mkdirSync(OUT_DIR, { recursive: true });

// SVG 元画像 — sharp の SVG renderer (resvg 系) で raster 化する
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0e0f12"/>
      <stop offset="100%" stop-color="#1a1c21"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4dabf7"/>
      <stop offset="100%" stop-color="#3893d4"/>
    </linearGradient>
  </defs>
  <!-- rounded square background -->
  <rect width="1024" height="1024" rx="200" ry="200" fill="url(#bg)"/>
  <!-- main letter Q -->
  <text x="512" y="660" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="780" font-weight="700"
        fill="#e8e9ec">Q</text>
  <!-- accent: short underline = ledger entry -->
  <rect x="320" y="780" width="384" height="40" rx="20" ry="20" fill="url(#accent)"/>
</svg>
`;

const SIZES = [16, 32, 48, 64, 128, 256];

async function main() {
  // PNG: 1024×1024 メイン
  const pngBuf = await sharp(Buffer.from(SVG)).resize(1024, 1024).png().toBuffer();
  writeFileSync(resolve(OUT_DIR, "icon.png"), pngBuf);
  console.log(`wrote ${OUT_DIR}/icon.png (${pngBuf.length.toLocaleString()} bytes)`);

  // 各サイズの PNG を生成し、 ICO に束ねる
  const buffers = await Promise.all(
    SIZES.map(async (size) =>
      sharp(Buffer.from(SVG)).resize(size, size).png().toBuffer(),
    ),
  );
  const icoBuf = await pngToIco(buffers);
  writeFileSync(resolve(OUT_DIR, "icon.ico"), icoBuf);
  console.log(`wrote ${OUT_DIR}/icon.ico (${icoBuf.length.toLocaleString()} bytes、 ${SIZES.length} sizes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
