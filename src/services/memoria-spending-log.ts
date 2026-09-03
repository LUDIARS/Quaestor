import type Database from "better-sqlite3";
import type { ApportionmentRulesRepo } from "../db/apportionment-rules-repo.js";
import type { ReceiptItem, ReceiptRow } from "../db/receipts-repo.js";
import type { TransactionRow } from "../shared/types.js";

export const SPENDING_LOG_PRIVACY_CLASS = "sensitive.financial_location" as const;

export type PurchaseCategory = "food" | "clothing" | "toy" | "undetermined";
export type PaymentKind =
  | "credit_card"
  | "bank"
  | "cash"
  | "digital_wallet"
  | "other"
  | "undetermined";

export interface SpendingLogItem {
  name: string;
  price: number;
  quantity: number | null;
  category: PurchaseCategory;
}

export interface SpendingLogRecord {
  id: string;
  privacy_class: typeof SPENDING_LOG_PRIVACY_CLASS;
  retention_scope: "local_only";
  llm_relay_scope: "diary_only";
  source_kind: "transaction" | "receipt";
  date: string;
  occurred_at: string | null;
  amount: number;
  currency: string;
  place: {
    name: string | null;
    google_place_id: null;
    google_maps_url: string | null;
    location: {
      latitude: number;
      longitude: number;
      accuracy_m: number | null;
    } | null;
  };
  payment: {
    kind: PaymentKind;
    label: string | null;
  };
  items: SpendingLogItem[];
  purchase_category: PurchaseCategory;
  expense: {
    planned: boolean | null;
    rate: number | null;
    rule_id: number | null;
  };
  source_refs: {
    transaction_id: string | null;
    receipt_ids: string[];
  };
  source_updated_at: string;
}

export interface DailySpendingSummary {
  date: string;
  currency: string;
  total_amount: number;
  places: Array<{
    name: string | null;
    google_maps_url: string | null;
    amount: number;
  }>;
}

export interface SpendingLogExport {
  schema_version: 1;
  privacy_class: typeof SPENDING_LOG_PRIVACY_CLASS;
  retention_scope: "local_only";
  llm_relay_scope: "diary_only";
  date_from: string;
  date_to: string;
  records: SpendingLogRecord[];
  daily_summaries: DailySpendingSummary[];
}

interface BuildOptions {
  dateFrom: string;
  dateTo: string;
}

type LinkedReceipt = ReceiptRow & { transaction_id: string };

export function buildMemoriaSpendingLog(
  db: Database.Database,
  rules: ApportionmentRulesRepo,
  options: BuildOptions,
): SpendingLogExport {
  const transactions = db.prepare(
    `SELECT * FROM transactions
     WHERE is_transfer = 0
       AND amount_out IS NOT NULL
       AND amount_out > 0
       AND date >= ?
       AND date <= ?
     ORDER BY date ASC, created_at ASC`,
  ).all(options.dateFrom, options.dateTo) as TransactionRow[];

  const linkedReceipts = db.prepare(
    `SELECT r.*, rc.transaction_id
     FROM receipts r
     JOIN reconciliations rc ON rc.receipt_id = r.id
     JOIN transactions t ON t.id = rc.transaction_id
     WHERE t.date >= ? AND t.date <= ?
     ORDER BY r.captured_at ASC`,
  ).all(options.dateFrom, options.dateTo) as LinkedReceipt[];

  const unmatchedReceipts = db.prepare(
    `SELECT r.*
     FROM receipts r
     WHERE r.committed_at IS NOT NULL
       AND r.doc_kind != 'statement'
       AND r.total IS NOT NULL
       AND r.total > 0
       AND r.date IS NOT NULL
       AND r.date >= ?
       AND r.date <= ?
       AND NOT EXISTS (
         SELECT 1 FROM reconciliations rc WHERE rc.receipt_id = r.id
       )
     ORDER BY r.date ASC, r.captured_at ASC`,
  ).all(options.dateFrom, options.dateTo) as ReceiptRow[];

  const receiptsByTransaction = new Map<string, ReceiptRow[]>();
  for (const receipt of linkedReceipts) {
    const current = receiptsByTransaction.get(receipt.transaction_id) ?? [];
    current.push(receipt);
    receiptsByTransaction.set(receipt.transaction_id, current);
  }

  const records: SpendingLogRecord[] = [];
  for (const transaction of transactions) {
    records.push(transactionRecord(transaction, receiptsByTransaction.get(transaction.id) ?? [], rules));
  }
  for (const receipt of unmatchedReceipts) {
    records.push(receiptRecord(receipt, rules));
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  return {
    schema_version: 1,
    privacy_class: SPENDING_LOG_PRIVACY_CLASS,
    retention_scope: "local_only",
    llm_relay_scope: "diary_only",
    date_from: options.dateFrom,
    date_to: options.dateTo,
    records,
    daily_summaries: summarizeByDay(records),
  };
}

function transactionRecord(
  transaction: TransactionRow,
  receipts: ReceiptRow[],
  rules: ApportionmentRulesRepo,
): SpendingLogRecord {
  const primaryReceipt = receipts.find((receipt) => parseLocation(receipt.geo) !== null) ?? receipts[0];
  const placeName = primaryReceipt?.payee ?? transaction.payee ?? transaction.description ?? null;
  const location = parseLocation(primaryReceipt?.geo ?? null);
  const items = receipts.flatMap((receipt) => parseItems(receipt.items));
  const resolved = rules.resolve(placeName);
  const updatedAt = Math.max(transaction.updated_at, ...receipts.map((receipt) => receipt.updated_at));

  return {
    id: `transaction:${transaction.id}`,
    privacy_class: SPENDING_LOG_PRIVACY_CLASS,
    retention_scope: "local_only",
    llm_relay_scope: "diary_only",
    source_kind: "transaction",
    date: transaction.date,
    occurred_at: primaryReceipt ? unixToIso(primaryReceipt.captured_at) : null,
    amount: transaction.amount_out ?? 0,
    currency: transaction.currency,
    place: buildPlace(placeName, location),
    payment: inferPayment(transaction),
    items,
    purchase_category: summarizeCategory(items),
    expense: expenseState(resolved),
    source_refs: {
      transaction_id: transaction.id,
      receipt_ids: receipts.map((receipt) => receipt.id),
    },
    source_updated_at: unixToIso(updatedAt),
  };
}

function receiptRecord(receipt: ReceiptRow, rules: ApportionmentRulesRepo): SpendingLogRecord {
  const location = parseLocation(receipt.geo);
  const items = parseItems(receipt.items);
  const resolved = rules.resolve(receipt.payee);
  return {
    id: `receipt:${receipt.id}`,
    privacy_class: SPENDING_LOG_PRIVACY_CLASS,
    retention_scope: "local_only",
    llm_relay_scope: "diary_only",
    source_kind: "receipt",
    date: receipt.date!,
    occurred_at: unixToIso(receipt.captured_at),
    amount: receipt.total!,
    currency: "JPY",
    place: buildPlace(receipt.payee, location),
    payment: { kind: "cash", label: "レシート（決済手段未連携）" },
    items,
    purchase_category: summarizeCategory(items),
    expense: expenseState(resolved),
    source_refs: {
      transaction_id: null,
      receipt_ids: [receipt.id],
    },
    source_updated_at: unixToIso(receipt.updated_at),
  };
}

function parseItems(raw: string | null): SpendingLogItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): SpendingLogItem[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Partial<ReceiptItem>;
      if (typeof item.name !== "string" || typeof item.price !== "number") return [];
      return [{
        name: item.name,
        price: item.price,
        quantity: typeof item.qty === "number" ? item.qty : null,
        category: classifyPurchase(item.name),
      }];
    });
  } catch {
    return [];
  }
}

export function classifyPurchase(name: string): PurchaseCategory {
  const normalized = name.normalize("NFKC").toLowerCase();
  if (/(食品|食料|飲料|お茶|茶葉|コーヒー|パン|弁当|惣菜|米|肉|魚|野菜|果物|菓子|チョコ|牛乳|卵|酒|ビール|ランチ|ディナー|food|drink|coffee|bread|lunch|dinner)/i.test(normalized)) {
    return "food";
  }
  if (/(衣料|衣類|洋服|シャツ|パンツ|スカート|ジャケット|コート|靴|シューズ|ソックス|靴下|帽子|clothing|shirt|pants|shoes)/i.test(normalized)) {
    return "clothing";
  }
  if (/(玩具|おもちゃ|フィギュア|模型|プラモデル|ぬいぐるみ|ボードゲーム|カードゲーム|toy|figure|model kit|board game)/i.test(normalized)) {
    return "toy";
  }
  return "undetermined";
}

function summarizeCategory(items: SpendingLogItem[]): PurchaseCategory {
  if (items.length === 0) return "undetermined";
  const known = new Set(items.map((item) => item.category).filter((category) => category !== "undetermined"));
  return known.size === 1 ? [...known][0]! : "undetermined";
}

function parseLocation(raw: string | null): {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const latitude = typeof parsed.lat === "number" ? parsed.lat : null;
    const longitude = typeof parsed.lon === "number" ? parsed.lon : null;
    if (latitude === null || longitude === null) return null;
    return {
      latitude,
      longitude,
      accuracy_m: typeof parsed.accuracy === "number" ? parsed.accuracy : null,
    };
  } catch {
    return null;
  }
}

function buildPlace(
  name: string | null,
  location: { latitude: number; longitude: number; accuracy_m: number | null } | null,
): SpendingLogRecord["place"] {
  const query = location ? `${location.latitude},${location.longitude}` : name?.trim();
  return {
    name,
    google_place_id: null,
    google_maps_url: query
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
      : null,
    location,
  };
}

function inferPayment(transaction: TransactionRow): SpendingLogRecord["payment"] {
  const haystack = [transaction.account, transaction.payee, transaction.description]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const wallet = detectWallet(haystack);
  if (wallet) return { kind: "digital_wallet", label: wallet };
  if (transaction.source === "credit-card") {
    return { kind: "credit_card", label: transaction.account };
  }
  if (transaction.source === "bank") {
    return { kind: "bank", label: transaction.account };
  }
  if (/現金|cash/i.test(haystack)) {
    return { kind: "cash", label: transaction.account ?? "現金" };
  }
  if (transaction.account) return { kind: "other", label: transaction.account };
  return { kind: "undetermined", label: null };
}

function detectWallet(value: string): string | null {
  const wallets: Array<[RegExp, string]> = [
    [/paypay/i, "PayPay"],
    [/楽天(?:pay|ペイ)/i, "楽天ペイ"],
    [/\bau\s*pay\b/i, "au PAY"],
    [/(?:^|\s)d払い(?:\s|$)/i, "d払い"],
    [/メルペイ/i, "メルペイ"],
    [/line\s*pay/i, "LINE Pay"],
    [/quicpay/i, "QUICPay"],
    [/(?:^|\s)iD(?:\s|$)/, "iD"],
    [/suica/i, "Suica"],
    [/pasmo/i, "PASMO"],
    [/nanaco/i, "nanaco"],
    [/waon/i, "WAON"],
    [/(?:楽天)?edy/i, "楽天Edy"],
  ];
  return wallets.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

function expenseState(resolved: ReturnType<ApportionmentRulesRepo["resolve"]>): SpendingLogRecord["expense"] {
  if (resolved.rule_id === null) {
    return { planned: null, rate: null, rule_id: null };
  }
  return {
    planned: resolved.rate > 0,
    rate: resolved.rate,
    rule_id: resolved.rule_id,
  };
}

function summarizeByDay(records: SpendingLogRecord[]): DailySpendingSummary[] {
  const groups = new Map<string, {
    date: string;
    currency: string;
    total: number;
    places: Map<string, { name: string | null; google_maps_url: string | null; amount: number }>;
  }>();
  for (const record of records) {
    const key = `${record.date}\u0000${record.currency}`;
    const group = groups.get(key) ?? {
      date: record.date,
      currency: record.currency,
      total: 0,
      places: new Map(),
    };
    group.total += record.amount;
    const placeKey = record.place.google_maps_url ?? record.place.name ?? "undetermined";
    const place = group.places.get(placeKey) ?? {
      name: record.place.name,
      google_maps_url: record.place.google_maps_url,
      amount: 0,
    };
    place.amount += record.amount;
    group.places.set(placeKey, place);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency))
    .map((group) => ({
      date: group.date,
      currency: group.currency,
      total_amount: group.total,
      places: [...group.places.values()].sort((a, b) => b.amount - a.amount),
    }));
}

function unixToIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
