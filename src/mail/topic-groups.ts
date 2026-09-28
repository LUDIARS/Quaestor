import { createHash } from "node:crypto";

/** Display-only grouping data; never used as an automatic ignore condition. */
export const MAIL_TOPIC_RULES = {
  githubDomain: "github.com",
  vPointSenders: ["mytc@tsite.jp"],
  vPointSubject: /v\s*ポイント|\bv[ -]?points?\b/i,
} as const;

export interface MailTopic { id: string; label: string }
function topic(key: string, label: string): MailTopic {
  return { id: `topic:${createHash("sha256").update(key).digest("hex")}`, label };
}

/** @implements SPEC-MAIL-TOPIC-GROUPS-001 */
export function mailTopic(sender: string, subject: string): MailTopic | null {
  const address = sender.trim().toLowerCase();
  const title = subject.normalize("NFKC").trim();
  if (address.endsWith(`@${MAIL_TOPIC_RULES.githubDomain}`)) {
    const withoutReply = title.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "");
    const repo = /^\[([\w.-]+\/[\w.-]+)\]/.exec(withoutReply)?.[1];
    if (repo && repo.split("/").every((part) => part !== "." && part !== "..")) {
      return topic(`github:${repo.toLowerCase()}`, `GitHub · ${repo}`);
    }
  }
  if (MAIL_TOPIC_RULES.vPointSenders.some((value) => value === address) || MAIL_TOPIC_RULES.vPointSubject.test(title)) {
    return topic("brand:v-point", "Vポイント");
  }
  // Preserve exact sender boundaries: do not combine unrelated users of shared mail domains.
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return topic(`sender:${address}`, `送信元 · ${address}`);
  return null;
}
