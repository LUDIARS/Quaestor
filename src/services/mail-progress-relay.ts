import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acceptedProgressMessageId } from "./mail-progress-receipt.js";
import type { ReportCheckpoint } from "./mail-progress-report.js";

/** @implements SPEC-MAIL-CRAWLER-006 */
export async function relayMailProgress(sidecar: string, dir: string, caption: string, checkpoint: ReportCheckpoint): Promise<void> {
  const file = join(dir, "progress.txt");
  // Exclusive creation preserves ambiguous attempts and prevents duplicate resends.
  await writeFile(join(dir, "delivery-pending.json"), JSON.stringify({ attemptedAt: Date.now() }), { encoding: "utf8", flag: "wx" });
  await writeFile(file, caption + "\n", "utf8");
  const response = await fetch(`${sidecar}/v1/internal/send-file`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: [file], caption }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("progress delivery not accepted");
  const messageId = acceptedProgressMessageId(await response.json());
  if (messageId === null) throw new Error("progress acceptance ID unavailable; reconciliation required");
  // This is Cc API acceptance, not proof of Discord delivery. Never persist session identity.
  await writeFile(join(dir, "receipt.json"), JSON.stringify({ acceptedAt: Date.now(), messageId }), "utf8");
  await writeFile(join(dir, "checkpoint.json"), JSON.stringify(checkpoint), "utf8");
  await unlink(join(dir, "delivery-pending.json"));
}
