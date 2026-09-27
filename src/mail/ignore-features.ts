import { createHash } from "node:crypto";
import type { MailMessage } from "@ludiars/mail-inbox";
import type { FeatureMap } from "@ludiars/blackbox";
import { IGNORE_POLICY } from "./ignore-policy.js";

export interface IgnoreFeatures { fingerprint: string; features: FeatureMap }
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Content is read in memory; only hashed templates and structural signatures are persisted. */
export function ignoreFeatures(message: MailMessage): IgnoreFeatures | null {
  const body = message.html || message.text;
  if (!body || body.length > IGNORE_POLICY.maximumBodyChars || message.text.length > IGNORE_POLICY.maximumBodyChars
    || message.subject.length > 1000 || message.attachments.length) return null;
  const protectedText = `${message.subject}\n${message.text}\n${message.html ?? ""}`.normalize("NFKC").toLowerCase();
  // English terms use word boundaries: e.g. CSS "border" must not match "order".
  if (IGNORE_POLICY.protectedTerms.some((term) => /^[a-z-]+$/.test(term)
    ? new RegExp(`\\b${term}\\b`, "i").test(protectedText) : protectedText.includes(term))) return null;
  const sender = message.from.address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) return null;
  const subject = message.subject.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  if (subject.replace(/[\s#\W]/g, "").length < 3 && !/[\u3040-\u9fff]{3}/u.test(subject)) return null;
  const parts = message.html
    ? Array.from(message.html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi),
      (match) => `${match[0].startsWith("</") ? "/" : ""}${match[1]?.toLowerCase()}`)
    : message.text.trim().split(/\r?\n\s*\r?\n/).map((part) => {
      const lines = part.split(/\r?\n/).length;
      return `${Math.ceil(Math.log2(part.length + 1))}:${lines}:${/https?:\/\//i.test(part) ? "link" : "text"}`;
    });
  if (parts.length < 2 || parts.length > IGNORE_POLICY.maximumStructureParts) return null;
  const features: FeatureMap = { policy: IGNORE_POLICY.version, sender: hash(sender),
    subjectTemplate: hash(subject), bodyStructure: hash(`${message.html ? "html" : "text"}:${parts.join("|")}`) };
  return { features, fingerprint: hash(JSON.stringify(features)) };
}
