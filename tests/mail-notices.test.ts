import { describe, expect, it } from "vitest";
import { buildMailInvoiceNotice } from "../src/services/mail-notices.js";

describe("mail notices", () => {
  it("redacts URLs and bounds attacker-controlled Discord fields", () => {
    const built = buildMailInvoiceNotice({
      messageId: "message-1",
      from: "sender@example.com",
      subject: `View https://private.example/session ${"x".repeat(2000)}`,
      receivedAt: 1_788_192_000,
      outcome: "needs_review",
    });
    const subject = built.message.embeds?.[0]?.fields?.find((field) => field.name === "件名")?.value;
    expect(subject).not.toContain("private.example");
    expect(subject?.length).toBeLessThanOrEqual(1024);
  });
});
