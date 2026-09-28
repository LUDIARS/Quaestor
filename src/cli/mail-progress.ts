/** Session-owned read-only monitor. Never starts ingestion or reads message bodies. */
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MailProgressSchema, shouldReportMail, formatMailProgress, type MailProgress, type ReportCheckpoint } from "../services/mail-progress-report.js";
import { relayMailProgress } from "../services/mail-progress-relay.js";

async function main(): Promise<void> {
  const [base, requestId] = process.argv.slice(2);
  if (!base || !requestId || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw new Error("usage: mail-progress <loopback-base-url> <request-id>");
  const url = new URL(base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("loopback base URL required");
  }
  const port = Number(process.env.LICTOR_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LICTOR_PORT required");
  const sidecar = `http://127.0.0.1:${port}`;
  // Verify a current session without persisting or printing its identity.
  const identity = await getJson(`${sidecar}/v1/concordia/session`) as { session_id?: unknown };
  if (typeof identity.session_id !== "string") throw new Error("current Lictor session unavailable");
  const dir = resolve("app_data/mail-progress", requestId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, "monitor.lock");
  const lock = await open(lockPath, "wx");
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    let previous: ReportCheckpoint | null = null;
    try { previous = JSON.parse(await readFile(join(dir, "checkpoint.json"), "utf8")) as ReportCheckpoint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid reporting checkpoint"); }
    // Ambiguous delivery is not automatically resent after a process interruption.
    try { await readFile(join(dir, "delivery-pending.json")); throw new Error("previous delivery requires reconciliation"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    while (!controller.signal.aborted) {
      let progress: MailProgress;
      try { progress = MailProgressSchema.parse(await getJson(new URL("/v1/mail/crawler", url).href)); }
      catch {
        if (!previous || previous.status !== "unavailable" || Date.now() - previous.sentAt >= 600_000) {
          const checkpoint = { sentAt: Date.now(), status: "unavailable", error: "status_unavailable" };
          await relayMailProgress(sidecar, dir, "メール解析の状態を取得できません。30秒ごとに再確認しています。処理完了とは判定していません。", checkpoint);
          previous = checkpoint;
        }
        await sleep(30_000, undefined, { signal: controller.signal });
        continue;
      }
      if (progress.backfill.requestId !== requestId) {
        await relayMailProgress(sidecar, dir, "監視対象の解析リクエストが変更されたため、旧リクエストの定期報告を停止しました。", {
          sentAt: Date.now(), status: "replaced", error: null,
        });
        break;
      }
      if (shouldReportMail(progress, previous, Date.now())) {
        const checkpoint = { sentAt: Date.now(), status: progress.backfill.status, error: progress.lastError };
        await relayMailProgress(sidecar, dir, formatMailProgress(progress), checkpoint);
        previous = checkpoint;
        process.stdout.write(JSON.stringify({ event: "report_accepted", processed: progress.backfill.processed, status: progress.backfill.status }) + "\n");
      }
      if (progress.backfill.status !== "active") break;
      await sleep(30_000, undefined, { signal: controller.signal });
    }
  } finally {
    controller.abort(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await lock.close(); await unlink(lockPath);
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("progress endpoint unavailable");
  return response.json();
}

main().catch(() => { process.stderr.write("Mail progress monitor stopped; check endpoint or delivery checkpoint.\n"); process.exitCode = 1; });
