/** Versioned, reviewed data for deterministic bulk-ignore mining. No sender-wide rules. */
export const IGNORE_POLICY = {
  version: "mail-ignore-v1",
  minimumMessages: 5,
  maximumBodyChars: 128_000,
  maximumStructureParts: 4096,
  protectedTerms: ["請求", "領収", "支払", "決済", "返金", "注文", "購入", "契約", "税", "認証", "確認コード", "セキュリティ", "パスワード",
    "invoice", "receipt", "billing", "payment", "refund", "purchase", "order", "security", "verification", "password", "sign-in", "login", "otp"],
} as const;
