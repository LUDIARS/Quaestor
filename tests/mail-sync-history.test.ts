import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailHistoryPage, MailMessage, MailSource } from "@ludiars/mail-inbox";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboundDocumentsRepo } from "../src/db/inbound-documents-repo.js";
import { MailMessagesRepo } from "../src/db/mail-messages-repo.js";
import { MailWatchStateRepo } from "../src/db/mail-watch-state-repo.js";
import { ReceiptsRepo } from "../src/db/receipts-repo.js";
import { ReconciliationsRepo } from "../src/db/reconciliations-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import { MailIntakeService } from "../src/services/mail-intake-service.js";
import type { NotificationService } from "../src/services/notification-service.js";
import { ReceiptIntake } from "../src/services/receipt-intake.js";

describe("MailIntakeService.syncFromHistory", () => {
  let db: Database.Database;
  let documentsRoot: string;
  let messages: MailMessagesRepo;
  let watchState: MailWatchStateRepo;
  let source: FakeSource;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    documentsRoot = mkdtempSync(join(tmpdir(), "quaestor-mail-sync-"));
    messages = new MailMessagesRepo(db);
    watchState = new MailWatchStateRepo(db);
    source = fakeSource();
  });

  afterEach(() => {
    db.close();
    rmSync(documentsRoot, { recursive: true, force: true });
  });

  it("returns disabled with a reason when realtime is off", async () => {
    const service = createService({ realtimeEnabled: false });

    expect(await service.syncFromHistory()).toMatchObject({
      disabled: true,
      reason: "mailIntake.realtime.enabled=false",
    });
    expect(source.history).not.toHaveBeenCalled();
  });

  it("only records the baseline history id on the first run", async () => {
    const result = await createService().syncFromHistory();

    expect(result).toMatchObject({ initialized: true, fell_back: false, history_id: "1000" });
    expect(watchState.get()?.history_id).toBe("1000");
    expect(source.history).not.toHaveBeenCalled();
    expect(messages.list()).toEqual([]);
  });

  it("processes only added messages and advances the baseline", async () => {
    watchState.setHistoryId("900");
    source.page = {
      changes: [
        { messageId: "cloud-1", type: "added" },
        { messageId: "cloud-1", type: "added" },
        { messageId: "cloud-2", type: "labelAdded" },
      ],
      historyId: "1000",
      expired: false,
    };

    const result = await createService().syncFromHistory();

    expect(result).toMatchObject({ fetched: 1, initialized: false, fell_back: false, history_id: "1000" });
    expect(result.processed.cloud_notice).toBe(1);
    expect(source.get).toHaveBeenCalledTimes(1);
    expect(watchState.get()?.history_id).toBe("1000");
  });

  it("keeps the old baseline when a message fetch fails so the message can be retried", async () => {
    watchState.setHistoryId("900");
    source.page = {
      changes: [{ messageId: "transient", type: "added" }],
      historyId: "1000",
      expired: false,
    };
    source.get = vi.fn(async () => { throw new Error("temporary failure"); });

    const result = await createService().syncFromHistory();

    expect(result.history_id).toBe("900");
    expect(result.errors).toHaveLength(1);
    expect(watchState.get()?.history_id).toBe("900");
  });

  it("falls back to a full sweep and re-anchors the baseline when the history expired", async () => {
    watchState.setHistoryId("900");
    source.page = { changes: [], historyId: "900", expired: true };

    const result = await createService().syncFromHistory();

    expect(result.fell_back).toBe(true);
    expect(result.history_id).toBe("1000");
    expect(source.search).toHaveBeenCalledTimes(1);
    expect(result.processed.cloud_notice).toBe(1);
    expect(watchState.get()?.history_id).toBe("1000");
  });

  it("serialises concurrent calls so the baseline cannot move backwards", async () => {
    watchState.setHistoryId("900");
    const observed: string[] = [];
    source.onHistory = (startHistoryId) => {
      observed.push(startHistoryId);
      source.page = { changes: [], historyId: String(Number(startHistoryId) + 10), expired: false };
    };

    const service = createService();
    await Promise.all([service.syncFromHistory(), service.syncFromHistory(), service.syncFromHistory()]);

    // 直列化されていれば 2 回目以降は前回書いた history_id を読む。
    expect(observed).toEqual(["900", "910", "920"]);
    expect(watchState.get()?.history_id).toBe("930");
  });

  function createService(opts: { realtimeEnabled?: boolean } = {}): MailIntakeService {
    const receipts = new ReceiptsRepo(db);
    return new MailIntakeService({
      source,
      watchState,
      messages,
      documents: new InboundDocumentsRepo(db),
      receipts,
      intake: new ReceiptIntake({ db, receipts, reconciliations: new ReconciliationsRepo(db) }),
      notifications: {
        notifyMailInvoice: vi.fn(async () => ({ sent: true })),
        notifyMailCloudNotice: vi.fn(async () => ({ sent: true })),
      } as unknown as NotificationService,
      config: {
        enabled: true,
        query: "in:inbox",
        documentsRoot,
        maxAttachmentBytes: 1024,
        rules: [{ kind: "cloud_notice", fromDomains: ["cloud.example"] }],
        realtime: {
          enabled: opts.realtimeEnabled ?? true,
          topicName: "projects/p/topics/t",
          subscriptionName: "projects/p/subscriptions/s",
          labelIds: ["INBOX"],
          repoAllowlist: [],
        },
      },
    });
  }
});

interface FakeSource extends MailSource {
  page: MailHistoryPage;
  onHistory?: (startHistoryId: string) => void;
}

function cloudMessage(id: string): MailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    from: { address: "alerts@cloud.example" },
    to: ["me@example.test"],
    subject: "Cloud billing alert",
    date: new Date("2026-09-04T00:00:00Z"),
    text: "body",
    snippet: "snippet",
    labelIds: ["INBOX"],
    attachments: [],
    headers: {},
  };
}

function fakeSource(): FakeSource {
  const source = {
    page: { changes: [], historyId: "1000", expired: false } as MailHistoryPage,
    onHistory: undefined as ((startHistoryId: string) => void) | undefined,
    search: vi.fn(async () => [cloudMessage("cloud-1")]),
    get: vi.fn(async (id: string) => cloudMessage(id)),
    loadAttachment: vi.fn(async () => Buffer.from("pdf")),
    history: vi.fn(async (startHistoryId: string) => {
      source.onHistory?.(startHistoryId);
      return source.page;
    }),
    watch: vi.fn(async () => ({ historyId: "1000", expiration: new Date("2026-09-11T00:00:00Z") })),
    stopWatch: vi.fn(async () => { /* not used here */ }),
    currentHistoryId: vi.fn(async () => "1000"),
  };
  return source as unknown as FakeSource;
}
