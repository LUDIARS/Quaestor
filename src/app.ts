/**
 * Hono アプリ組み立て。 server.ts と test の双方から呼ぶ。
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { applyMigrations } from "./db/schema.js";
import { ImportsRepo } from "./db/imports-repo.js";
import { TransactionsRepo } from "./db/transactions-repo.js";
import { transactionsRouter } from "./api/transactions.js";
import { importsRouter } from "./api/imports.js";

export interface AppDeps {
  db: Database.Database;
}

export function buildApp(deps: AppDeps): Hono {
  applyMigrations(deps.db);
  const imports = new ImportsRepo(deps.db);
  const txs = new TransactionsRepo(deps.db);

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "quaestor", version: "0.1.0" }));

  app.route("/v1/transactions", transactionsRouter({ txs }));
  app.route("/v1/imports", importsRouter({ imports, txs }));

  return app;
}
