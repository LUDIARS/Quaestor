/**
 * Quaestor backend エントリポイント。 loopback (127.0.0.1:17400) のみで bind。
 *
 * 個人会計データを扱うため、 既定で外部公開しない。 LAN 共有や Tauri 同梱時にホストや port を上書き可。
 *
 * 設定は quaestor.config.json (単一 loader: app-config.ts、env は override のみ)。
 * シークレットは暗号化ストア (secret-store.ts) から起動時にプロセスメモリへ注入する。
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
import { loadAppConfig, sidecarUrlOf } from "./services/app-config.js";
import { SecretStore } from "./services/secret-store.js";

const config = loadAppConfig();

// シークレット (ANTHROPIC_API_KEY 等) を暗号化ストアから注入 (メモリのみ、平文ファイル無し)
const injectedSecrets = new SecretStore().injectIntoEnv();

const log = pino({
  level: config.server.logLevel,
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});
if (injectedSecrets.length > 0) {
  log.info({ names: injectedSecrets }, "secrets injected from encrypted store");
}

const DB_PATH = resolve(config.storage.dbPath);
const RECEIPTS_ROOT = resolve(config.storage.receiptsRoot);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const app = buildApp({
  db,
  receiptsRoot: RECEIPTS_ROOT,
  gaRoot: config.training.gaRoot,
  publicConfig: { ocrSidecarUrl: sidecarUrlOf(config) },
});

// OCR worker: ANTHROPIC_API_KEY あり (env or 暗号化ストア) かつ ocrWorker.enabled で起動
let ocrWorker: OcrWorker | null = null;
if (process.env.ANTHROPIC_API_KEY && config.ocrWorker.enabled) {
  try {
    applyMigrations(db); // buildApp が既にやってるが念のため
    const client = new AnthropicOcrClient();
    ocrWorker = new OcrWorker({
      receipts: new ReceiptsRepo(db),
      storage: new ReceiptStorage(RECEIPTS_ROOT),
      client,
      intervalMs: config.ocrWorker.intervalMs,
      logger: log,
    });
    ocrWorker.start();
  } catch (e: unknown) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "ocr worker disabled (init failed)");
  }
}

// OCR sidecar (PaddleOCR) を同時起動。
//  - ocrSidecar.manage=false で無効
//  - ocrSidecar.externalUrl (外部 sidecar) 指定時は本機を起動しない
let ocrSidecar: OcrSidecarSupervisor | null = null;
if (config.ocrSidecar.manage && !config.ocrSidecar.externalUrl) {
  ocrSidecar = new OcrSidecarSupervisor({
    host: config.ocrSidecar.host,
    port: config.ocrSidecar.port,
    python: config.ocrSidecar.python,
    lang: config.ocrSidecar.lang,
    logger: log,
  });
  ocrSidecar.start();
}

serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (info) => {
  log.info(
    { host: config.server.host, port: info.port, dbPath: DB_PATH, ocrWorker: ocrWorker !== null },
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
