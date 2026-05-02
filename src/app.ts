/**
 * Hono アプリ組み立て。 server.ts と test の双方から呼ぶ。
 */

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { applyMigrations } from "./db/schema.js";
import { ImportsRepo } from "./db/imports-repo.js";
import { TransactionsRepo } from "./db/transactions-repo.js";
import { AccountCodesRepo } from "./db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "./db/apportionment-rules-repo.js";
import { ReceiptsRepo } from "./db/receipts-repo.js";
import { ReceiptStorage } from "./services/receipt-storage.js";
import { transactionsRouter } from "./api/transactions.js";
import { importsRouter } from "./api/imports.js";
import { accountCodesRouter } from "./api/account-codes.js";
import { apportionmentRulesRouter } from "./api/apportionment-rules.js";
import { receiptsRouter } from "./api/receipts.js";

export interface AppDeps {
  db: Database.Database;
  /** 画像保存ルート。 既定 './app_data/receipts' */
  receiptsRoot?: string;
}

export function buildApp(deps: AppDeps): Hono {
  applyMigrations(deps.db);
  const imports = new ImportsRepo(deps.db);
  const txs = new TransactionsRepo(deps.db);
  const accounts = new AccountCodesRepo(deps.db);
  const rules = new ApportionmentRulesRepo(deps.db);
  const receipts = new ReceiptsRepo(deps.db);
  const storage = new ReceiptStorage(deps.receiptsRoot ?? "app_data/receipts");

  // 初回起動時の seed (account_codes が先、 apportionment_rules は account_codes に FK 依存)
  accounts.seedIfEmpty();
  rules.seedIfEmpty();

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "quaestor", version: "0.3.0" }));

  app.route("/v1/transactions", transactionsRouter({ txs }));
  app.route("/v1/imports", importsRouter({ imports, txs }));
  app.route("/v1/account-codes", accountCodesRouter({ repo: accounts }));
  app.route("/v1/apportionment-rules", apportionmentRulesRouter({ repo: rules }));
  app.route("/v1/receipts", receiptsRouter({ repo: receipts, storage }));

  return app;
}
