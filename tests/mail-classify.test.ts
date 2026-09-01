import { describe, expect, it } from "vitest";
import { classifyMail } from "../src/mail/classify.js";

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
