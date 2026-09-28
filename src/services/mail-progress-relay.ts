import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ReportCheckpoint } from "./mail-progress-report.js";

/** @implements SPEC-MAIL-CRAWLER-006 */
export async function relayMailProgress(sidecar: string, dir: string, caption: string, checkpoint: ReportCheckpoint): Promise<void> {
  const file = join(dir, "progress.txt");
  await writeFile(file, caption + "\n", "utf8");
  await writeFile(join(dir, "delivery-pending.json"), JSON.stringify({ attemptedAt: Date.now() }), "utf8");
  const response = await fetch(`${sidecar}/v1/internal/send-file`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: [file], caption }), signal: AbortSignal.timeout(20_000),
  });
  const receipt = await response.json() as { ok?: boolean; relayed?: number; message?: { id?: unknown } };
  if (!response.ok || !receipt.ok || receipt.relayed !== 1) throw new Error("progress delivery not accepted");
  // Do not persist session identity; receipt identifies only the accepted message.
  await writeFile(join(dir, "receipt.json"), JSON.stringify({ acceptedAt: Date.now(), messageId: receipt.message?.id ?? null }), "utf8");
  await writeFile(join(dir, "checkpoint.json"), JSON.stringify(checkpoint), "utf8");
  await unlink(join(dir, "delivery-pending.json"));
}
