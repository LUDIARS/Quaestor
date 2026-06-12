/**
 * Quaestor backend エントリポイント。 loopback (127.0.0.1:17400) のみで bind。
 *
 * 個人会計データを扱うため、 既定で外部公開しない。 LAN 共有や Tauri 同梱時にホストや port を上書き可。
 */

import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";
import { applyMigrations } from "./db/schema.js";
import { ReceiptsRepo } from "./db/receipts-repo.js";
import { ReceiptStorage } from "./services/receipt-storage.js";
import { AnthropicOcrClient } from "./services/ocr-client.js";
import { OcrWorker } from "./services/ocr-worker.js";
import { OcrSidecarSupervisor } from "./services/ocr-sidecar-supervisor.js";

const log = pino({
  level: process.env.QUAESTOR_LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

const PORT = Number(process.env.QUAESTOR_PORT ?? 17400);
const HOST = process.env.QUAESTOR_HOST ?? "127.0.0.1";
const DB_PATH = resolve(process.env.QUAESTOR_DB ?? "app_data/quaestor.db");

const RECEIPTS_ROOT = resolve(process.env.QUAESTOR_RECEIPTS_ROOT ?? "app_data/receipts");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const app = buildApp({ db, receiptsRoot: RECEIPTS_ROOT });

// OCR worker: ANTHROPIC_API_KEY ありかつ QUAESTOR_OCR_WORKER!=0 で起動
let ocrWorker: OcrWorker | null = null;
if (process.env.ANTHROPIC_API_KEY && process.env.QUAESTOR_OCR_WORKER !== "0") {
  try {
    applyMigrations(db); // buildApp が既にやってるが念のため
    const client = new AnthropicOcrClient();
    ocrWorker = new OcrWorker({
      receipts: new ReceiptsRepo(db),
      storage: new ReceiptStorage(RECEIPTS_ROOT),
      client,
      intervalMs: Number(process.env.QUAESTOR_OCR_INTERVAL_MS ?? "30000"),
      logger: log,
    });
    ocrWorker.start();
  } catch (e: unknown) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "ocr worker disabled (init failed)");
  }
}

// OCR sidecar (PaddleOCR) を同時起動。
//  - QUAESTOR_OCR_SIDECAR_MANAGE=0 で無効
//  - QUAESTOR_OCR_SIDECAR_URL (外部 sidecar) 指定時は本機を起動しない
let ocrSidecar: OcrSidecarSupervisor | null = null;
if (process.env.QUAESTOR_OCR_SIDECAR_MANAGE !== "0" && !process.env.QUAESTOR_OCR_SIDECAR_URL) {
  ocrSidecar = new OcrSidecarSupervisor({ logger: log });
  ocrSidecar.start();
}

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info(
    { host: HOST, port: info.port, dbPath: DB_PATH, ocrWorker: ocrWorker !== null },
    "Quaestor listening",
  );
});

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  ocrWorker?.stop();
  ocrSidecar?.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
