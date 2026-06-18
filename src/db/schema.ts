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
    updated_at   INTEGER NOT NULL
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
    client          TEXT NOT NULL,                                          -- 取引先 (例: バンタン株式会社)
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
];

export function applyMigrations(db: Database.Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    for (const sql of STATEMENTS) db.exec(sql);
  })();
  // 追加カラム (冪等的に追加) — INDEX は ALTER の後に発行する
  ensureColumn(db, "transactions", "is_transfer", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions(is_transfer)");
  // receipts.committed_at: 「投入」 済タイムスタンプ (NULL = 未投入)。
  // 手動シャッター flow で OCR 後にデータ完備を確認 → 投入する際にセットする。
  ensureColumn(db, "receipts", "committed_at", "INTEGER");
  // 投入時の (日付-場所-金額) 重複判定用。 payee は JS 側で正規化比較するため
  // ここでは date + total の絞り込みに使う。
  db.exec("CREATE INDEX IF NOT EXISTS idx_receipts_commit_key ON receipts(date, total) WHERE committed_at IS NOT NULL");
  db.pragma("user_version = 7");
}

/** 既に column が存在する DB に対しても安全な ADD COLUMN */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
