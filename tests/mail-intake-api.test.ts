import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInboundDocumentPath, resolveStoredDocumentPath } from "../src/api/mail-intake.js";

describe("mail intake document paths", () => {
  it("accepts descendants and rejects sibling-prefix and parent traversal paths", () => {
    const root = resolve("app_data", "inbound");
    expect(resolveStoredDocumentPath(root, join("2026", "09", "invoice.pdf")))
      .toBe(join(root, "2026", "09", "invoice.pdf"));
    expect(resolveStoredDocumentPath(root, join("..", "inbound-private", "secret.pdf"))).toBeNull();
    expect(resolveStoredDocumentPath(root, join("..", "secret.pdf"))).toBeNull();
  });
});

describe("mixed-source inbound document paths", () => {
  it("resolves mail and scan documents against their respective storage roots", () => {
    const documentsRoot = resolve("app_data", "inbound");
    const receiptsRoot = resolve("app_data", "receipts");
    const receiptStorage = {
      resolve: (storedPath: string) => {
        const resolved = resolveStoredDocumentPath(receiptsRoot, storedPath);
        if (!resolved) throw new Error("outside receipt storage");
        return resolved;
      },
    };

    expect(resolveInboundDocumentPath(documentsRoot, receiptStorage, {
      source: "mail", file_path: join("2026", "09", "invoice.pdf"),
    })).toBe(join(documentsRoot, "2026", "09", "invoice.pdf"));
    expect(resolveInboundDocumentPath(documentsRoot, receiptStorage, {
      source: "scan", file_path: join("2026", "09", "invoice.jpg"),
    })).toBe(join(receiptsRoot, "2026", "09", "invoice.jpg"));
    expect(resolveInboundDocumentPath(documentsRoot, receiptStorage, {
      source: "scan", file_path: join("..", "private", "invoice.jpg"),
    })).toBeNull();
  });
});
