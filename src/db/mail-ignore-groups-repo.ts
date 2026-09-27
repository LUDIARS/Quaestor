import type Database from "better-sqlite3";
import { ruleFingerprint, type Condition, type FeatureMap } from "@ludiars/blackbox";
import type { MailMessageRow } from "./mail-messages-repo.js";

export interface IgnoreGroup {
  id: string; count: number; sender: string; subject: string; lastReceived: number;
  state: string; ruleId: string | null;
}
const GROUP_KEY = "COALESCE(e.fingerprint, CASE WHEN e.message_id IS NULL THEN 'unprofiled' ELSE 'ineligible' END)";
const FROM = "FROM mail_messages m LEFT JOIN mail_ignore_evidence e ON e.message_id = m.message_id";
const IGNORED = "m.kind = 'ignore' AND m.outcome LIKE 'ignored%'";

/** Read model across all persisted history, never just the current UI page. */
export class MailIgnoreGroupsRepo {
  constructor(private readonly db: Database.Database) {}

  list(offset: number, limit = 51): IgnoreGroup[] {
    const rows = this.db.prepare(`SELECT ${GROUP_KEY} AS id, COUNT(*) AS count,
      MIN(m.from_address) AS sender, MIN(m.subject) AS subject, MAX(m.received_at) AS lastReceived,
      MIN(e.features) AS features ${FROM} WHERE ${IGNORED}
      GROUP BY ${GROUP_KEY} ORDER BY count DESC, lastReceived DESC, id ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as (Omit<IgnoreGroup, "state" | "ruleId"> & { features: string | null })[];
    return rows.map(({ features, ...row }) => {
      if (!features) return { ...row, sender: "", subject: "", state: row.id, ruleId: null };
      const when: Condition = { op: "and", clauses: Object.entries(JSON.parse(features) as FeatureMap)
        .map(([feature, value]) => ({ op: "cmp", feature, cmp: "==", value })) };
      const rule = this.db.prepare("SELECT id, state FROM blackbox_rules WHERE domain = ? AND fingerprint = ? LIMIT 1")
        .get("mail.bulk-ignore", ruleFingerprint(when, "ignore")) as { id: string; state: string } | undefined;
      return { ...row, state: rule?.state ?? "candidate", ruleId: rule?.id ?? null };
    });
  }

  messages(group: string, offset: number, limit = 51): MailMessageRow[] {
    return this.db.prepare(`SELECT m.* ${FROM} WHERE ${IGNORED} AND ${GROUP_KEY} = ?
      ORDER BY m.received_at DESC, m.message_id DESC LIMIT ? OFFSET ?`).all(group, limit, offset) as MailMessageRow[];
  }
}
