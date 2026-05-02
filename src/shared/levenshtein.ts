/**
 * Levenshtein 距離 (1 文字置換 / 挿入 / 削除でマッチさせるための最小編集回数)。
 * 店名類似度の bare-bones 比較に使う。 全角・半角は呼び出し側で normalizePayee 済前提。
 *
 * 計算量 O(m*n)。 比較対象が長くても 100 文字程度なので許容。
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 1 行 + 1 セル の DP で済ませる
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = cur;
    }
  }
  return prev[b.length];
}

/** 0..1 で類似度を返す。 1 = 完全一致、 0 = 全く違う */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}
