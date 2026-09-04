import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/schema.js";

/**
 * v21: mail_messages.kind の CHECK を ci_failure / dependabot まで広げる。
 * SQLite は CHECK を ALTER できないため table を作り替える。 既存行を落とさないことと、
 * 広げ忘れると claim() が実行時に落ちることの両方を押さえる。
 */
describe("mail_messages kind migration (v21)", () => {
  it("widens the CHECK constraint while keeping existing rows", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE mail_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, received_at INTEGER NOT NULL,
      from_address TEXT NOT NULL, subject TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('invoice','cloud_notice','ignore')),
      rule_index INTEGER, outcome TEXT NOT NULL, error TEXT, processed_at INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO mail_messages
       (message_id, thread_id, received_at, from_address, subject, kind, rule_index, outcome, error, processed_at)
       VALUES ('legacy-1', 'thread-1', 100, 'billing@example.com', 'Invoice', 'invoice', 0, 'committed', NULL, 100)`,
    ).run();

    applyMigrations(db);

    expect(db.prepare("SELECT * FROM mail_messages WHERE message_id = 'legacy-1'").get())
      .toMatchObject({ kind: "invoice", outcome: "committed" });
    expect(db.pragma("user_version", { simple: true })).toBe(21);
    for (const kind of ["ci_failure", "dependabot"]) {
      expect(() => insert(db, `${kind}-1`, kind)).not.toThrow();
    }
    expect(() => insert(db, "bogus-1", "bogus")).toThrow();
    db.close();
  });

  it("keeps the foreign key from inbound_documents usable after the rebuild", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insert(db, "message-1", "ci_failure");

    expect(() => db.prepare(
      `INSERT INTO inbound_documents
       (id, source, message_id, filename, mime_type, file_path, sha256, size, extracted, status, receipt_id, created_at, updated_at)
       VALUES ('doc-1', 'mail', 'message-1', 'a.pdf', 'application/pdf', 'a.pdf', 'hash', 1, NULL, 'needs_review', NULL, 1, 1)`,
    ).run()).not.toThrow();
    db.close();
  });

  it("is idempotent when applied twice", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insert(db, "message-1", "dependabot");
    applyMigrations(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM mail_messages").get()).toEqual({ n: 1 });
    db.close();
  });
});

function insert(db: Database.Database, id: string, kind: string): void {
  db.prepare(
    `INSERT INTO mail_messages
     (message_id, thread_id, received_at, from_address, subject, kind, rule_index, outcome, error, processed_at)
     VALUES (?, NULL, 100, 'notifications@github.com', 'subject', ?, 0, 'processing', NULL, 100)`,
  ).run(id, kind);
}
