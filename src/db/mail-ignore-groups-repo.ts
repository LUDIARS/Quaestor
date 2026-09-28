import type Database from "better-sqlite3";
import { ruleFingerprint, type Condition, type FeatureMap } from "@ludiars/blackbox";
import type { MailMessageRow, MailKind } from "./mail-messages-repo.js";
import { mailTopic } from "../mail/topic-groups.js";

export interface IgnoreGroup {
  id: string; count: number; sender: string; subject: string; lastReceived: number;
  state: string; ruleId: string | null;
}
const TOPIC = "mail_topic_key(m.from_address, m.subject)";
const GROUP_KEY = `COALESCE(${TOPIC}, e.fingerprint, CASE WHEN e.message_id IS NULL THEN 'unprofiled' ELSE 'ineligible' END)`;
const FROM = "FROM mail_messages m LEFT JOIN mail_ignore_evidence e ON e.message_id = m.message_id";
const IGNORED = "m.kind = 'ignore' AND m.outcome LIKE 'ignored%'";
const INCLUDED = `((${IGNORED}) OR ${TOPIC} IS NOT NULL)`;

/** Read model across all persisted history, never just the current UI page.
 * @implements SPEC-MAIL-TOPIC-GROUPS-001
 */
export class MailIgnoreGroupsRepo {
  constructor(private readonly db: Database.Database) {
    db.function("mail_topic_key", { deterministic: true }, (sender, subject) => mailTopic(String(sender), String(subject))?.id ?? null);
    db.function("mail_topic_label", { deterministic: true }, (sender, subject) => mailTopic(String(sender), String(subject))?.label ?? null);
  }

  list(offset: number, limit = 51): IgnoreGroup[] {
    const rows = this.db.prepare(`SELECT ${GROUP_KEY} AS id, COUNT(*) AS count,
      MIN(m.from_address) AS sender, MIN(m.subject) AS subject, MAX(m.received_at) AS lastReceived,
      MIN(e.features) AS features, MIN(mail_topic_label(m.from_address, m.subject)) AS topicLabel,
      COUNT(DISTINCT m.from_address) AS senderCount ${FROM} WHERE ${INCLUDED}
      GROUP BY ${GROUP_KEY} ORDER BY count DESC, lastReceived DESC, id ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as (Omit<IgnoreGroup, "state" | "ruleId"> & { features: string | null; topicLabel: string | null; senderCount: number })[];
    return rows.map(({ features, topicLabel, senderCount, ...row }) => {
      if (topicLabel) return { ...row, subject: topicLabel, sender: senderCount > 1 ? "複数の送信元" : row.sender, state: "topic", ruleId: null };
      if (!features) return { ...row, sender: "", subject: "", state: row.id, ruleId: null };
      const when: Condition = { op: "and", clauses: Object.entries(JSON.parse(features) as FeatureMap)
        .map(([feature, value]) => ({ op: "cmp", feature, cmp: "==", value })) };
      const rule = this.db.prepare("SELECT id, state FROM blackbox_rules WHERE domain = ? AND fingerprint = ? LIMIT 1")
        .get("mail.bulk-ignore", ruleFingerprint(when, "ignore")) as { id: string; state: string } | undefined;
      return { ...row, state: rule?.state ?? "candidate", ruleId: rule?.id ?? null };
    });
  }

  messages(group: string, offset: number, limit = 51, kind?: MailKind): MailMessageRow[] {
    return this.db.prepare(`SELECT m.* ${FROM} WHERE ${INCLUDED} AND ${GROUP_KEY} = ? AND (? IS NULL OR m.kind = ?)
      ORDER BY m.received_at DESC, m.message_id DESC LIMIT ? OFFSET ?`).all(group, kind ?? null, kind ?? null, limit, offset) as MailMessageRow[];
  }
}
