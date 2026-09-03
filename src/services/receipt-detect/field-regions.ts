/**
 * sidecar の認識行を LLM 真値フィールドへ対応づけ、本物 BB (source=real) の領域にする。
 *
 * 旧 `web/src/scanner/paddle-locator.ts` の buildRegions を backend に移したもの。
 * 独自の正規化を持たず、採点 (`ocr-ga-fitness.ts`) と同じ正規化を使う:
 * 日付は YYYYMMDD トークン、金額は桁区切りを外した整数トークン、店名は payeeKey、
 * items は itemKey。マッチングと採点で「当たった / 当たらない」がずれないようにする。
 *
 * 1 フィールド = 1 行 (bbox 1 つ)。結合行は BB が定まらないので採らない
 * (学習データに曖昧な矩形を入れない)。
 *
 * @implements SPEC-OCR-GA-EVAL-006 (spec/feature/ocr-ga-evaluation.md)
 */

import { parseReferenceItems, type ReferenceFields } from "../detection-eval.js";
import {
  containsScore, extractAmountTokens, extractDateTokens, itemKey, payeeKey, textSimilarity,
} from "../ocr-ga-fitness.js";
import type { OcrLine } from "../ocr-sidecar-client.js";
import type { DetectedFieldRegion } from "./types.js";

/** これ未満のスコアの行は「当てられなかった」とみなす (旧 web locator と同じ足切り) */
export const MIN_MATCH_SCORE = 0.35;
/** BB を出す items の先頭件数 (fitness の MAX_TRUTH_ITEMS と揃える) */
export const MAX_ITEM_REGIONS = 6;

/**
 * 認識行 × 真値 → 本物 BB。真値が無いフィールドと、閾値に届かなかったフィールドは出さない。
 * 同じ行が 2 つのフィールドに当たった場合は先に確定した方が持つ (payee → date → total → items)。
 */
export function buildFieldRegions(lines: readonly OcrLine[], truth: ReferenceFields): DetectedFieldRegion[] {
  const used = new Set<OcrLine>();
  const out: DetectedFieldRegion[] = [];

  const take = (field: string, line: OcrLine | null): void => {
    if (!line) return;
    used.add(line);
    const [x, y, width, height] = line.bbox;
    out.push({
      field,
      x, y, width, height,
      confidence: clamp01(line.score),
      recognizedText: line.text,
      polygon: line.polygon,
    });
  };

  take("payee", matchPayee(lines, used, truth.payee));
  take("date", matchDate(lines, used, truth.date));
  take("total", matchTotal(lines, used, truth.total));

  const items = parseReferenceItems(truth.items, MAX_ITEM_REGIONS);
  items.forEach((name, i) => take(`item-${i}`, matchItem(lines, used, name)));

  return out;
}

// ---------------------------------------------------------------------------
// フィールド別マッチング (採点と同じ正規化)
// ---------------------------------------------------------------------------

function matchPayee(lines: readonly OcrLine[], used: Set<OcrLine>, payee: string | null): OcrLine | null {
  const target = payee ? payeeKey(payee) : "";
  if (!target) return null;
  return bestLine(lines, used, (text) => containsScore(target, payeeKey(text)));
}

function matchDate(lines: readonly OcrLine[], used: Set<OcrLine>, date: string | null): OcrLine | null {
  const target = truthYmd(date);
  if (!target) return null;
  const monthDay = target.slice(4);
  return bestLine(lines, used, (text) => {
    const tokens = extractDateTokens(text);
    if (tokens.full.includes(target)) return 1;
    let score = tokens.monthDay.includes(monthDay) ? 0.75 : 0;
    for (const f of tokens.full) score = Math.max(score, textSimilarity(target, f));
    return score;
  });
}

function matchTotal(lines: readonly OcrLine[], used: Set<OcrLine>, total: number | null): OcrLine | null {
  if (total == null || !Number.isFinite(total)) return null;
  const target = String(Math.abs(Math.round(total)));
  return bestLine(lines, used, (text) => {
    const tokens = extractAmountTokens(text);
    if (tokens.includes(target)) return 1;
    let score = 0;
    for (const tok of tokens) score = Math.max(score, textSimilarity(target, tok));
    return score;
  });
}

function matchItem(lines: readonly OcrLine[], used: Set<OcrLine>, name: string): OcrLine | null {
  const target = itemKey(name);
  if (!target) return null;
  return bestLine(lines, used, (text) => containsScore(target, itemKey(text)));
}

/** 未使用行のうち最良。MIN_MATCH_SCORE 未満なら null */
function bestLine(
  lines: readonly OcrLine[],
  used: Set<OcrLine>,
  score: (text: string) => number,
): OcrLine | null {
  let best: OcrLine | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    if (used.has(line) || line.text.trim().length === 0) continue;
    const s = score(line.text);
    if (s > bestScore) { bestScore = s; best = line; }
  }
  return bestScore >= MIN_MATCH_SCORE ? best : null;
}

/** ISO 日付 (真値) → YYYYMMDD。DB の date は ISO 固定なのでここでは変換だけ */
function truthYmd(date: string | null): string | null {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, "") : null;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
