/**
 * 検出差分評価 (deterministic)。
 *
 * 検出器 (PaddleOCR/Tesseract) が confirm フェーズで当てた本物 BB の認識テキストと、
 * OCR/確定済みフィールド値 (真値) を突合し、フィールドごとの差分を出す。
 * 毎レシートで安価に実行 → 学習レコードに保存。差分がある時だけ Opus 類推 (別モジュール) に渡す。
 *
 * 純関数。Anthropic/DB に依存しない。
 */

import type { TrainingRegion } from "./training-dataset.js";

export type DiffStatus =
  | "match"        // 検出テキスト ≈ 真値
  | "mismatch"     // 検出はしたが真値と食い違う
  | "missing"      // 真値はあるが検出器が当てられなかった
  | "no_reference"; // 真値が無い (比較対象なし)

export interface FieldDiff {
  field: string;            // payee / date / total / item-0 ...
  referenceText: string | null;
  detectedText: string | null;
  status: DiffStatus;
  /** 0..1 正規化類似度 */
  similarity: number;
}

export interface DetectionDiff {
  fields: FieldDiff[];
  /** 真値が存在するフィールド数 */
  evaluated: number;
  /** status=match の数 */
  matched: number;
  /** mismatch / missing が 1 つでもあれば true (= Opus 類推の起動条件) */
  hasDiff: boolean;
}

/** OCR/確定済みフィールド (真値) */
export interface ReferenceFields {
  date: string | null;
  payee: string | null;
  total: number | null;
  /** items は JSON 文字列 ([{name, price}]) or null */
  items: string | null;
}

/**
 * 検出領域 (本物 BB) と真値フィールドを突合して差分を返す。
 * @param regions confirm フェーズの source=real 領域 (label=フィールド種別, text=認識テキスト)
 */
export function computeDetectionDiff(
  regions: Pick<TrainingRegion, "label" | "text">[],
  reference: ReferenceFields,
): DetectionDiff {
  const byLabel = new Map<string, string>();
  for (const r of regions) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, r.text ?? "");
  }

  const fields: FieldDiff[] = [];

  fields.push(compareField("payee", reference.payee, byLabel.get("payee") ?? null));
  fields.push(compareField("date", reference.date, byLabel.get("date") ?? null));
  fields.push(compareField(
    "total",
    reference.total != null ? String(reference.total) : null,
    byLabel.get("total") ?? null,
  ));

  // items: 真値の各品目を最も近い検出 item-* に対応付ける
  const refItems = parseReferenceItems(reference.items);
  const detItems = [...byLabel.entries()]
    .filter(([k]) => k.startsWith("item-"))
    .map(([, v]) => v);
  refItems.forEach((name, i) => {
    const best = bestMatch(name, detItems);
    fields.push(compareField(`item-${i}`, name, best.text, best.score));
  });

  const withRef = fields.filter((f) => f.status !== "no_reference");
  const matched = fields.filter((f) => f.status === "match").length;
  const hasDiff = withRef.some((f) => f.status === "mismatch" || f.status === "missing");

  return { fields, evaluated: withRef.length, matched, hasDiff };
}

// ---------------------------------------------------------------------------

function compareField(
  field: string,
  reference: string | null,
  detected: string | null,
  precomputed?: number,
): FieldDiff {
  if (reference == null || reference.trim() === "") {
    return { field, referenceText: reference, detectedText: detected, status: "no_reference", similarity: 0 };
  }
  if (detected == null || detected.trim() === "") {
    return { field, referenceText: reference, detectedText: detected, status: "missing", similarity: 0 };
  }
  const sim = precomputed ?? similarity(reference, detected);
  return {
    field,
    referenceText: reference,
    detectedText: detected,
    status: sim >= 0.8 ? "match" : "mismatch",
    similarity: Number(sim.toFixed(3)),
  };
}

/**
 * 真値 items (JSON `[{name, price}]` or `["name", ...]`) から品目名を取り出す。
 * 壊れた JSON は空 (真値なし扱い)。OCR-GA fitness (ocr-ga-fitness.ts) と共用。
 */
export function parseReferenceItems(json: string | null, max = 10): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<unknown>;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => (typeof it === "object" && it !== null && typeof (it as { name?: unknown }).name === "string"
        ? (it as { name: string }).name
        : typeof it === "string" ? it : ""))
      .filter((s) => s !== "")
      .slice(0, max);
  } catch { return []; }
}

function bestMatch(needle: string, hay: string[]): { text: string | null; score: number } {
  let best: string | null = null;
  let bestScore = 0;
  for (const h of hay) {
    const s = similarity(needle, h);
    if (s > bestScore) { bestScore = s; best = h; }
  }
  return { text: best, score: bestScore };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[¥,\s\-/￥、。　]/g, "");
}

/** 正規化した文字列の類似度 (0..1)。包含 + Levenshtein 比。 */
function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length / long.length;
  }
  const dist = levenshtein(x, y);
  return 1 - dist / Math.max(x.length, y.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}
