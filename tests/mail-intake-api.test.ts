import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStoredDocumentPath } from "../src/api/mail-intake.js";

describe("mail intake document paths", () => {
  it("accepts descendants and rejects sibling-prefix and parent traversal paths", () => {
    const root = resolve("app_data", "inbound");
    expect(resolveStoredDocumentPath(root, join("2026", "09", "invoice.pdf")))
      .toBe(join(root, "2026", "09", "invoice.pdf"));
    expect(resolveStoredDocumentPath(root, join("..", "inbound-private", "secret.pdf"))).toBeNull();
    expect(resolveStoredDocumentPath(root, join("..", "secret.pdf"))).toBeNull();
  });
});
