import type { MailMessage } from "@ludiars/mail-inbox";
import type { MailKind } from "../db/mail-messages-repo.js";

export interface MailRule {
  kind: Exclude<MailKind, "ignore">;
  fromDomains?: string[];
  subjectAny?: string[];
  attachmentMime?: string[];
}

export interface MailClassification {
  kind: MailKind;
  ruleIndex: number | null;
}

/** @implements SPEC-MAIL-INTAKE-005 (spec/feature/mail-intake.md) */
export function classifyMail(
  message: Pick<MailMessage, "from" | "subject" | "attachments">,
  rules: MailRule[],
): MailClassification {
  const domain = message.from.address.split("@").pop()?.toLowerCase() ?? "";
  const subject = message.subject.toLowerCase();

  for (const [ruleIndex, rule] of rules.entries()) {
    const fromMatches = !rule.fromDomains
      || rule.fromDomains.some((candidate) => isSameDomainOrSubdomain(domain, candidate));
    const subjectMatches = !rule.subjectAny
      || rule.subjectAny.some((candidate) => subject.includes(candidate.toLowerCase()));
    const attachmentMatches = !rule.attachmentMime
      || message.attachments.some((attachment) => rule.attachmentMime?.some(
        (candidate) => attachment.mimeType.toLowerCase() === candidate.toLowerCase(),
      ));

    if (fromMatches && subjectMatches && attachmentMatches) {
      return { kind: rule.kind, ruleIndex };
    }
  }

  return { kind: "ignore", ruleIndex: null };
}

function isSameDomainOrSubdomain(actual: string, configured: string): boolean {
  const expected = configured.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return expected.length > 0 && (actual === expected || actual.endsWith(`.${expected}`));
}
