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

const log = pino({
  level: process.env.QUAESTOR_LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

const PORT = Number(process.env.QUAESTOR_PORT ?? 17400);
const HOST = process.env.QUAESTOR_HOST ?? "127.0.0.1";
const DB_PATH = resolve(process.env.QUAESTOR_DB ?? "app_data/quaestor.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const app = buildApp({ db });

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info({ host: HOST, port: info.port, dbPath: DB_PATH }, "Quaestor listening");
});

process.on("SIGINT", () => {
  log.info("SIGINT received, closing");
  db.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  log.info("SIGTERM received, closing");
  db.close();
  process.exit(0);
});
