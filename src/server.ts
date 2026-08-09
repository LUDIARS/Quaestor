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
import { NotificationWorker } from "./services/notification-worker.js";
import { SubsidyCrawlWorker } from "./services/subsidy-crawl-worker.js";
import { SubsidiesRepo } from "./db/subsidies-repo.js";
import { JGrantsCrawler, MirasapoPlusCrawler, CompositeCrawler } from "./services/subsidy-crawler.js";
import { runtimeVersionFromEnvironment } from "./services/runtime-version.js";

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
  invoiceShare: config.invoiceShare,
  // 本番プロセスだけが実 ADC を読む Gmail クライアントを持つ。 ADC 未設定なら 503 not_configured。
  invoiceEmailNotifier: "auto",
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

// 補助金定期クロールワーカー: subsidyCrawl.enabled の時のみ起動
let subsidyCrawlWorker: SubsidyCrawlWorker | null = null;
if (config.subsidyCrawl.enabled) {
  subsidyCrawlWorker = new SubsidyCrawlWorker({
    crawler: new CompositeCrawler([new JGrantsCrawler(), new MirasapoPlusCrawler()]),
    repo: new SubsidiesRepo(db),
    keywords: config.subsidyCrawl.keywords,
    perKeywordLimit: config.subsidyCrawl.perKeywordLimit,
    intervalMs: config.subsidyCrawl.intervalMs,
    logger: log,
  });
  subsidyCrawlWorker.start();
  log.info({ intervalMs: config.subsidyCrawl.intervalMs, keywords: config.subsidyCrawl.keywords }, "subsidy crawl worker started");
}

// 定期 Discord 通知ワーカー: notifications.enabled かつ webhook URL がある時のみ起動
let notificationWorker: NotificationWorker | null = null;

/** @implements SPEC-RUNTIME-VERSION-001 (spec/feature/runtime-version.md) */
serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (info) => {
  log.info(
    {
      host: config.server.host,
      port: info.port,
      dbPath: DB_PATH,
      ocrWorker: ocrWorker !== null,
      version: runtimeVersionFromEnvironment(),
    },
    "Quaestor listening",
  );
  const hasWebhook = !!(process.env.QUAESTOR_DISCORD_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL);
  if (config.notifications.enabled && hasWebhook) {
    notificationWorker = new NotificationWorker({
      baseUrl: `http://${config.server.host}:${info.port}`,
      intervalMs: config.notifications.intervalMs,
      invest: config.notifications.invest,
      portfolio: config.notifications.portfolio,
      subsidies: config.notifications.subsidies,
      logger: log,
    });
    notificationWorker.start();
    log.info({ intervalMs: config.notifications.intervalMs }, "notification worker started");
  } else if (config.notifications.enabled && !hasWebhook) {
    log.warn("notifications.enabled だが QUAESTOR_DISCORD_WEBHOOK_URL 未設定のため通知ワーカーは起動しません");
  }
});

const shutdown = (signal: string) => {
  log.info({ signal }, "shutting down");
  ocrWorker?.stop();
  ocrSidecar?.stop();
  notificationWorker?.stop();
  subsidyCrawlWorker?.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
