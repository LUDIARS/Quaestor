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
];

export function applyMigrations(db: Database.Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.transaction(() => {
    for (const sql of STATEMENTS) db.exec(sql);
  })();
  db.pragma("user_version = 1");
}
