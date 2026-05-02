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
];

export function applyMigrations(db: Database.Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    for (const sql of STATEMENTS) db.exec(sql);
  })();
  db.pragma("user_version = 1");
}
