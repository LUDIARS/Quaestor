import { describe, expect, it } from "vitest";
import { classifyMail } from "../src/mail/classify.js";
import { loadAppConfig } from "../src/services/app-config.js";

describe("classifyMail", () => {
  it("uses the first matching rule", () => {
    const result = classifyMail(
      { from: { address: "billing@amazon.com" }, subject: "Invoice", attachments: [] },
      [
        { kind: "cloud_notice", fromDomains: ["amazon.com"] },
        { kind: "invoice", subjectAny: ["Invoice"] },
      ],
    );
    expect(result).toEqual({ kind: "cloud_notice", ruleIndex: 0 });
  });

  it("does not treat a domain suffix without a label boundary as trusted", () => {
    const result = classifyMail(
      { from: { address: "billing@evilamazon.com" }, subject: "Invoice", attachments: [] },
      [{ kind: "cloud_notice", fromDomains: ["amazon.com"] }],
    );
    expect(result).toEqual({ kind: "ignore", ruleIndex: null });
  });

  it("matches MIME types case-insensitively", () => {
    const result = classifyMail(
      {
        from: { address: "billing@example.com" },
        subject: "Invoice",
        attachments: [{
          filename: "invoice.pdf",
          mimeType: "Application/PDF",
          size: 1,
          attachmentId: "a-1",
        }],
      },
      [{ kind: "invoice", attachmentMime: ["application/pdf"] }],
    );
    expect(result.kind).toBe("invoice");
  });
});

/**
 * 出荷している分類ルール (quaestor.config.json) の並びを固定する。
 * GitHub 通知は請求書ルールより前に置かないと、 PDF 添付付きの通知が invoice に落ちる。
 */
describe("shipped mail rules", () => {
  const rules = loadAppConfig().mailIntake.rules;

  it("classifies an Actions failure notice as ci_failure", () => {
    expect(classifyMail(
      {
        from: { address: "notifications@github.com" },
        subject: "[LUDIARS/Quaestor] Run failed: CI - main (a1b2c3d)",
        attachments: [],
      },
      rules,
    )).toMatchObject({ kind: "ci_failure" });
  });

  it("classifies a Dependabot alert as dependabot", () => {
    expect(classifyMail(
      {
        from: { address: "notifications@github.com" },
        subject: "[LUDIARS/Quaestor] Dependabot alert: lodash",
        attachments: [],
      },
      rules,
    )).toMatchObject({ kind: "dependabot" });
  });

  it("puts the GitHub rules before the invoice rules", () => {
    const firstInvoice = rules.findIndex((rule) => rule.kind === "invoice");
    const lastGithub = Math.max(
      rules.findIndex((rule) => rule.kind === "ci_failure"),
      rules.findIndex((rule) => rule.kind === "dependabot"),
    );
    expect(lastGithub).toBeGreaterThanOrEqual(0);
    expect(lastGithub).toBeLessThan(firstInvoice);
  });
});
