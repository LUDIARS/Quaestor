/**
 * SQLite スキーマ定義 + マイグレーション適用。
 * 全マイグレーションは冪等な CREATE IF NOT EXISTS で書き、 PRAGMA user_version で世代管理する。
 */

import type Database from "better-sqlite3";

const STATEMENTS: string[] = [
  // imports — 各 CSV/PDF/Amazon の取込履歴
  `CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    brand TEXT,
    account TEXT,
    filename TEXT,
    imported_at INTEGER NOT NULL,
    metadata TEXT
  )`,

  // transactions — 統合台帳。 各 source の入力を正規化したもの
  `CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    date        TEXT NOT NULL,
    amount_in   INTEGER,
    amount_out  INTEGER,
    currency    TEXT NOT NULL DEFAULT 'JPY',
    fx_amount   REAL,
    fx_currency TEXT,
    description TEXT NOT NULL,
    payee       TEXT,
    source      TEXT NOT NULL,
    source_id   TEXT,
    account     TEXT,
    import_id   INTEGER REFERENCES imports(id),
    metadata    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_payee ON transactions(payee)`,
  `CREATE INDEX IF NOT EXISTS idx_tx_source ON transactions(source, account)`,

  // dedupe: 同一 source × account × source_id は 1 つ
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_tx_source_id
     ON transactions(source, account, source_id)
     WHERE source_id IS NOT NULL`,

  // account_codes — 勘定科目コード (calc 互換 + ユーザ拡張可)
  `CREATE TABLE IF NOT EXISTS account_codes (
    code       INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('revenue','expense','asset','liability')),
    created_at INTEGER NOT NULL
  )`,

  // apportionment_rules — 按分率ルール (pattern → rate + code)
  // priority: 数値が小さいほど優先順位が高い
  `CREATE TABLE IF NOT EXISTS apportionment_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,
    rate       REAL NOT NULL CHECK (rate >= 0 AND rate <= 1),
    code       INTEGER NOT NULL REFERENCES account_codes(code),
    priority   INTEGER NOT NULL DEFAULT 100,
    enabled    INTEGER NOT NULL DEFAULT 1,
    note       TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_rules_priority
     ON apportionment_rules(enabled, priority)`,

  // receipts — AR スキャナで取得したレシート / 領収書
  // OCR 結果は payee/date/total が確定したら入る (v0.4 で実装)
  `CREATE TABLE IF NOT EXISTS receipts (
    id           TEXT PRIMARY KEY,
    captured_at  INTEGER NOT NULL,
    image_path   TEXT,                                                    -- app_data/ からの相対 path
    ocr_status   TEXT NOT NULL DEFAULT 'pending'
                 CHECK (ocr_status IN ('pending','processing','done','failed','manual')),
    date         TEXT,                                                    -- ISO yyyy-mm-dd (OCR 確定後)
    payee        TEXT,
    total        INTEGER,                                                 -- 合計金額 (円)
    items        TEXT,                                                    -- JSON: [{name, price, qty?}]
    geo          TEXT,                                                    -- JSON: {lat, lon, accuracy?}
    ocr_raw      TEXT,                                                    -- LLM の生 response
    metadata     TEXT,                                                    -- JSON: source_frame, capture meta etc
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    -- v19: 書類種別と LLM サンプルラベル (spec/feature/scan-document-kinds.md)。
    --      既存 DB には applyMigrations の ensureColumn で同じ定義を足す。
    doc_kind      TEXT NOT NULL DEFAULT 'receipt'
                  CHECK (doc_kind IN ('receipt','invoice','utility','statement','handwritten','other')),
    kind_fields   TEXT,                                                   -- JSON: 種別固有 (invoice/utility/statement)
    sample_role   TEXT CHECK (sample_role IS NULL OR sample_role IN ('good_sample','special_shape','none')),
    sample_tags   TEXT,                                                   -- JSON 配列: long/folded/faded/...
    sample_reason TEXT,
    sample_source TEXT CHECK (sample_source IS NULL OR sample_source IN ('llm','manual')),
    content_tags  TEXT                                                    -- JSON 配列: medical/transport/food/...
  )`,

  `CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(ocr_status)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_captured ON receipts(captured_at)`,

  // reconciliations — receipt と transaction の確定リンク
  `CREATE TABLE IF NOT EXISTS reconciliations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id      TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    matched_by      TEXT NOT NULL CHECK (matched_by IN ('auto','manual')),
    confidence      REAL NOT NULL,
    notes           TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (receipt_id, transaction_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_recon_receipt ON reconciliations(receipt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recon_tx ON reconciliations(transaction_id)`,

  // invoices — 業務に対する請求書 (発行済 + 入金待ち)。 入金確認は bank tx に link する形
  `CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    issued_at       TEXT NOT NULL,                                          -- ISO yyyy-mm-dd
    due_date        TEXT,                                                   -- ISO yyyy-mm-dd
    client          TEXT NOT NULL,                                          -- 取引先 (例: 教育機関株式会社)
    work_summary    TEXT NOT NULL,                                          -- 業務概要 (請求項目)
    amount          INTEGER NOT NULL,                                       -- 税込総額 (円)
    withholding_tax INTEGER NOT NULL DEFAULT 0,                             -- 源泉徴収額 (差引かれた額)
    status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('draft','sent','paid','overdue','cancelled')),
    transaction_id  TEXT REFERENCES transactions(id) ON DELETE SET NULL,    -- 入金 tx に link
    notes           TEXT,
    metadata        TEXT,                                                   -- JSON 自由領域
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, issued_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_tx ON invoices(transaction_id)`,

  // invoice_delivery_contacts — 請求書を送る企業・メールアドレスの台帳。
  `CREATE TABLE IF NOT EXISTS invoice_delivery_contacts (
    id           TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    email        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_delivery_contacts_company
     ON invoice_delivery_contacts(company_name, active)`,

  // invoice_share_tokens — 公開PDFマジックリンク。URLトークンはSHA-256ダイジェストのみ保存する。
  `CREATE TABLE IF NOT EXISTS invoice_share_tokens (
    id                TEXT PRIMARY KEY,
    invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    token_hash        TEXT NOT NULL UNIQUE,
    document_path     TEXT NOT NULL,
    document_sha256   TEXT NOT NULL CHECK (length(document_sha256) = 64),
    document_size     INTEGER NOT NULL CHECK (document_size > 0),
    filename          TEXT NOT NULL,
    recipient_id      TEXT REFERENCES invoice_delivery_contacts(id) ON DELETE SET NULL,
    recipient_company TEXT,
    recipient_email   TEXT,
    expires_at        INTEGER NOT NULL,
    revoked_at        INTEGER,
    first_viewed_at   INTEGER,
    last_viewed_at    INTEGER,
    view_count        INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_invoice
     ON invoice_share_tokens(invoice_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_share_expiry
     ON invoice_share_tokens(expires_at, revoked_at)`,

  // invoice_share_acceptances — 受領者が請求内容への合意を明示した監査記録。
  `CREATE TABLE IF NOT EXISTS invoice_share_acceptances (
    id                       TEXT PRIMARY KEY,
    share_id                 TEXT NOT NULL UNIQUE REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    invoice_id               INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    recipient_company        TEXT,
    recipient_email          TEXT,
    document_sha256          TEXT NOT NULL CHECK (length(document_sha256) = 64),
    agreement_version        TEXT NOT NULL,
    agreement_text           TEXT NOT NULL,
    accepted_at              INTEGER NOT NULL,
    cf_ray                   TEXT,
    user_agent_sha256        TEXT NOT NULL CHECK (length(user_agent_sha256) = 64),
    authentication_method    TEXT NOT NULL DEFAULT 'legacy_link_confirmation',
    challenge_id             TEXT,
    location_source          TEXT NOT NULL DEFAULT 'unavailable',
    location_country_code    TEXT,
    location_region_code     TEXT,
    issuer_reference_proximity TEXT NOT NULL DEFAULT 'unavailable',
    evidence_sha256          TEXT NOT NULL CHECK (length(evidence_sha256) = 64)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_acceptance_invoice
     ON invoice_share_acceptances(invoice_id, accepted_at)`,

  // invoice_share_challenges — 登録済み受領者メールによる C&R。コード平文は保存しない。
  `CREATE TABLE IF NOT EXISTS invoice_share_challenges (
    id                       TEXT PRIMARY KEY,
    share_id                 TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    channel                  TEXT NOT NULL CHECK (channel = 'email'),
    destination_sha256       TEXT NOT NULL CHECK (length(destination_sha256) = 64),
    code_hash                TEXT NOT NULL CHECK (length(code_hash) = 64),
    created_at               INTEGER NOT NULL,
    expires_at               INTEGER NOT NULL,
    attempt_count            INTEGER NOT NULL DEFAULT 0,
    max_attempts             INTEGER NOT NULL CHECK (max_attempts > 0),
    consumed_at              INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_challenge_share
     ON invoice_share_challenges(share_id, created_at)`,

  // invoice_recipient_passkeys — 送信先 (契約先) が登録した WebAuthn 公開鍵。 秘密鍵は相手端末にしか無い。
  `CREATE TABLE IF NOT EXISTS invoice_recipient_passkeys (
    id                       TEXT PRIMARY KEY,
    contact_id               TEXT NOT NULL REFERENCES invoice_delivery_contacts(id) ON DELETE CASCADE,
    recipient_email_sha256   TEXT NOT NULL CHECK (length(recipient_email_sha256) = 64),
    credential_id            TEXT NOT NULL UNIQUE,
    public_key_cose          TEXT NOT NULL,
    public_key_sha256        TEXT NOT NULL CHECK (length(public_key_sha256) = 64),
    algorithm                INTEGER NOT NULL,
    sign_count               INTEGER NOT NULL DEFAULT 0,
    transports               TEXT,
    aaguid                   TEXT,
    enrolled_via             TEXT NOT NULL CHECK (enrolled_via IN ('email_otp', 'contract_fingerprint')),
    enrollment_challenge_id  TEXT,
    enrolled_share_id        TEXT REFERENCES invoice_share_tokens(id) ON DELETE SET NULL,
    created_at               INTEGER NOT NULL,
    revoked_at               INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_recipient_passkey_contact
     ON invoice_recipient_passkeys(contact_id, revoked_at)`,

  // invoice_share_webauthn_challenges — パスキー登録/署名の一回限り challenge。 平文は HMAC で保持。
  `CREATE TABLE IF NOT EXISTS invoice_share_webauthn_challenges (
    id                       TEXT PRIMARY KEY,
    share_id                 TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    purpose                  TEXT NOT NULL CHECK (purpose IN ('register', 'assert')),
    statement_json           TEXT,
    challenge_hash           TEXT NOT NULL CHECK (length(challenge_hash) = 64),
    enrollment_grant_id      TEXT,
    created_at               INTEGER NOT NULL,
    expires_at               INTEGER NOT NULL,
    consumed_at              INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_webauthn_challenge_share
     ON invoice_share_webauthn_challenges(share_id, created_at)`,

  // invoice_share_enrollment_grants — OTP 通過で 1 回だけ与えるパスキー登録許可。
  `CREATE TABLE IF NOT EXISTS invoice_share_enrollment_grants (
    id                       TEXT PRIMARY KEY,
    share_id                 TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    contact_id               TEXT NOT NULL,
    otp_challenge_id         TEXT NOT NULL,
    grant_hash               TEXT NOT NULL CHECK (length(grant_hash) = 64),
    created_at               INTEGER NOT NULL,
    expires_at               INTEGER NOT NULL,
    consumed_at              INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_enrollment_grant_share
     ON invoice_share_enrollment_grants(share_id, created_at)`,

  // invoice_share_deliveries — Qs 内部配送の冪等性と配送監査。URLトークンは保持しない。
  `CREATE TABLE IF NOT EXISTS invoice_share_deliveries (
    id                       TEXT PRIMARY KEY,
    idempotency_key          TEXT NOT NULL UNIQUE,
    share_id                 TEXT NOT NULL UNIQUE REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    invoice_id               INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    channel                  TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
    destination_sha256       TEXT NOT NULL CHECK (length(destination_sha256) = 64),
    request_sha256           TEXT NOT NULL CHECK (length(request_sha256) = 64),
    status                   TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    provider_message_id      TEXT,
    failure_code             TEXT,
    created_at               INTEGER NOT NULL,
    completed_at             INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_delivery_invoice
     ON invoice_share_deliveries(invoice_id, created_at)`,

  // invoice_share_access_logs — 有効な公開リンクへの成功アクセスを追記する監査ログ。
  `CREATE TABLE IF NOT EXISTS invoice_share_access_logs (
    id                       TEXT PRIMARY KEY,
    share_id                 TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
    invoice_id               INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    event_type               TEXT NOT NULL CHECK (event_type IN ('landing_view', 'document_view')),
    accessed_at              INTEGER NOT NULL,
    cf_ray                   TEXT,
    client_address_sha256    TEXT NOT NULL CHECK (length(client_address_sha256) = 64),
    user_agent_sha256        TEXT NOT NULL CHECK (length(user_agent_sha256) = 64),
    location_source          TEXT NOT NULL DEFAULT 'unavailable',
    location_country_code    TEXT,
    location_region_code     TEXT,
    issuer_reference_proximity TEXT NOT NULL DEFAULT 'unavailable',
    evidence_sha256          TEXT NOT NULL CHECK (length(evidence_sha256) = 64)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_invoice_share_access_share
     ON invoice_share_access_logs(share_id, accessed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_share_access_invoice
     ON invoice_share_access_logs(invoice_id, accessed_at)`,

  // financial_statements — 年次決算書 (損益計算書 P&L、 貸借対照表 BS、 月別売上、 控除等)
  // 2025 のような実値はxlsx取込で source='imported' として入る。 他年度は計算 ('computed') 。
  `CREATE TABLE IF NOT EXISTS financial_statements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    year          INTEGER NOT NULL,
    section       TEXT NOT NULL,
    label         TEXT NOT NULL,
    amount        INTEGER,
    display_order INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT,
    source        TEXT NOT NULL DEFAULT 'manual',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE(year, section, label)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_fs_year ON financial_statements(year, section, display_order)`,

  `CREATE TABLE IF NOT EXISTS mail_messages (
    message_id TEXT PRIMARY KEY, thread_id TEXT, received_at INTEGER NOT NULL,
    from_address TEXT NOT NULL, subject TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('invoice','cloud_notice','ignore')),
    rule_index INTEGER, outcome TEXT NOT NULL, error TEXT, processed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbound_documents (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES mail_messages(message_id) ON DELETE CASCADE,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL, file_path TEXT NOT NULL, sha256 TEXT NOT NULL,
    size INTEGER NOT NULL, extracted TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','needs_review','ignored')),
    receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_sha ON inbound_documents(sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_documents(status)`,

  // ── 投資 / 優待アドバイザ (spec/feature/invest-advisor.md) ──

  // securities — 銘柄マスタ。 ticker = 日本株の証券コード (4 桁) を PK にする
  `CREATE TABLE IF NOT EXISTS securities (
    ticker     TEXT PRIMARY KEY,                                       -- 証券コード 例 "8267"
    name       TEXT NOT NULL,                                          -- 会社名
    market     TEXT,                                                   -- 例 "東証プライム"
    metadata   TEXT,                                                   -- JSON 自由領域
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // payee_securities — 店名(正規化) → 銘柄リンク。 行動解析と市場データの橋渡し。
  // ticker NULL = 「解析したが上場該当なし」 (relation='none')。 1 payee = 1 行。
  `CREATE TABLE IF NOT EXISTS payee_securities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    payee_norm   TEXT NOT NULL UNIQUE,                                 -- normalizePayee 済キー
    payee_sample TEXT,                                                 -- 元表記サンプル (UI 表示用)
    ticker       TEXT REFERENCES securities(ticker) ON DELETE SET NULL,
    relation     TEXT NOT NULL DEFAULT 'operator'
                 CHECK (relation IN ('operator','brand','parent','none')),
    confidence   REAL NOT NULL DEFAULT 0,
    reason       TEXT,                                                 -- Claude の判断根拠
    source       TEXT NOT NULL DEFAULT 'claude'
                 CHECK (source IN ('claude','manual')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_payee_sec_ticker ON payee_securities(ticker)`,

  // stock_quotes — 株価スナップショット (日足キャッシュ + 期間騰落率)。
  `CREATE TABLE IF NOT EXISTS stock_quotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    as_of       TEXT NOT NULL,                                         -- 最新足の日付 ISO yyyy-mm-dd
    close       REAL,                                                  -- 終値
    prev_close  REAL,                                                  -- 期間始点の終値 (比較用)
    change_pct  REAL,                                                  -- 期間騰落率 %
    period_days INTEGER,                                               -- trend 計算窓
    currency    TEXT NOT NULL DEFAULT 'JPY',
    bars        TEXT,                                                  -- JSON: [{date, close}] 直近 N 本 (sparkline)
    fetched_at  INTEGER NOT NULL,
    UNIQUE (ticker, as_of)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_quotes_ticker ON stock_quotes(ticker, as_of)`,

  // statement_profiles — クレカ/明細 CSV の列マッピング定義 (外部登録可能な importer)。
  // UFJ/SMBC は固有ロジックの bespoke importer を維持し、 本テーブルは他社カード追加用。
  `CREATE TABLE IF NOT EXISTS statement_profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,                                       -- 表示名 例 "楽天カード"
    brand           TEXT NOT NULL UNIQUE,                                -- import 時の brand slug 例 "rakuten"
    source          TEXT NOT NULL DEFAULT 'credit-card'
                    CHECK (source IN ('credit-card','bank','amazon','receipt','manual')),
    encoding        TEXT NOT NULL DEFAULT 'auto'
                    CHECK (encoding IN ('auto','shift_jis','utf-8')),
    header_skip     INTEGER NOT NULL DEFAULT 0,                          -- 先頭から読み飛ばす行数
    col_date        INTEGER NOT NULL,                                    -- 0-based 列番号: 日付
    col_payee       INTEGER NOT NULL,                                    -- 店名
    col_amount      INTEGER NOT NULL,                                    -- 金額
    col_memo        INTEGER,                                             -- メモ (任意)
    amount_sign     TEXT NOT NULL DEFAULT 'out'
                    CHECK (amount_sign IN ('out','in','signed')),        -- out=出金 / in=入金 / signed=符号で判定
    filter_col      INTEGER,                                             -- 行フィルタ列 (任意)
    filter_value    TEXT,                                                -- その列がこの値の行のみ取込 (例 UFJ "確定")
    date_year_hint  INTEGER,                                             -- M/D 形式用の補完年 (任意)
    account_default TEXT,                                                -- 既定 account ラベル
    detect_keywords TEXT,                                                -- JSON 配列: auto-detect 用キーワード
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,

  // shareholder_perks — 株主優待 (公式 API が無いため LLM 知識ベース)。 1 ticker = 1 行。
  `CREATE TABLE IF NOT EXISTS shareholder_perks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker           TEXT NOT NULL UNIQUE REFERENCES securities(ticker) ON DELETE CASCADE,
    has_perk         INTEGER NOT NULL DEFAULT 0,                       -- 優待制度の有無
    min_shares       INTEGER,                                         -- 必要株数
    description      TEXT,                                            -- 優待内容
    ex_rights_months TEXT,                                            -- JSON: [3,9] 権利確定月
    perk_value_yen   INTEGER,                                         -- 優待価値 (円、 概算)
    yield_pct        REAL,                                            -- 優待利回り % (概算)
    notes            TEXT,
    source           TEXT NOT NULL DEFAULT 'claude'
                     CHECK (source IN ('claude','manual')),
    fetched_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`,

  // ── 事業計画レビュー (spec/feature/business-plan.md) ──

  // business_plans — 事業計画インスタンス。 template から sections/figures を seed する
  `CREATE TABLE IF NOT EXISTS business_plans (
    id            TEXT PRIMARY KEY,                                   -- uuid
    name          TEXT NOT NULL,
    template      TEXT NOT NULL,                                      -- jfc_startup / jizokuka / monodukuri / freeform
    purpose       TEXT NOT NULL DEFAULT 'funding'
                  CHECK (purpose IN ('funding','subsidy','internal')),
    status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','review','final')),
    fiscal_start  TEXT,                                               -- 開始年月 ISO yyyy-mm
    horizon_years INTEGER NOT NULL DEFAULT 3,
    notes         TEXT,
    metadata      TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plans_status ON business_plans(status, updated_at)`,

  // business_plan_sections — 記述セクション本文 (template.sections に対応)
  `CREATE TABLE IF NOT EXISTS business_plan_sections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       TEXT NOT NULL REFERENCES business_plans(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,                                      -- template-defined section key
    body          TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    UNIQUE(plan_id, key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plan_sections ON business_plan_sections(plan_id, display_order)`,

  // business_plan_figures — 数字 (template.figures に対応)。 category 語彙は quant.ts が解釈
  `CREATE TABLE IF NOT EXISTS business_plan_figures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       TEXT NOT NULL REFERENCES business_plans(id) ON DELETE CASCADE,
    category      TEXT NOT NULL,                                      -- sales/cogs/sga/funding/use_of_funds/...
    label         TEXT NOT NULL,
    period        TEXT NOT NULL,                                      -- base / Y1.. / M1..
    amount        INTEGER,
    display_order INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','from_actuals')),
    metadata      TEXT,                                               -- JSON: { tag?: 'own_funds'|'subsidy_grant' }
    UNIQUE(plan_id, category, label, period)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plan_figures ON business_plan_figures(plan_id, category, display_order)`,

  // business_plan_reviews — レビュー実行結果 (定量 / 定性 / 結合)
  `CREATE TABLE IF NOT EXISTS business_plan_reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       TEXT NOT NULL REFERENCES business_plans(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('quantitative','qualitative','combined')),
    score         INTEGER,                                            -- 0..100
    summary       TEXT,
    findings      TEXT NOT NULL DEFAULT '[]',                         -- JSON: Finding[]
    metrics       TEXT,                                               -- JSON: QuantMetrics snapshot
    model         TEXT,                                               -- 定性レビューの model
    created_at    INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plan_reviews ON business_plan_reviews(plan_id, created_at)`,

  // subsidies — 補助金・助成金・制度融資の情報管理 (手動登録 + 計画への要件マッチング元データ)
  `CREATE TABLE IF NOT EXISTS subsidies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    agency       TEXT,                                                  -- 実施機関 (例: 中小企業庁)
    kind         TEXT NOT NULL DEFAULT 'subsidy'
                 CHECK (kind IN ('subsidy','grant','loan','other')),    -- 補助金/助成金/融資/その他
    url          TEXT,
    summary      TEXT,                                                  -- 概要
    target       TEXT,                                                  -- 対象者 (例: 創業5年以内の小規模事業者)
    requirements TEXT,                                                  -- 要件 (改行区切りテキスト)
    max_amount   INTEGER,                                               -- 上限額 (円)
    subsidy_rate REAL,                                                  -- 補助率 (0..1)
    deadline     TEXT,                                                  -- 締切 ISO yyyy-mm-dd
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','upcoming','closed')),
    notes        TEXT,
    metadata     TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_subsidies_status ON subsidies(status, deadline)`,

  // ── 積立ポートフォリオ / 配当アドバイザ (spec/feature/portfolio-advisor.md) ──

  // holdings — 保有/積立投資商品。 投信(fund) / 個別株(stock) / ETF(etf) / 保険型(insurance) を 1 テーブルに合流。
  // 価格源は kind で変わる: stock/etf=stooq 自動、 fund/insurance=手動評価額。
  `CREATE TABLE IF NOT EXISTS holdings (
    id                   TEXT PRIMARY KEY,                                  -- ulid
    kind                 TEXT NOT NULL
                         CHECK (kind IN ('fund','stock','etf','insurance','other')),
    name                 TEXT NOT NULL,                                     -- 商品名 例 "eMAXIS Slim 全世界株式"
    account              TEXT,                                             -- 口座/契約先 例 "SBI つみたてNISA"
    ticker               TEXT,                                             -- 個別株/ETF の証券コード (任意)
    fund_code            TEXT,                                             -- 投信の協会コード/ISIN (任意)
    currency             TEXT NOT NULL DEFAULT 'JPY',                       -- 評価通貨 (外貨建保険は USD 等)
    tax_wrapper          TEXT
                         CHECK (tax_wrapper IS NULL OR tax_wrapper IN
                           ('nisa_tsumitate','nisa_growth','ideco','taxable','insurance')),
    target_amount        INTEGER,                                          -- 目標額 (見通しのゴール, 円)
    monthly_contribution INTEGER,                                          -- 計画積立額 (円/月) = plan-variance の plan
    status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','paused','closed')),
    started_at           TEXT,                                             -- 積立開始 yyyy-mm-dd
    notes                TEXT,
    metadata             TEXT,                                             -- JSON 自由領域
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_holdings_kind ON holdings(kind, status)`,

  // contributions — 拠出 (積立) の計画/実績。 plan-variance の基礎データ。
  // amount は投資家視点の拠出額 (入金=正)、 取崩しは負。
  `CREATE TABLE IF NOT EXISTS contributions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id  TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,                                            -- yyyy-mm-dd
    amount      INTEGER NOT NULL,                                         -- 拠出額 (円)。 取崩しは負
    kind        TEXT NOT NULL DEFAULT 'actual'
                CHECK (kind IN ('planned','actual')),
    units       REAL,                                                     -- 取得口数/株数 (任意)
    unit_price  REAL,                                                     -- 取得単価/基準価額 (任意)
    note        TEXT,
    created_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_contrib_holding ON contributions(holding_id, date)`,

  // holding_valuations — 時価スナップショット (手動入力 or stooq)。 1 holding × as_of。
  `CREATE TABLE IF NOT EXISTS holding_valuations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id   TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
    as_of        TEXT NOT NULL,                                           -- yyyy-mm-dd
    market_value INTEGER NOT NULL,                                        -- 評価額 (円, JPY 換算後)
    unit_price   REAL,                                                    -- 基準価額/株価 (任意, 元通貨)
    units        REAL,                                                    -- 保有口数/株数 (任意)
    fx_rate      REAL,                                                    -- 外貨建の対円レート (任意)
    source       TEXT NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','stooq','import')),
    note         TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (holding_id, as_of)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_holdval_holding ON holding_valuations(holding_id, as_of)`,

  // holding_dividends — 受取分配金/配当の実績。 トータルリターン (再投資しない分の cashflow) に効く。
  `CREATE TABLE IF NOT EXISTS holding_dividends (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id  TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
    pay_date    TEXT NOT NULL,                                            -- yyyy-mm-dd
    amount      INTEGER NOT NULL,                                         -- 受取額 (円)
    per_share   REAL,                                                     -- 1株/口あたり (任意)
    reinvested  INTEGER NOT NULL DEFAULT 0,                               -- 1=再投資 (評価額に内包済)
    note        TEXT,
    created_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_holddiv_holding ON holding_dividends(holding_id, pay_date)`,

  // dividend_candidates — 配当株サジェスト (公開情報ベース, Claude + stooq)。 1 ticker = 1 行。
  // ※ 公開・過去実績データのみ。 未公表情報 (MNPI) は扱わない方針 (spec 参照)。
  `CREATE TABLE IF NOT EXISTS dividend_candidates (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker                     TEXT NOT NULL UNIQUE REFERENCES securities(ticker) ON DELETE CASCADE,
    dividend_yield_pct         REAL,                                     -- 配当利回り %
    dps_annual                 REAL,                                     -- 年間 1 株配当 (円)
    payout_ratio_pct           REAL,                                     -- 配当性向 %
    consecutive_increase_years INTEGER,                                  -- 連続増配年数
    ex_rights_months           TEXT,                                     -- JSON [3,9] 権利確定月
    stability_note             TEXT,                                     -- 減配リスク等の所見
    rationale                  TEXT,                                     -- 推奨理由 (公開情報のみ)
    source                     TEXT NOT NULL DEFAULT 'claude'
                               CHECK (source IN ('claude','manual')),
    fetched_at                 INTEGER NOT NULL,
    updated_at                 INTEGER NOT NULL
  )`,

  // ---- v16: 家計簿 × 業務仕訳 (spec/plan/2026-09-03-household-bookkeeping-analysis.md) ----

  // household_categories — 家計費目 (食費 / 旅行・レジャー / ATM 現金引出 …)。 2 階層。
  `CREATE TABLE IF NOT EXISTS household_categories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    parent_id     INTEGER REFERENCES household_categories(id) ON DELETE SET NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  )`,

  // household_rules — payee pattern → 家計費目。 apportionment_rules と同じ優先順位規則。
  `CREATE TABLE IF NOT EXISTS household_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES household_categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 100,
    enabled     INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_household_rules_priority ON household_rules(enabled, priority)`,

  // journal_entries — 仕訳帳の正本 (エクセル簿記の 仕訳帳 シート B..L 列と同じ意味)。
  // origin=transaction は取引からの自動生成行で、 rebuild で入れ替わる (locked=1 は保持)。
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    fiscal_year           INTEGER NOT NULL CHECK (fiscal_year BETWEEN 1900 AND 2999),
    entry_date            TEXT NOT NULL,
    no                    INTEGER NOT NULL DEFAULT 0,
    debit_code            INTEGER NOT NULL CHECK (debit_code > 0),
    debit_amount          INTEGER NOT NULL CHECK (debit_amount >= 0),
    credit_code           INTEGER NOT NULL CHECK (credit_code > 0),
    credit_amount         INTEGER NOT NULL CHECK (credit_amount >= 0 AND credit_amount = debit_amount),
    description           TEXT NOT NULL,
    payment               INTEGER NOT NULL CHECK (payment >= 0),
    rate                  REAL NOT NULL DEFAULT 1 CHECK (rate >= 0 AND rate <= 1),
    origin                TEXT NOT NULL CHECK (origin IN ('transaction','manual','imported')),
    leg                   TEXT CHECK (leg IN ('expense','household','income')),
    source_tx_id          TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    receipt_id            TEXT REFERENCES receipts(id) ON DELETE SET NULL,
    household_category_id INTEGER REFERENCES household_categories(id) ON DELETE SET NULL,
    locked                INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_journal_year_date ON journal_entries(fiscal_year, entry_date, no)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_debit ON journal_entries(fiscal_year, debit_code)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_credit ON journal_entries(fiscal_year, credit_code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_tx_leg
     ON journal_entries(source_tx_id, leg)
     WHERE source_tx_id IS NOT NULL AND origin = 'transaction'`,

  // apportionment_observations — 按分シートの素材。 過去帳簿で「この店をどの率・科目で処理したか」の集計。
  `CREATE TABLE IF NOT EXISTS apportionment_observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fiscal_year  INTEGER NOT NULL CHECK (fiscal_year BETWEEN 1900 AND 2999),
    payee_norm   TEXT NOT NULL,
    payee_sample TEXT NOT NULL,
    rate         REAL NOT NULL CHECK (rate >= 0 AND rate <= 1),
    code         INTEGER NOT NULL CHECK (code > 0),
    occurrences  INTEGER NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
    total_amount INTEGER NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    first_seen   TEXT,
    last_seen    TEXT,
    source       TEXT NOT NULL CHECK (source IN ('journal-xlsx','ledger')),
    updated_at   INTEGER NOT NULL,
    UNIQUE (fiscal_year, payee_norm, rate, code, source)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_apportionment_obs_payee ON apportionment_observations(payee_norm, fiscal_year)`,

  // ---- v17: 減価償却 (spec/plan/2026-09-03-depreciation.md) ----

  // fixed_assets — 固定資産台帳 (エクセル簿記 ③ の 1 行 = 1 資産)。 償却額は保存せず年ごとに計算する。
  `CREATE TABLE IF NOT EXISTS fixed_assets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    quantity           TEXT,
    acquired_on        TEXT NOT NULL,
    cost               INTEGER NOT NULL CHECK (cost >= 0),
    method             TEXT NOT NULL CHECK (method IN (
                         'straight_line','declining_balance','old_straight_line','old_declining_balance','lump_sum_3y','immediate')),
    useful_life        INTEGER NOT NULL DEFAULT 0 CHECK (
                         (method IN ('lump_sum_3y','immediate') AND useful_life BETWEEN 0 AND 50)
                         OR useful_life BETWEEN 2 AND 50),
    business_ratio     REAL NOT NULL DEFAULT 1 CHECK (business_ratio >= 0 AND business_ratio <= 1),
    asset_code         INTEGER NOT NULL DEFAULT 115 CHECK (asset_code BETWEEN 1 AND 9999),
    expense_code       INTEGER NOT NULL DEFAULT 18 CHECK (expense_code BETWEEN 1 AND 9999),
    opening_book_value INTEGER CHECK (opening_book_value IS NULL OR (opening_book_value >= 0 AND opening_book_value <= cost)),
    opening_year       INTEGER CHECK (opening_year IS NULL OR (opening_year BETWEEN 1900 AND 2999 AND opening_year >= CAST(substr(acquired_on, 1, 4) AS INTEGER))),
    revised_cost       INTEGER CHECK (revised_cost IS NULL OR
                         (method = 'declining_balance' AND opening_year IS NOT NULL AND revised_cost >= 0 AND revised_cost <= cost)),
    disposed_on        TEXT,
    notes              TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    CHECK ((opening_book_value IS NULL AND opening_year IS NULL) OR (opening_book_value IS NOT NULL AND opening_year IS NOT NULL)),
    CHECK (disposed_on IS NULL OR disposed_on >= acquired_on),
    CHECK (disposed_on IS NULL OR opening_year IS NULL OR opening_year <= CAST(substr(disposed_on, 1, 4) AS INTEGER))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_fixed_assets_acquired ON fixed_assets(acquired_on)`,

  // ---- v18: 固定費 / 変動費と水道光熱費の分類ルール (spec/plan/2026-09-03-cost-structure.md) ----
  `CREATE TABLE IF NOT EXISTS cost_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,
    cost_type  TEXT NOT NULL CHECK (cost_type IN ('fixed','variable')),
    utility    TEXT CHECK (utility IS NULL OR utility IN ('electric','gas','water')),
    label      TEXT,
    priority   INTEGER NOT NULL DEFAULT 100,
    enabled    INTEGER NOT NULL DEFAULT 1,
    note       TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cost_rules_priority ON cost_rules(enabled, priority)`,
];

export function applyMigrations(db: Database.Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    preserveLegacyInvoiceShareTable(db);
    for (const sql of STATEMENTS) db.exec(sql);
  })();
  // 追加カラム (冪等的に追加) — INDEX は ALTER の後に発行する
  ensureColumn(db, "transactions", "is_transfer", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions(is_transfer)");
  // receipts.committed_at: 「投入」 済タイムスタンプ (NULL = 未投入)。
  // 手動シャッター flow で OCR 後にデータ完備を確認 → 投入する際にセットする。
  ensureColumn(db, "receipts", "committed_at", "INTEGER");
  ensureColumn(
    db,
    "invoice_share_tokens",
    "recipient_id",
    "TEXT REFERENCES invoice_delivery_contacts(id) ON DELETE SET NULL",
  );
  ensureColumn(db, "invoice_share_tokens", "recipient_company", "TEXT");
  ensureColumn(db, "invoice_share_tokens", "recipient_email", "TEXT");
  ensureColumn(
    db,
    "invoice_share_acceptances",
    "authentication_method",
    "TEXT NOT NULL DEFAULT 'legacy_link_confirmation'",
  );
  ensureColumn(db, "invoice_share_acceptances", "challenge_id", "TEXT");
  ensureColumn(
    db,
    "invoice_share_acceptances",
    "location_source",
    "TEXT NOT NULL DEFAULT 'unavailable'",
  );
  ensureColumn(db, "invoice_share_acceptances", "location_country_code", "TEXT");
  ensureColumn(db, "invoice_share_acceptances", "location_region_code", "TEXT");
  ensureColumn(
    db,
    "invoice_share_acceptances",
    "issuer_reference_proximity",
    "TEXT NOT NULL DEFAULT 'unavailable'",
  );
  ensureColumn(
    db,
    "invoice_share_access_logs",
    "location_source",
    "TEXT NOT NULL DEFAULT 'unavailable'",
  );
  ensureColumn(db, "invoice_share_access_logs", "location_country_code", "TEXT");
  ensureColumn(db, "invoice_share_access_logs", "location_region_code", "TEXT");
  ensureColumn(
    db,
    "invoice_share_access_logs",
    "issuer_reference_proximity",
    "TEXT NOT NULL DEFAULT 'unavailable'",
  );
  ensureColumn(db, "invoice_share_deliveries", "request_sha256", "TEXT");
  // v15: パスキー署名による合意の証跡と外部タイムスタンプ (spec/plan/2026-08-19-passkey-acceptance.md)
  for (const column of [
    "passkey_id", "credential_id", "statement_json", "client_data_json",
    "authenticator_data_b64url", "assertion_signature_b64url", "public_key_sha256",
    "timestamp_authority", "timestamp_last_error",
  ]) {
    ensureColumn(db, "invoice_share_acceptances", column, "TEXT");
  }
  ensureColumn(db, "invoice_share_acceptances", "timestamp_status", "TEXT NOT NULL DEFAULT 'skipped'");
  ensureColumn(db, "invoice_share_acceptances", "timestamp_token", "BLOB");
  ensureColumn(db, "invoice_share_acceptances", "timestamp_requested_at", "INTEGER");
  ensureColumn(db, "invoice_share_acceptances", "timestamp_granted_at", "INTEGER");
  ensureColumn(db, "invoice_share_acceptances", "timestamp_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "invoice_recipient_passkeys", "recipient_email_sha256", "TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_invoice_recipient_passkey_identity"
    + " ON invoice_recipient_passkeys(contact_id, recipient_email_sha256, revoked_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_invoice_share_acceptance_timestamp_pending"
    + " ON invoice_share_acceptances(timestamp_status, accepted_at)",
  );
  // 投入時の (日付-場所-金額) 重複判定用。 payee は JS 側で正規化比較するため
  // ここでは date + total の絞り込みに使う。
  db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_commit_key ON receipts(date, total) WHERE committed_at IS NOT NULL");
  // v16: 家計簿 × 業務仕訳 (journal_entries / household_* / apportionment_observations) — STATEMENTS で作成済
  // v17: 減価償却。 償却仕訳の行に資産 id を持たせ、 年単位で再計上できるようにする
  ensureColumn(db, "journal_entries", "asset_id", "INTEGER REFERENCES fixed_assets(id) ON DELETE CASCADE");
  db.exec("CREATE INDEX IF NOT EXISTS idx_journal_asset ON journal_entries(fiscal_year, asset_id)");
  // v18: cost_rules — STATEMENTS で作成済
  // v19: 書類種別 + LLM サンプルラベル (spec/feature/scan-document-kinds.md)。
  //      既存行は doc_kind='receipt'、 sample_* は NULL (= 未ラベル、 後付け CLI の対象)。
  ensureColumn(
    db, "receipts", "doc_kind",
    "TEXT NOT NULL DEFAULT 'receipt' CHECK (doc_kind IN ('receipt','invoice','utility','statement','handwritten','other'))",
  );
  ensureColumn(db, "receipts", "kind_fields", "TEXT");
  ensureColumn(
    db, "receipts", "sample_role",
    "TEXT CHECK (sample_role IS NULL OR sample_role IN ('good_sample','special_shape','none'))",
  );
  ensureColumn(db, "receipts", "sample_tags", "TEXT");
  ensureColumn(db, "receipts", "sample_reason", "TEXT");
  ensureColumn(
    db, "receipts", "sample_source",
    "TEXT CHECK (sample_source IS NULL OR sample_source IN ('llm','manual'))",
  );
  ensureColumn(db, "receipts", "content_tags", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_doc_kind ON receipts(doc_kind)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_sample_role ON receipts(sample_role)");
  db.pragma("user_version = 19");
}

const INVOICE_SHARE_REQUIRED_COLUMNS = [
  "id",
  "invoice_id",
  "token_hash",
  "document_path",
  "document_sha256",
  "document_size",
  "filename",
  "expires_at",
  "revoked_at",
  "first_viewed_at",
  "last_viewed_at",
  "view_count",
  "created_at",
] as const;

/**
 * 正式導入前のローカル版には同名で非互換なテーブルが存在した。
 * 行を削除せず legacy テーブルへ退避し、現行 CREATE TABLE が新しい正本を作れるようにする。
 */
function preserveLegacyInvoiceShareTable(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(invoice_share_tokens)").all() as { name: string }[];
  if (
    columns.length === 0
    || INVOICE_SHARE_REQUIRED_COLUMNS.every((required) => columns.some(({ name }) => name === required))
  ) {
    return;
  }

  const backupColumns = db.prepare("PRAGMA table_info(invoice_share_tokens_legacy_v8)").all() as { name: string }[];
  if (backupColumns.length > 0) {
    throw new Error(
      "invoice_share_tokens and invoice_share_tokens_legacy_v8 are both legacy schemas; "
      + "rename or drop invoice_share_tokens_legacy_v8 by hand so the backup is not overwritten",
    );
  }

  db.exec("ALTER TABLE invoice_share_tokens RENAME TO invoice_share_tokens_legacy_v8");
  // SQLite は明示 index 名を table rename 後も保持するため、現行 table 用の名前だけ解放する。
  db.exec("DROP INDEX IF EXISTS idx_invoice_share_invoice");
  db.exec("DROP INDEX IF EXISTS idx_invoice_share_expiry");
}

/** 既に column が存在する DB に対しても安全な ADD COLUMN */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
