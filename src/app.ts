/**
 * Hono アプリ組み立て。 server.ts と test の双方から呼ぶ。
 */

import { Hono } from "hono";
import { runtimeVersionFromEnvironment } from "./services/runtime-version.js";
import type Database from "better-sqlite3";
import { applyMigrations } from "./db/schema.js";
import { ImportsRepo } from "./db/imports-repo.js";
import { TransactionsRepo } from "./db/transactions-repo.js";
import { AccountCodesRepo } from "./db/account-codes-repo.js";
import { ApportionmentRulesRepo } from "./db/apportionment-rules-repo.js";
import { ReceiptsRepo } from "./db/receipts-repo.js";
import { ReconciliationsRepo } from "./db/reconciliations-repo.js";
import { InvoicesRepo } from "./db/invoices-repo.js";
import { InvoiceShareRepo } from "./db/invoice-share-repo.js";
import { InvoiceDeliveryContactsRepo } from "./db/invoice-delivery-contacts-repo.js";
import { InvoiceShareAcceptanceRepo } from "./db/invoice-share-acceptance-repo.js";
import { InvoiceShareAccessRepo } from "./db/invoice-share-access-repo.js";
import { InvoiceShareChallengeRepo } from "./db/invoice-share-challenge-repo.js";
import { InvoiceShareEnrollmentGrantRepo } from "./db/invoice-share-enrollment-grant-repo.js";
import { InvoiceShareWebAuthnChallengeRepo } from "./db/invoice-share-webauthn-challenge-repo.js";
import { InvoiceRecipientPasskeyRepo } from "./db/invoice-recipient-passkey-repo.js";
import { InvoiceShareDeliveryRepo } from "./db/invoice-share-delivery-repo.js";
import { FinancialStatementsRepo } from "./db/financial-statements-repo.js";
import { SecuritiesRepo } from "./db/securities-repo.js";
import { PayeeSecuritiesRepo } from "./db/payee-securities-repo.js";
import { StockQuotesRepo } from "./db/stock-quotes-repo.js";
import { ShareholderPerksRepo } from "./db/shareholder-perks-repo.js";
import { StatementProfilesRepo } from "./db/statement-profiles-repo.js";
import { BusinessPlansRepo } from "./db/business-plans-repo.js";
import { HoldingsRepo } from "./db/holdings-repo.js";
import { ContributionsRepo } from "./db/contributions-repo.js";
import { HoldingValuationsRepo } from "./db/holding-valuations-repo.js";
import { HoldingDividendsRepo } from "./db/holding-dividends-repo.js";
import { DividendCandidatesRepo } from "./db/dividend-candidates-repo.js";
import { ReceiptStorage } from "./services/receipt-storage.js";
import { TrainingDataset } from "./services/training-dataset.js";
import { OpusDiffEvaluator, type DiffEvaluator } from "./services/detection-diff-evaluator.js";
import { createOcrGaStore } from "./services/ocr-ga.js";
import { ocrGaRouter } from "./api/ocr-ga.js";
import type { OcrClient } from "./services/ocr-client.js";
import { AnthropicOcrClient } from "./services/ocr-client.js";
import { SmartImporter } from "./services/smart-import.js";
import { ReceiptIntake } from "./services/receipt-intake.js";
import { ClaudeSecurityMapper, type SecurityMapper } from "./services/security-mapper.js";
import { ClaudePerkClient, type PerkClient } from "./services/perk-client.js";
import { YahooFinanceStockClient, type StockClient } from "./services/stock-client.js";
import { InvestAdvisor } from "./services/invest-advisor.js";
import { ClaudeDividendClient, type DividendClient } from "./services/dividend-client.js";
import { PortfolioService } from "./services/portfolio-service.js";
import { transactionsRouter } from "./api/transactions.js";
import { importsRouter } from "./api/imports.js";
import { accountCodesRouter } from "./api/account-codes.js";
import { apportionmentRulesRouter } from "./api/apportionment-rules.js";
import { receiptsRouter } from "./api/receipts.js";
import { reconciliationsRouter } from "./api/reconciliations.js";
import { exportsRouter } from "./api/exports.js";
import { invoicesRouter } from "./api/invoices.js";
import { invoiceSharesRouter } from "./api/invoice-shares.js";
import { invoiceSharePasskeysRouter } from "./api/invoice-share-passkeys.js";
import { invoiceSharePublicGuard } from "./api/invoice-share-public-guard.js";
import { dashboardRouter } from "./api/dashboard.js";
import { financialStatementsRouter } from "./api/financial-statements.js";
import { investRouter } from "./api/invest.js";
import { statementProfilesRouter } from "./api/statement-profiles.js";
import { businessPlansRouter } from "./api/business-plans.js";
import { portfolioRouter } from "./api/portfolio.js";
import type { PlanReviewer } from "./services/plan-reviewer.js";
import { ClaudeCliPlanReviewer, detectClaudeCli } from "./services/plan-reviewer-cli.js";
import { SubsidiesRepo } from "./db/subsidies-repo.js";
import { subsidiesRouter } from "./api/subsidies.js";
import { resolveSubsidyMatcher, type SubsidyMatcher } from "./services/subsidy-matcher.js";
import { JGrantsCrawler, MirasapoPlusCrawler, CompositeCrawler, type SubsidyCrawler } from "./services/subsidy-crawler.js";
import { resolveDiscordNotifier, type DiscordNotifier } from "./services/discord-notifier.js";
import { NotificationState } from "./services/notification-state.js";
import { NotificationService } from "./services/notification-service.js";
import { notificationsRouter } from "./api/notifications.js";
import { suggestSubsidies } from "./services/subsidy-advisor.js";
import { ClaudeAllocationAdvisor, type AllocationAdvisor } from "./services/allocation-advisor.js";
import { AllocationAdviceStore } from "./services/allocation-advice-store.js";
import { detectClaudeCli as detectCli } from "./services/claude-cli.js";
import { ApportionmentAdvisor, ClaudeCliApportionmentLlm, type ApportionmentLlm } from "./services/apportionment-advisor.js";
import { apportionmentAdvisorRouter } from "./api/apportionment-advisor.js";
import { configRouter } from "./api/config.js";
import { memoriaIntegrationRouter } from "./api/memoria-integration.js";
import { InvoiceShareService } from "./services/invoice-share-service.js";
import { InvoiceShareRateLimiter } from "./services/invoice-share-rate-limiter.js";
import { invoiceSlackDeliveriesRouter } from "./api/invoice-slack-deliveries.js";
import { invoiceEmailDeliveriesRouter } from "./api/invoice-email-deliveries.js";
import { invoiceDeliveryContactsRouter } from "./api/invoice-delivery-contacts.js";
import { InvoiceSlackDeliveryService } from "./services/invoice-slack-delivery.js";
import { InvoiceShareAcceptanceService } from "./services/invoice-share-acceptance-service.js";
import { InvoiceSharePasskeyAcceptanceService } from "./services/invoice-share-passkey-acceptance-service.js";
import { InvoicePasskeyService } from "./services/invoice-passkey-service.js";
import { EvidenceTimestampService, startEvidenceTimestampRetryJob } from "./services/evidence-timestamp-service.js";
import { Rfc3161TimestampClient } from "./services/rfc3161-timestamp-client.js";
import { InvoiceAcceptanceEvidenceMailer } from "./services/invoice-acceptance-evidence-mailer.js";
import {
  locationReferenceFromEnvironment,
  type InvoiceAcceptanceLocationReference,
} from "./services/invoice-acceptance-location-signal.js";
import { InvoiceShareAccessService } from "./services/invoice-share-access-service.js";
import { InvoiceEmailDeliveryService } from "./services/invoice-email-delivery.js";
import type { InvoiceEmailNotifier } from "./services/invoice-email-notifier.js";
import { SesEmailClient, sesCredentialsFromEnv } from "./services/ses-email-client.js";
import {
  resolveSlackInvoiceTarget,
  SlackWebApiClient,
  type SlackInvoiceNotifier,
  type SlackInvoiceTarget,
} from "./services/slack-web-api-client.js";

export interface AppLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
}

export interface AppDeps {
  db: Database.Database;
  /** 画像保存ルート。 既定 './app_data/receipts' */
  receiptsRoot?: string;
  /** OCR client。 省略時は ANTHROPIC_API_KEY があれば AnthropicOcrClient、 無ければ undefined */
  ocr?: OcrClient | "auto" | "disabled";
  /** 銘柄マッピング client。 省略時は claude CLI があれば Claude、 無ければ undefined */
  securityMapper?: SecurityMapper | "auto" | "disabled";
  /** 優待取得 client。 省略時は claude CLI があれば Claude、 無ければ undefined */
  perkClient?: PerkClient | "auto" | "disabled";
  /** 株価 client。 省略時は Stooq。 "disabled" で無効化 */
  stockClient?: StockClient | "auto" | "disabled";
  /** 配当データ client。 省略時は claude CLI があれば Claude、 無ければ undefined */
  dividendClient?: DividendClient | "auto" | "disabled";
  /** 事業計画の定性レビューア。 省略時は claude CLI があれば有効、 無ければ undefined */
  planReviewer?: PlanReviewer | "auto" | "disabled";
  /** 補助金マッチャ。 省略時は claude CLI があれば有効、 無ければ undefined */
  subsidyMatcher?: SubsidyMatcher | "auto" | "disabled";
  /** 補助金クローラ。 省略時は jGrants (鍵不要)。 "disabled" で無効化 */
  subsidyCrawler?: SubsidyCrawler | "auto" | "disabled";
  /** Discord 通知。 省略時は QUAESTOR_DISCORD_WEBHOOK_URL があれば有効、 無ければ undefined */
  discordNotifier?: DiscordNotifier | "auto" | "disabled";
  /** 定期通知の dedup state ファイル。 既定 'app_data/notifications-state.json' */
  notifyStatePath?: string;
  /** 資産配分アドバイザ。 省略時は claude CLI があれば有効、 無ければ undefined */
  allocationAdvisor?: AllocationAdvisor | "auto" | "disabled";
  /** 未知 payee の科目学習 LLM。 省略時は claude CLI があれば有効、 無ければ undefined */
  apportionmentLlm?: ApportionmentLlm | "auto" | "disabled";
  /** 配分アドバイスのキャッシュファイル。 既定 'app_data/allocation-advice.json' */
  allocationAdvicePath?: string;
  /** OCR-GA 永続ルート。 既定 'app_data/training/ga' */
  gaRoot?: string;
  /** web へ公開する非シークレット設定 (/v1/config)。 省略時は既定値 */
  publicConfig?: { ocrSidecarUrl: string };
  /**
   * 請求書の公開マジックリンク設定 (app-config.ts の invoiceShare)。
   * publicUrl 未設定ならリンク発行は 503 で失敗する (loopback へ fallback しない)。
   */
  invoiceShare?: {
    publicUrl?: string | null;
    roots?: string[];
    email?: { region?: string | null; fromAddress?: string | null; configurationSet?: string | null };
    timestampAuthority?: { url?: string; enabled?: boolean };
  };
  /**
   * 合意証跡への RFC 3161 タイムスタンプ。 `"auto"` (本番エントリポイントのみ) で
   * `invoiceShare.timestampAuthority` の設定どおり実 TSA を叩き、 再試行ジョブも張る。
   * `"auto"` では timer 解放用の `registerCleanup` も必須。省略時は無効
   * (テストがネットワークへ出ない)。 テストはクライアントを注入する。
   */
  evidenceTimestamp?: Rfc3161TimestampClient | "auto" | "disabled";
  /** Slack 請求書通知。 bot token は暗号化ストアから env 注入し、テスト時のみ明示 DI する。 */
  slackInvoiceNotifier?: SlackInvoiceNotifier | "auto" | "disabled";
  /** 既定の Slack グループ DM。未指定時は暗号化ストアへ注入された env から解決する。 */
  slackInvoiceTarget?: SlackInvoiceTarget;
  /**
   * Amazon SES 送信。 `"auto"` を明示したときだけ暗号化ストア由来の送信専用キーで実クライアントを
   * 組み立てる。 slackInvoiceNotifier と違い省略時は無効で、
   * 未注入のテストや組み込み用途が実アカウントのメール送信へ到達しないようにする。
   */
  invoiceEmailNotifier?: InvoiceEmailNotifier | "auto" | "disabled";
  /** テスト専用。通常運用で送信者へ bearer URL を返す API は登録しない。 */
  unsafeExposeInvoiceShareUrl?: boolean;
  /**
   * 合意地点・アクセス地点と比較する送信者側の基準地点。
   * 座標は暗号化ストア経由の env を既定とする。
   */
  invoiceAcceptanceLocationReference?: InvoiceAcceptanceLocationReference | null;
  /**
   * OCR 完了時にレシートを自動投入し、 取引と自動突合するか。 既定 true。
   * false で従来の手動投入 (Scan 画面の「投入」ボタン) のみに戻る。
   */
  autoIntake?: boolean;
  /** best-effort 外部処理の失敗を、秘密・個人データを含めず観測可能にする。 */
  logger?: AppLogger;
  /** buildApp が所有する timer 等を、プロセス終了時に解放するための登録先。 */
  registerCleanup?: (cleanup: () => void) => void;
}

/** @implements SPEC-RUNTIME-VERSION-001 (spec/feature/runtime-version.md) */
export function buildApp(deps: AppDeps): Hono {
  applyMigrations(deps.db);
  const imports = new ImportsRepo(deps.db);
  const txs = new TransactionsRepo(deps.db);
  const accounts = new AccountCodesRepo(deps.db);
  const rules = new ApportionmentRulesRepo(deps.db);
  const receipts = new ReceiptsRepo(deps.db);
  const reconciliations = new ReconciliationsRepo(deps.db);
  // OCR 完了 → 投入 → 突合 を人手なしで通す。 取引取込側からも同じ突合 sweep を呼ぶ。
  const receiptIntake = new ReceiptIntake({
    db: deps.db,
    receipts,
    reconciliations,
    enabled: deps.autoIntake ?? true,
    logger: deps.logger ? { warn: (f, m) => deps.logger?.warn(f as Record<string, unknown>, m as string | undefined) } : undefined,
  });
  const invoices = new InvoicesRepo(deps.db);
  const invoiceShares = new InvoiceShareRepo(deps.db);
  const invoiceDeliveryContacts = new InvoiceDeliveryContactsRepo(deps.db);
  const invoiceShareAcceptances = new InvoiceShareAcceptanceRepo(deps.db);
  const invoiceShareAccesses = new InvoiceShareAccessRepo(deps.db);
  const invoiceShareChallenges = new InvoiceShareChallengeRepo(deps.db);
  const invoiceShareEnrollmentGrants = new InvoiceShareEnrollmentGrantRepo(deps.db);
  const invoiceShareWebAuthnChallenges = new InvoiceShareWebAuthnChallengeRepo(deps.db);
  const invoiceRecipientPasskeys = new InvoiceRecipientPasskeyRepo(deps.db);
  const invoiceShareDeliveries = new InvoiceShareDeliveryRepo(deps.db);
  const fs = new FinancialStatementsRepo(deps.db);
  const securities = new SecuritiesRepo(deps.db);
  const payeeSecurities = new PayeeSecuritiesRepo(deps.db);
  const stockQuotes = new StockQuotesRepo(deps.db);
  const perks = new ShareholderPerksRepo(deps.db);
  const statementProfiles = new StatementProfilesRepo(deps.db);
  const businessPlans = new BusinessPlansRepo(deps.db);
  const subsidies = new SubsidiesRepo(deps.db);
  const holdings = new HoldingsRepo(deps.db);
  const contributions = new ContributionsRepo(deps.db);
  const holdingValuations = new HoldingValuationsRepo(deps.db);
  const holdingDividends = new HoldingDividendsRepo(deps.db);
  const dividendCandidates = new DividendCandidatesRepo(deps.db);
  const storage = new ReceiptStorage(deps.receiptsRoot ?? "app_data/receipts");
  const trainingDataset = new TrainingDataset("app_data/training/receipts", storage);
  // 差分の LLM 類推器。claude CLI が使えない場合は undefined (差分は保存するが類推はしない)
  const diffEvaluator: DiffEvaluator | undefined = detectCli() ? new OpusDiffEvaluator() : undefined;
  // OCR パラメータの遺伝的最適化 (PaddleOCR 進化、待機中に web が評価して進化)
  const ocrGa = createOcrGaStore(deps.gaRoot ?? "app_data/training/ga");

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
  const dividendClient = resolveDividendClient(deps.dividendClient);
  const planReviewer = resolvePlanReviewer(deps.planReviewer);
  const subsidyMatcher = resolveSubsidyMatcher(deps.subsidyMatcher);
  const subsidyCrawler = resolveSubsidyCrawler(deps.subsidyCrawler);
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
  // 積立ポートフォリオ / 配当アドバイザ (株価=Stooq 共有、 配当データ=Claude)
  const portfolio = new PortfolioService({
    holdings,
    contributions,
    valuations: holdingValuations,
    dividends: holdingDividends,
    dividendCandidates,
    securities,
    quotes: stockQuotes,
    stock: stockClient,
    dividendClient,
  });

  // 未知 payee の科目学習 (成長型ブラックボックス @ludiars/blackbox)
  const apportionmentLlm: ApportionmentLlm | undefined =
    deps.apportionmentLlm === "disabled" ? undefined
    : deps.apportionmentLlm && deps.apportionmentLlm !== "auto" ? deps.apportionmentLlm
    : detectCli() ? new ClaudeCliApportionmentLlm(accounts) : undefined;
  const apportionmentAdvisor = new ApportionmentAdvisor({
    db: deps.db, rules, accounts, llm: apportionmentLlm,
  });

  // Discord 通知 (送信専用 webhook)。 アドバイザー出力を整形して push する
  const notifier = resolveDiscordNotifier(deps.discordNotifier);
  const notificationState = new NotificationState(deps.notifyStatePath ?? "app_data/notifications-state.json");
  const notificationService = new NotificationService({
    notifier,
    state: notificationState,
    investSuggestions: () => advisor.suggestions(),
    dividendCandidates: () => portfolio.dividendCandidates(),
    subsidySuggest: async (planId) => {
      const planName = businessPlans.find(planId)?.name ?? planId;
      if (!subsidyCrawler || !subsidyMatcher) return { planName, suggestions: [] };
      const { suggestions } = await suggestSubsidies(
        { plans: businessPlans, repo: subsidies, crawler: subsidyCrawler, matcher: subsidyMatcher },
        planId,
      );
      return { planName, suggestions };
    },
  });

  const app = new Hono();
  const invoiceShareService = new InvoiceShareService({
    invoices,
    shares: invoiceShares,
    publicBaseUrl: deps.invoiceShare?.publicUrl ?? undefined,
    allowedRoots: deps.invoiceShare?.roots?.length ? deps.invoiceShare.roots : undefined,
    contacts: invoiceDeliveryContacts,
  });
  const invoiceEmailNotifier = resolveInvoiceEmailNotifier(deps.invoiceEmailNotifier, deps.invoiceShare?.email);
  const invoiceShareLocationReference = deps.invoiceAcceptanceLocationReference === undefined
    ? locationReferenceFromEnvironment()
    : deps.invoiceAcceptanceLocationReference;
  const invoiceShareAcceptanceService = new InvoiceShareAcceptanceService({
    shares: invoiceShareService,
    acceptances: invoiceShareAcceptances,
    challenges: invoiceShareChallenges,
    grants: invoiceShareEnrollmentGrants,
    notifier: invoiceEmailNotifier,
  });
  const evidenceTimestampService = new EvidenceTimestampService({
    acceptances: invoiceShareAcceptances,
    client: resolveEvidenceTimestampClient(deps.evidenceTimestamp, deps.invoiceShare?.timestampAuthority),
    onError: (acceptanceId, error) => deps.logger?.warn(
      { event: "invoice_evidence_timestamp_failed", acceptanceId, errorCode: operationalErrorCode(error) },
      "invoice evidence timestamp failed",
    ),
  });
  if (deps.evidenceTimestamp === "auto") {
    if (!deps.registerCleanup) throw new Error("registerCleanup is required when evidenceTimestamp is auto");
    deps.registerCleanup(startEvidenceTimestampRetryJob(evidenceTimestampService));
  }
  const invoiceSharePasskeyAcceptanceService = new InvoiceSharePasskeyAcceptanceService({
    shares: invoiceShareService,
    acceptances: invoiceShareAcceptances,
    passkeys: invoiceRecipientPasskeys,
    challenges: invoiceShareWebAuthnChallenges,
    otpGate: invoiceShareAcceptanceService,
    webauthn: new InvoicePasskeyService({ publicUrl: deps.invoiceShare?.publicUrl ?? undefined }),
    timestamps: evidenceTimestampService,
    evidenceMailer: new InvoiceAcceptanceEvidenceMailer({
      notifier: invoiceEmailNotifier,
      onError: (shareId, error) => deps.logger?.warn(
        { event: "invoice_evidence_mail_failed", shareId, errorCode: operationalErrorCode(error) },
        "invoice evidence mail failed",
      ),
    }),
    locationReference: invoiceShareLocationReference,
    publicUrl: deps.invoiceShare?.publicUrl ?? undefined,
  });
  const invoiceShareAccessService = new InvoiceShareAccessService({
    accesses: invoiceShareAccesses,
    locationReference: invoiceShareLocationReference,
  });
  const slackInvoiceNotifier = resolveSlackNotifier(deps.slackInvoiceNotifier);
  const invoiceSlackDeliveryService = new InvoiceSlackDeliveryService({
    invoices,
    shares: invoiceShareService,
    notifier: slackInvoiceNotifier,
    defaultTarget: deps.slackInvoiceTarget ?? resolveSlackInvoiceTarget(),
  });
  const invoiceEmailDeliveryService = new InvoiceEmailDeliveryService({
    invoices,
    shares: invoiceShareService,
    deliveries: invoiceShareDeliveries,
    notifier: invoiceEmailNotifier,
  });

  app.get("/health", (c) => c.json({
    ok: true,
    service: "quaestor",
    version: runtimeVersionFromEnvironment(),
    ocr_enabled: ocrEnabled,
    invest_enabled: { mapper: !!securityMapper, stock: !!stockClient, perks: !!perkClient },
    portfolio_enabled: { stock: !!stockClient, dividends: !!dividendClient },
  }));

  // web へ公開する非シークレット設定 (env 非依存化: web は import.meta.env を見ない)
  app.get("/v1/config", (c) => c.json({
    ocrSidecarUrl: deps.publicConfig?.ocrSidecarUrl ?? "http://127.0.0.1:17350",
  }));

  app.route("/v1/transactions", transactionsRouter({ txs, db: deps.db }));
  app.route("/v1/imports", importsRouter({ imports, txs, smart, profiles: statementProfiles, intake: receiptIntake }));
  app.route("/v1/account-codes", accountCodesRouter({ repo: accounts }));
  app.route("/v1/apportionment-rules", apportionmentRulesRouter({ repo: rules }));
  app.route("/v1/apportionment-advisor", apportionmentAdvisorRouter({ advisor: apportionmentAdvisor }));
  app.route("/v1/receipts", receiptsRouter({ repo: receipts, storage, ocr, dataset: trainingDataset, diffEvaluator, intake: receiptIntake }));
  app.route("/v1/ocr-ga", ocrGaRouter({ ga: ocrGa }));
  app.route("/v1/reconciliations", reconciliationsRouter({ db: deps.db, repo: reconciliations, receipts }));
  app.route("/v1/exports", exportsRouter({ db: deps.db, rules, accounts }));
  // 公開マジックリンク配下のレート制限と応答ヘッダーは、 複数ルータにまたがるためここで 1 回だけ掛ける。
  app.use("/v1/invoices/share/*", invoiceSharePublicGuard(new InvoiceShareRateLimiter()));
  app.route("/v1/invoices", invoiceSharePasskeysRouter({ service: invoiceSharePasskeyAcceptanceService }));
  app.route("/v1/invoices", invoiceSharesRouter({
    service: invoiceShareService,
    acceptances: invoiceShareAcceptanceService,
    passkeyAcceptances: invoiceSharePasskeyAcceptanceService,
    accesses: invoiceShareAccessService,
    allowUnsafeIssueApi: deps.unsafeExposeInvoiceShareUrl === true,
  }));
  app.route("/v1/invoices", invoiceSlackDeliveriesRouter({ service: invoiceSlackDeliveryService }));
  app.route("/v1/invoices", invoiceEmailDeliveriesRouter({ service: invoiceEmailDeliveryService }));
  app.route("/v1/invoices", invoicesRouter({ repo: invoices }));
  app.route("/v1/invoice-delivery-contacts", invoiceDeliveryContactsRouter({
    repo: invoiceDeliveryContacts,
    passkeys: invoiceRecipientPasskeys,
  }));
  app.route("/v1/dashboard", dashboardRouter({ db: deps.db }));
  app.route("/v1/financial-statement", financialStatementsRouter({ repo: fs }));
  app.route("/v1/invest", investRouter({ advisor, securities, payeeSecurities }));
  app.route("/v1/statement-profiles", statementProfilesRouter({ repo: statementProfiles }));
  app.route("/v1/business-plans", businessPlansRouter({ repo: businessPlans, fs, db: deps.db, reviewer: planReviewer }));
  app.route("/v1/subsidies", subsidiesRouter({ repo: subsidies, plans: businessPlans, matcher: subsidyMatcher, crawler: subsidyCrawler }));
  app.route("/v1/portfolio", portfolioRouter({
    service: portfolio,
    holdings,
    contributions,
    valuations: holdingValuations,
    dividends: holdingDividends,
    allocationAdvisor: resolveAllocationAdvisor(deps.allocationAdvisor),
    adviceStore: new AllocationAdviceStore(deps.allocationAdvicePath ?? "app_data/allocation-advice.json"),
  }));
  app.route("/v1/notify", notificationsRouter({ service: notificationService, plans: businessPlans }));
  app.route("/v1/config", configRouter());
  app.route("/v1/integrations/memoria", memoriaIntegrationRouter({ db: deps.db, rules }));

  return app;
}

/**
 * 実 SES 資格情報は本番の送信専用キーそのものなので、 `"auto"` の明示なしに本番クライアントを
 * 組み立てない。 省略時に組み立てると、 notifier 未注入のテストが暗号化ストア由来の env を読み、
 * fixture 宛の実メール送信へ到達しうる。 未設定時は各サービスが 503 not_configured を返す。
 *
 * @implements SPEC-INVOICE-EMAIL-001 (spec/feature/invoice-public-magic-link.md)
 */
function resolveInvoiceEmailNotifier(
  value: InvoiceEmailNotifier | "auto" | "disabled" | undefined,
  email: { region?: string | null; fromAddress?: string | null; configurationSet?: string | null } | undefined,
): InvoiceEmailNotifier | undefined {
  if (value === "auto") {
    return new SesEmailClient({
      region: email?.region ?? undefined,
      fromAddress: email?.fromAddress ?? undefined,
      configurationSet: email?.configurationSet ?? undefined,
      credentials: sesCredentialsFromEnv(),
    });
  }
  if (value && typeof value === "object") return value;
  return undefined;
}

/** @implements SPEC-INVOICE-SLACK-004 (spec/feature/invoice-public-magic-link.md) */
/** テストは注入したクライアントだけを使い、 省略時は実 TSA へ出ない。 */
function resolveEvidenceTimestampClient(
  opt: Rfc3161TimestampClient | "auto" | "disabled" | undefined,
  config: { url?: string; enabled?: boolean } | undefined,
): Rfc3161TimestampClient | undefined {
  if (opt === undefined || opt === "disabled") return undefined;
  if (opt !== "auto") return opt;
  if (config?.enabled === false) return undefined;
  return new Rfc3161TimestampClient({ url: config?.url });
}

function resolveSlackNotifier(
  value: SlackInvoiceNotifier | "auto" | "disabled" | undefined,
): SlackInvoiceNotifier | undefined {
  if (value === "disabled") return undefined;
  if (value && typeof value === "object") return value;
  const token = process.env.QUAESTOR_SLACK_BOT_TOKEN?.trim();
  return token ? new SlackWebApiClient({ botToken: token }) : undefined;
}

function operationalErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[a-z0-9_:-]{1,64}$/i.test(code)) return code;
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "unknown";
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
  if (!detectCli()) return undefined;
  return new ClaudeSecurityMapper();
}

function resolvePerkClient(opt: PerkClient | "auto" | "disabled" | undefined): PerkClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!detectCli()) return undefined;
  return new ClaudePerkClient();
}

function resolveStock(opt: StockClient | "auto" | "disabled" | undefined): StockClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  // Yahoo Finance v8 chart API (stooq は 2026-06 より anti-bot ゲートで失敗)
  return new YahooFinanceStockClient();
}

function resolveAllocationAdvisor(opt: AllocationAdvisor | "auto" | "disabled" | undefined): AllocationAdvisor | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!detectCli()) return undefined;
  return new ClaudeAllocationAdvisor();
}

function resolveSubsidyCrawler(opt: SubsidyCrawler | "auto" | "disabled" | undefined): SubsidyCrawler | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  // jGrants + ミラサポ plus を複合クローラで束ねる
  return new CompositeCrawler([new JGrantsCrawler(), new MirasapoPlusCrawler()]);
}

function resolveDividendClient(opt: DividendClient | "auto" | "disabled" | undefined): DividendClient | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!detectCli()) return undefined;
  return new ClaudeDividendClient();
}

function resolvePlanReviewer(opt: PlanReviewer | "auto" | "disabled" | undefined): PlanReviewer | undefined {
  if (opt === "disabled") return undefined;
  if (opt && typeof opt === "object") return opt;
  if (!detectClaudeCli()) return undefined;
  try { return new ClaudeCliPlanReviewer(); } catch { return undefined; }
}
