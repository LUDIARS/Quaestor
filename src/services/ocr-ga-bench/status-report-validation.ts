/**
 * bench-report.json から status API が読むラベルの境界検証。
 * 構文が正しくても欠損したラベルは捨て、観測 endpoint 全体を落とさない。
 *
 * @implements SPEC-OCR-GA-EVAL-007 (spec/feature/ocr-ga-evaluation.md)
 */

import type { LabelBenchReport } from "./types.js";
import { normalizeGaKey } from "../ocr-ga.js";

export function isReadableBenchLabel(value: unknown): value is LabelBenchReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const label = value as Partial<LabelBenchReport>;
  return typeof label.label === "string" && normalizeGaKey(label.label) === label.label
    && isCorpus(label.corpus)
    && isFiniteNumber(label.generation)
    && isFiniteNumber(label.generationsRun)
    && isFiniteNumber(label.population)
    && isScoreSummary(label.best)
    && isFiniteNumber(label.mean)
    && isFiniteNumber(label.worst)
    && isScoreSummary(label.baseline)
    && isHoldout(label.holdout)
    && isFiniteNumber(label.secondsPerIndividual)
    && isFiniteNumber(label.totalSeconds)
    && isFiniteNumber(label.detectCalls)
    && isFiniteNumber(label.errors)
    && typeof label.reseeded === "boolean"
    && typeof label.ts === "string";
}

function isCorpus(value: unknown): value is LabelBenchReport["corpus"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const corpus = value as Partial<LabelBenchReport["corpus"]>;
  return isFiniteNumber(corpus.train) && isFiniteNumber(corpus.holdout) && isFiniteNumber(corpus.total);
}

function isScoreSummary(value: unknown): value is LabelBenchReport["baseline"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<LabelBenchReport["baseline"]>;
  const rates = summary.fieldHitRate;
  return isFiniteNumber(summary.fitness)
    && !!rates
    && isFiniteNumber(rates.date)
    && isFiniteNumber(rates.payee)
    && isFiniteNumber(rates.total);
}

function isHoldout(value: unknown): value is LabelBenchReport["holdout"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const holdout = value as Partial<LabelBenchReport["holdout"]>;
  return (holdout.best === null || isScoreSummary(holdout.best))
    && (holdout.baseline === null || isScoreSummary(holdout.baseline));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
