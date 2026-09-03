/**
 * OCR-GA の fitness (backend 版)。
 *
 * sidecar (PaddleOCR) が返した行テキスト群が LLM 真値 (date / payee / total / items) を
 * どれだけ復元できているかを 0..1 で採点する純関数。web/src/scanner/ocr-evolver.ts の
 * fitnessVsTruth を backend に移し、真値側と行側の正規化を揃え、隣接行結合・フィールド重み・
 * 1 行加点・評価コスト項を加えたもの。
 *
 *  - 日付: 年/月/日/曜日/時刻/区切りを落として YYYYMMDD 同士で比べる (和暦も西暦化)
 *  - 金額: ¥ , 円 - を落として整数トークン同士で比べる (全角→半角)
 *  - 店名: NFKC (半角カナ→全角カナ) → normalizePayee (全角英数→半角・大文字化) → 空白除去。
 *    候補行が真値を丸ごと含めば 1 (店名の後ろに TEL 等が続いても減点しない)
 *  - 隣接行結合: y 中心が近い 2〜3 行を連結した候補も照合する (店名が複数行に割れる)
 *  - 重み: total 0.4 / date 0.3 / payee 0.2 / items 0.1 (真値の無いフィールドは重みから外す)
 *  - 1 行加点: 結合候補で当てた場合は 0.9 倍 (= 1 行 (bbox 1 つ) に収まる個体を優遇)
 *  - コスト項: 評価秒数 × costPerSecond を引く (係数 0 で無効)
 *
 * fieldHits (date / payee / total の復元可否) は KPI「field hit rate」の元データ。
 * ネットワーク / DB / 時計に依存しない。elapsedMs は呼び出し側が測って渡す。
 *
 * @implements SPEC-OCR-GA-EVAL-002 (spec/feature/ocr-ga-evaluation.md)
 */

import { levenshtein } from "../shared/levenshtein.js";
import { normalizeDate, normalizePayee } from "../shared/text.js";
import { parseReferenceItems, type ReferenceFields } from "./detection-eval.js";
import type { OcrLine } from "./ocr-sidecar-client.js";

/** 真値 (LLM 出力 + 人の修正後)。detection-eval の ReferenceFields と同形 */
export type OcrTruth = ReferenceFields;

export interface FitnessWeights {
  total: number;
  date: number;
  payee: number;
  items: number;
}

/** 投入の完備条件に直結する順の重み */
export const DEFAULT_FITNESS_WEIGHTS: Readonly<FitnessWeights> = { total: 0.4, date: 0.3, payee: 0.2, items: 0.1 };
/** 結合候補 (2〜3 行) で当てたときの倍率。1 行で収まる個体への相対加点 */
export const MERGED_LINE_FACTOR = 0.9;
/** payee / items を「復元できた」とみなす類似度 */
export const TEXT_HIT_THRESHOLD = 0.8;
/** 真値 items のうち採点に使う先頭件数 */
export const MAX_TRUTH_ITEMS = 6;
/** 月日だけ一致 (年が読めていない) のときの日付スコア */
const MONTH_DAY_ONLY_SCORE = 0.75;
/** 隣接行結合の最大行数 */
const MAX_MERGE_LINES = 3;
/** 隣接とみなす y 中心間隔 (行高の倍率) */
const ADJACENT_GAP_FACTOR = 1.6;

export interface FitnessOptions {
  weights?: Partial<FitnessWeights>;
  /** この個体の評価にかかった時間 (ms)。コスト項に使う */
  elapsedMs?: number;
  /** 1 秒あたりの減点。0 / 未指定でコスト項なし */
  costPerSecond?: number;
}

export interface FieldHits {
  date: boolean;
  payee: boolean;
  total: boolean;
}

export interface FieldScores {
  date: number | null;
  payee: number | null;
  total: number | null;
  items: number | null;
}

export interface FitnessResult {
  /** 0..1。コスト項を引いた最終値 */
  fitness: number;
  /** コスト項を引く前の加重スコア (0..1) */
  score: number;
  /** フィールド別スコア。真値が無いフィールドは null */
  fieldScores: FieldScores;
  fieldHits: FieldHits;
  costPenalty: number;
}

/** 照合候補: 1 行そのもの、または隣接 2〜3 行の連結 */
export interface TextCandidate {
  text: string;
  lineCount: number;
}

interface FieldScore {
  score: number;
  hit: boolean;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

export function computeOcrFitness(
  lines: readonly OcrLine[],
  truth: OcrTruth,
  opts: FitnessOptions = {},
): FitnessResult {
  const candidates = buildTextCandidates(lines);
  const weights: FitnessWeights = { ...DEFAULT_FITNESS_WEIGHTS, ...opts.weights };

  const date  = scoreDate(candidates, truth.date);
  const total = scoreTotal(candidates, truth.total);
  const payee = scorePayee(candidates, truth.payee);
  const items = scoreItems(candidates, truth.items);

  let weightSum = 0;
  let acc = 0;
  const add = (w: number, f: FieldScore | null): void => {
    if (!f) return;
    weightSum += w;
    acc += w * f.score;
  };
  add(weights.total, total);
  add(weights.date, date);
  add(weights.payee, payee);
  add(weights.items, items);

  const score = weightSum > 0 ? acc / weightSum : 0;
  const costPenalty = Math.max(0, (opts.costPerSecond ?? 0) * (opts.elapsedMs ?? 0) / 1000);
  const fitness = clamp01(score - costPenalty);

  return {
    fitness: round4(fitness),
    score: round4(score),
    fieldScores: {
      date:  date  ? round4(date.score)  : null,
      payee: payee ? round4(payee.score) : null,
      total: total ? round4(total.score) : null,
      items: items ? round4(items.score) : null,
    },
    fieldHits: { date: date?.hit ?? false, payee: payee?.hit ?? false, total: total?.hit ?? false },
    costPenalty: round4(costPenalty),
  };
}

/**
 * 行を y 中心 (同じ高さなら x) で並べ、1 行候補 + 隣接 2〜3 行の連結候補を作る。
 * 連結は「y 中心の間隔 ≤ 行高 × ADJACENT_GAP_FACTOR」が連続する範囲だけ。
 */
export function buildTextCandidates(lines: readonly OcrLine[]): TextCandidate[] {
  const sorted = lines
    .filter((l) => l.text.trim().length > 0)
    .map((l) => ({ text: l.text.trim(), x: l.bbox[0], y: l.bbox[1] + l.bbox[3] / 2, h: Math.max(1, l.bbox[3]) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const out: TextCandidate[] = sorted.map((l) => ({ text: l.text, lineCount: 1 }));
  for (let i = 0; i < sorted.length; i++) {
    for (let n = 2; n <= MAX_MERGE_LINES; n++) {
      const span = sorted.slice(i, i + n);
      if (span.length < n || !isAdjacentRun(span)) break;
      out.push({ text: span.map((l) => l.text).join(" "), lineCount: n });
    }
  }
  return out;
}

/** 全角英数記号 → 半角、全角空白 → 半角空白 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

/** 行テキストから日付らしいトークンを取り出す (full = YYYYMMDD、monthDay = MMDD) */
export function extractDateTokens(text: string): { full: string[]; monthDay: string[] } {
  const t = toHalfWidth(text);
  const full: string[] = [];
  const monthDay: string[] = [];
  for (const m of t.matchAll(/(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/g)) {
    const v = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) full.push(v);
  }
  // 和暦 (令和 / R) → 西暦。令和 n 年 = 2018 + n
  for (const m of t.matchAll(/(?:令和|R)\s*(\d{1,2})\s*[年.]\s*(\d{1,2})\s*[月.]\s*(\d{1,2})/g)) {
    const v = ymd(2018 + Number(m[1]), Number(m[2]), Number(m[3]));
    if (v) full.push(v);
  }
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*[月/]\s*(\d{1,2})(?!\d)/g)) {
    const v = ymd(2000, Number(m[1]), Number(m[2]));
    if (v) monthDay.push(v.slice(4));
  }
  return { full, monthDay };
}

/** 行テキストから金額らしい整数トークンを取り出す (¥ , 円 - を落とし、桁区切りを外す) */
export function extractAmountTokens(text: string): string[] {
  let t = toHalfWidth(text).replace(/[¥￥円]/g, "").replace(/[−ー－-]/g, " ");
  // 桁区切りのカンマだけ外す (1,234,567 → 1234567)。数字の並びを跨ぐカンマは区切りとして残す
  let prev: string;
  do {
    prev = t;
    t = t.replace(/(\d)[,，](\d{3})(?!\d)/g, "$1$2");
  } while (t !== prev);
  return (t.match(/\d+/g) ?? []).map((s) => s.replace(/^0+(?=\d)/, ""));
}

/** 正規化済み文字列の対称な類似度 (0..1)。包含は長さ比、それ以外は Levenshtein 比 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

/**
 * 真値 (target) を候補行 (candidate) がどれだけ含むか (0..1、非対称)。
 * 候補が真値を丸ごと含めば 1 (「牛乳 220」に「牛乳」、「SUPERMARKET KASUMI TEL...」に店名)。
 * 真値の一部しか無ければ長さ比、それ以外は Levenshtein 比。1 文字の真値は偶然含まれやすいので長さ比に落とす。
 */
export function containsScore(target: string, candidate: string): number {
  if (!target || !candidate) return 0;
  if (target === candidate) return 1;
  if (candidate.includes(target)) return target.length >= 2 ? 1 : target.length / candidate.length;
  if (target.includes(candidate)) return candidate.length / target.length;
  return Math.max(0, 1 - levenshtein(target, candidate) / Math.max(target.length, candidate.length));
}

// ---------------------------------------------------------------------------
// フィールド別採点 (真値が無ければ null = 重みから外す)
// ---------------------------------------------------------------------------

function scoreDate(candidates: TextCandidate[], truthDate: string | null): FieldScore | null {
  const target = truthYmd(truthDate);
  if (!target) return null;
  const targetMonthDay = target.slice(4);
  return bestOver(candidates, (text) => {
    const { full, monthDay } = extractDateTokens(text);
    if (full.includes(target)) return { score: 1, hit: true };
    let score = 0;
    for (const f of full) score = Math.max(score, textSimilarity(target, f));
    if (monthDay.includes(targetMonthDay)) score = Math.max(score, MONTH_DAY_ONLY_SCORE);
    return { score, hit: false };
  });
}

function scoreTotal(candidates: TextCandidate[], total: number | null): FieldScore | null {
  if (total == null || !Number.isFinite(total)) return null;
  const target = String(Math.abs(Math.round(total)));
  return bestOver(candidates, (text) => {
    const tokens = extractAmountTokens(text);
    if (tokens.includes(target)) return { score: 1, hit: true };
    let score = 0;
    for (const tok of tokens) score = Math.max(score, textSimilarity(target, tok));
    return { score, hit: false };
  });
}

function scorePayee(candidates: TextCandidate[], payee: string | null): FieldScore | null {
  const target = payee ? payeeKey(payee) : "";
  if (!target) return null;
  return bestOver(candidates, (text) => {
    const sim = containsScore(target, payeeKey(text));
    return { score: sim, hit: sim >= TEXT_HIT_THRESHOLD };
  });
}

function scoreItems(candidates: TextCandidate[], items: string | null): FieldScore | null {
  const names = parseReferenceItems(items, MAX_TRUTH_ITEMS).map(itemKey).filter((s) => s.length > 0);
  if (names.length === 0) return null;
  let sum = 0;
  let allHit = true;
  for (const name of names) {
    const best = bestOver(candidates, (text) => {
      const sim = containsScore(name, itemKey(text));
      return { score: sim, hit: sim >= TEXT_HIT_THRESHOLD };
    });
    sum += best.score;
    allHit &&= best.hit;
  }
  return { score: sum / names.length, hit: allHit };
}

/** 候補全体での最良。結合候補は MERGED_LINE_FACTOR 倍 (hit 判定は素の値で行う) */
function bestOver(candidates: TextCandidate[], scorer: (text: string) => FieldScore): FieldScore {
  let score = 0;
  let hit = false;
  for (const c of candidates) {
    const r = scorer(c.text);
    score = Math.max(score, c.lineCount > 1 ? r.score * MERGED_LINE_FACTOR : r.score);
    hit ||= r.hit;
  }
  return { score, hit };
}

// ---------------------------------------------------------------------------
// 正規化ヘルパー
// ---------------------------------------------------------------------------

function truthYmd(date: string | null): string | null {
  if (!date) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : normalizeDate(date);
  return iso ? iso.replace(/-/g, "") : null;
}

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

/**
 * 店名キー: NFKC (半角カナ→全角、全角英数→半角、㈱→(株) 等) → normalizePayee (大文字化) → 空白除去。
 * 紙面の「ｶｽﾐ」と LLM の「カスミ」を同じにする。
 */
function payeeKey(s: string): string {
  return normalizePayee(s.normalize("NFKC")).replace(/\s+/g, "");
}

function itemKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[¥￥,\s\-/、。・]/g, "");
}

function isAdjacentRun(span: Array<{ y: number; h: number }>): boolean {
  for (let k = 1; k < span.length; k++) {
    const a = span[k - 1]!;
    const b = span[k]!;
    if (b.y - a.y > Math.max(a.h, b.h) * ADJACENT_GAP_FACTOR) return false;
  }
  return true;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
