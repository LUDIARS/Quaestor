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
import { ReconciliationsRepo } from "./db/reconciliations-repo.js";
import { InvoicesRepo } from "./db/invoices-repo.js";
import { FinancialStatementsRepo } from "./db/financial-statements-repo.js";
import { SecuritiesRepo } from "./db/securities-repo.js";
import { PayeeSecuritiesRepo } from "./db/payee-securities-repo.js";
import { StockQuotesRepo } from "./db/stock-quotes-repo.js";
import { ShareholderPerksRepo } from "./db/shareholder-perks-repo.js";
import { StatementProfilesRepo } from "./db/statement-profiles-repo.js";
import { ReceiptStorage } from "./services/receipt-storage.js";
import { TrainingDataset } from "./services/training-dataset.js";
import { OpusDiffEvaluator, type DiffEvaluator } from "./services/detection-diff-evaluator.js";
import { createOcrGaStore } from "./services/ocr-ga.js";
import { ocrGaRouter } from "./api/ocr-ga.js";
import type { OcrClient } from "./services/ocr-client.js";
import { AnthropicOcrClient } from "./services/ocr-client.js";
import { SmartImporter } from "./services/smart-import.js";
import { ClaudeSecurityMapper, type SecurityMapper } from "./services/security-mapper.js";
import { ClaudePerkClient, type PerkClient } from "./services/perk-client.js";
import { StooqStockClient, type StockClient } from "./services/stock-client.js";
import { InvestAdvisor } from "./services/invest-advisor.js";
import { transactionsRouter } from "./api/transactions.js";
import { importsRouter } from "./api/imports.js";
import { accountCodesRouter } from "./api/account-codes.js";
import { apportionmentRulesRouter } from "./api/apportionment-rules.js";
import { receiptsRouter } from "./api/receipts.js";
import { reconciliationsRouter } from "./api/reconciliations.js";
import { exportsRouter } from "./api/exports.js";
import { invoicesRouter } from "./api/invoices.js";
import { dashboardRouter } from "./api/dashboard.js";
import { financialStatementsRouter } from "./api/financial-statements.js";
import { investRouter } from "./api/invest.js";
import { statementProfilesRouter } from "./api/statement-profiles.js";

export interface AppDeps {
  db: Database.Database;
  /** 画像保存ルート。 既定 './app_data/receipts' */
  receiptsRoot?: string;
  /** OCR client。 省略時は ANTHROPIC_API_KEY があれば AnthropicOcrClient、 無ければ undefined */
  ocr?: OcrClient | "auto" | "disabled";
  /** 銘柄マッピング client。 省略時は ANTHROPIC_API_KEY があれば Claude、 無ければ undefined */
  securityMapper?: SecurityMapper | "auto" | "disabled";
  /** 優待取得 client。 省略時は ANTHROPIC_API_KEY があれば Claude、 無ければ undefined */
  perkClient?: PerkClient | "auto" | "disabled";
  /** 株価 client。 省略時は Stooq。 "disabled" で無効化 */
  stockClient?: StockClient | "auto" | "disabled";
}

export function buildApp(deps: AppDeps): Hono {
  applyMigrations(deps.db);
  const imports = new ImportsRepo(deps.db);
  const txs = new TransactionsRepo(deps.db);
  const accounts = new AccountCodesRepo(deps.db);
  const rules = new ApportionmentRulesRepo(deps.db);
  const receipts = new ReceiptsRepo(deps.db);
  const reconciliations = new ReconciliationsRepo(deps.db);
  const invoices = new InvoicesRepo(deps.db);
  const fs = new FinancialStatementsRepo(deps.db);
  const securities = new SecuritiesRepo(deps.db);
  const payeeSecurities = new PayeeSecuritiesRepo(deps.db);
  const stockQuotes = new StockQuotesRepo(deps.db);
  const perks = new ShareholderPerksRepo(deps.db);
  const statementProfiles = new StatementProfilesRepo(deps.db);
  const storage = new ReceiptStorage(deps.receiptsRoot ?? "app_data/receipts");
  const trainingDataset = new TrainingDataset("app_data/training/receipts", storage);
  // 差分の Opus 類推器。ANTHROPIC_API_KEY が無ければ undefined (差分は保存するが類推はしない)
  let diffEvaluator: DiffEvaluator | undefined;
  try { diffEvaluator = new OpusDiffEvaluator(); } catch { diffEvaluator = undefined; }
  // OCR パラメータの遺伝的最適化 (PaddleOCR 進化、待機中に web が評価して進化)
  const ocrGa = createOcrGaStore("app_data/training/ga");

  // 初回起動時の seed (account_codes が先、 apportionment_rules は account_codes に FK 依存)
  accounts.seedIfEmpty();
  rules.seedIfEmpty();

  const ocr = resolveOcr(deps.ocr);
  const ocrEnabled = !!ocr;
  // smart importer は OCR と同じ key を共有
  let smart: SmartImporter | undefined;
  if (ocrEnabled) {
    try { smart = new SmartImporter(); } catch { smart = undefined; }
  }

  // 投資/優待アドバイザの client 群 (Anthropic 系は OCR と同じ key、 株価は Stooq)
  const securityMapper = resolveMapper(deps.securityMapper);
  const perkClient = resolvePerkClient(deps.perkClient);
  const stockClient = resolveStock(deps.stockClient);
  const advisor = new InvestAdvisor({
    db: deps.db,
    securities,
    payeeSecurities,
    quotes: stockQuotes,
    perks,
    mapper: securityMapper,
    stock: stockClient,
    perkClient,
  });

  const app = new Hono();

  app.get("/health", (c) => c.json({
    ok: true,
    service: "quaestor",
    version: "1.0.0",
    ocr_enabled: ocrEnabled,
    invest_enabled: { mapper: !!securityMapper, stock: !!stockClient, perks: !!perkClient },
  }));

  app.route("/v1/transactions", transactionsRouter({ txs, db: deps.db }));
  app.route("/v1/imports", importsRouter({ imports, txs, smart, profiles: statementProfiles }));
  app.route("/v1/account-codes", accountCodesRouter({ repo: accounts }));
  app.route("/v1/apportionment-rules", apportionmentRulesRouter({ repo: rules }));
  app.route("/v1/receipts", receiptsRouter({ repo: receipts, storage, ocr, dataset: trainingDataset, diffEvaluator }));
  app.route("/v1/ocr-ga", ocrGaRouter({ ga: ocrGa }));
  app.route("/v1/reconciliations", reconciliationsRouter({ db: deps.db, repo: reconciliations, receipts }));
  app.route("/v1/exports", exportsRouter({ db: deps.db, rules, accounts }));
  app.route("/v1/invoices", invoicesRouter({ repo: invoices }));
  app.route("/v1/dashboard", dashboardRouter({ db: deps.db }));
  app.route("/v1/financial-statement", financialStatementsRouter({ repo: fs }));
  app.route("/v1/invest", investRouter({ advisor, securities, payeeSecurities }));
  app.route("/v1/statement-profiles", statementProfilesRouter({ repo: statementProfiles }));

  return app;
}

function resolveOcr(opt: OcrClient | "auto" | "disabled" | undefined): OcrClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;     // 明示注入
  // "auto" or undefined: env を見る
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    return new AnthropicOcrClient();
  } catch {
    return undefined;
  }
}

function resolveMapper(opt: SecurityMapper | "auto" | "disabled" | undefined): SecurityMapper | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    return new ClaudeSecurityMapper();
  } catch {
    return undefined;
  }
}

function resolvePerkClient(opt: PerkClient | "auto" | "disabled" | undefined): PerkClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    return new ClaudePerkClient();
  } catch {
    return undefined;
  }
}

function resolveStock(opt: StockClient | "auto" | "disabled" | undefined): StockClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  // 株価は鍵不要。 既定で Stooq を有効化する
  try {
    return new StooqStockClient();
  } catch {
    return undefined;
  }
}
