/**
 * 既存レシートへの書類種別 / サンプルラベルの後付け (バッチ)。
 *
 * OCR 済みだがラベルの無い receipts (sample_role IS NULL) を撮影順に 1 件ずつ LLM に見せ、
 * kind と sample だけを返させて書き戻す。 fields (date / payee / total / items) は再抽出しない。
 *
 *  - 直列 1 件ずつ (LLM 1 回 ≈ 10 秒、 357 件 ≈ 1 時間の初期ベンチマーク)
 *  - 中断再開可: 既ラベルは母集団に入らないので、 再実行すれば続きから進む
 *  - 失敗 (LLM 応答が語彙外 / 例外) は書かずに次へ進む (再実行で再試行される)
 *  - runner は DI (テストはモック、 本番は claude CLI)
 *
 * @implements SPEC-SCAN-KIND-004 (spec/feature/scan-document-kinds.md)
 */

import type { ReceiptsRepo, ReceiptRow } from "../db/receipts-repo.js";
import type { ReceiptStorage } from "./receipt-storage.js";
import { buildLabelOnlyPrompt } from "./ocr-classification-prompt.js";
import { applyLlmLabels, normalizeLlmLabels } from "./receipt-labels.js";

/** prompt を投げて JSON 値 (unknown) を返す。 claude-cli.ts の runClaudeCliJson と同じ形。 */
export type LabelRunner = (prompt: string) => Promise<unknown>;

export interface SampleLabelerDeps {
  receipts: ReceiptsRepo;
  storage: ReceiptStorage;
  runner: LabelRunner;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
}

export interface SampleLabelRunOptions {
  /** 何件まで処理するか (未指定 = 未ラベル全部) */
  limit?: number;
  /** true なら LLM を呼ばず、 対象を列挙するだけ (書き込みも無し) */
  dryRun?: boolean;
}

export interface SampleLabelItemResult {
  id: string;
  status: "labeled" | "skipped" | "failed" | "planned";
  kind?: string;
  role?: string | null;
  error?: string;
}

export interface SampleLabelRunResult {
  /** 実行前の未ラベル件数 (再開の目安) */
  unlabeledBefore: number;
  scanned: number;
  labeled: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  items: SampleLabelItemResult[];
}

export async function runSampleLabeling(
  deps: SampleLabelerDeps,
  opts: SampleLabelRunOptions = {},
): Promise<SampleLabelRunResult> {
  const unlabeledBefore = deps.receipts.countUnlabeled();
  const targets = deps.receipts.listUnlabeled(opts.limit ?? unlabeledBefore);
  const result: SampleLabelRunResult = {
    unlabeledBefore, scanned: 0, labeled: 0, skipped: 0, failed: 0,
    dryRun: !!opts.dryRun, items: [],
  };

  for (const r of targets) {
    result.scanned++;
    if (opts.dryRun) {
      result.items.push({ id: r.id, status: "planned" });
      continue;
    }
    const item = await labelOne(deps, r);
    result.items.push(item);
    if (item.status === "labeled") result.labeled++;
    else if (item.status === "skipped") result.skipped++;
    else result.failed++;
  }
  return result;
}

async function labelOne(deps: SampleLabelerDeps, r: ReceiptRow): Promise<SampleLabelItemResult> {
  // 母集団は sample_role IS NULL だが、 並走した OCR や人手が先に付けていれば触らない
  const current = deps.receipts.find(r.id);
  if (!current || current.sample_role != null || current.sample_source === "manual") {
    return { id: r.id, status: "skipped" };
  }
  if (!current.image_path) return { id: r.id, status: "failed", error: "no image_path" };

  try {
    // Reject corrupted DB paths before embedding a local filename in an LLM prompt.
    const imagePath = deps.storage.resolve(current.image_path);
    const raw = await deps.runner(buildLabelOnlyPrompt(imagePath));
    const labels = normalizeLlmLabels(raw);
    if (!labels || !labels.sample) {
      deps.logger?.warn?.({ id: r.id }, "sample-label: LLM 応答が語彙外 (kind / sample 無し)");
      return { id: r.id, status: "failed", error: "invalid_labels" };
    }
    const applied = applyLlmLabels(deps.receipts, r.id, labels);
    if (!applied.applied) return { id: r.id, status: "skipped" };
    deps.logger?.info?.({ id: r.id, kind: labels.kind, role: labels.sample.role }, "sample-label: labeled");
    return { id: r.id, status: "labeled", kind: labels.kind, role: labels.sample.role };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.logger?.warn?.({ id: r.id, err: msg }, "sample-label: runner failed");
    return { id: r.id, status: "failed", error: msg };
  }
}
