/**
 * `evolution.jsonl` (GaStore の学習ログ) の **読み取り**。
 *
 * 書くのは `GaStore.appendEvolutionLog` (genetic.ts) だけ。ここは観測側 —
 * ラベル (集団キー) ごとに直近 N 世代を取り出して「進化が進んでいるか」を見せる。
 * 壊れた行は捨てる (観測用ファイルなので読めるものだけ使う)。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import { existsSync, readFileSync } from "node:fs";
import { normalizeGaKey } from "../ocr-ga.js";
import type { GaGenerationPoint } from "./status-types.js";

export const EVOLUTION_LOG_FILE = "evolution.jsonl";
/** 推移として持つ世代数の既定 (カードの小さな推移表示に足りる分) */
export const DEFAULT_TREND_GENERATIONS = 20;

/**
 * ラベルごとに直近 `limit` 世代 (古い順) を返す。ファイルが無ければ空 Map。
 * ラベルの並びは呼び出し側 (status-service) が bench-report と突き合わせて決める。
 */
export function readEvolutionTrends(path: string, limit = DEFAULT_TREND_GENERATIONS): Map<string, GaGenerationPoint[]> {
  const trends = new Map<string, GaGenerationPoint[]>();
  if (limit < 1 || !existsSync(path)) return trends;

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return trends; // 観測用ファイル。読めなければ「推移なし」で status を返す
  }

  for (const line of body.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const points = trends.get(parsed.key) ?? [];
    points.push(parsed.point);
    if (points.length > limit) points.shift();
    trends.set(parsed.key, points);
  }
  return trends;
}

function parseLine(line: string): { key: string; point: GaGenerationPoint } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string" || normalizeGaKey(record.key) !== record.key) return null;
  if (typeof record.generation !== "number" || !Number.isFinite(record.generation)) return null;
  return {
    key: record.key,
    point: {
      ts: typeof record.ts === "string" ? record.ts : "",
      generation: record.generation,
      evaluated: typeof record.evaluated === "number" && Number.isFinite(record.evaluated) ? record.evaluated : 0,
      best: score(record.bestFitness),
      mean: score(record.meanFitness),
      baseline: score(record.baselineFitness),
      reseeded: record.reseeded === true,
    },
  };
}

function score(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
