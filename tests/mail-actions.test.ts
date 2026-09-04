import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage } from "@ludiars/mail-inbox";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailActionThrottleRepo } from "../src/db/mail-action-throttle-repo.js";
import { applyMigrations } from "../src/db/schema.js";
import { jstDay, MailActions, type DelegationInvocation } from "../src/services/mail-actions.js";
import type { MailActionNotice } from "../src/services/mail-notices.js";

const NOW = Math.floor(Date.parse("2026-09-04T03:00:00Z") / 1000);
const HOUR = 3600;

describe("MailActions", () => {
  let db: Database.Database;
  let throttle: MailActionThrottleRepo;
  let logDir: string;
  let notify: ReturnType<typeof vi.fn>;
  let invoke: ReturnType<typeof vi.fn>;
  let now: number;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    throttle = new MailActionThrottleRepo(db);
    logDir = mkdtempSync(join(tmpdir(), "quaestor-mail-actions-"));
    notify = vi.fn(async () => ({ sent: true }));
    invoke = vi.fn(async () => ({ runId: "run-1" }));
    now = NOW;
  });

  afterEach(() => {
    db.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  it("invokes the fix template once per head sha and never again for the same commit", async () => {
    const actions = createActions();

    const first = await actions.handle(ciFailureMessage("message-1"), "ci_failure");
    now += 7 * HOUR; // 6 時間の間隔制限は越えているが head_sha は同じ
    const second = await actions.handle(ciFailureMessage("message-2"), "ci_failure");

    expect(first).toMatchObject({ invoked: true, skipped: null, runId: "run-1" });
    expect(second).toMatchObject({ invoked: false, skipped: "throttled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    const invocation = invoke.mock.calls[0]![0] as DelegationInvocation;
    expect(invocation.callName).toBe("ci-failure-fix");
    expect(invocation.args).toMatchObject({
      repo: "LUDIARS/Quaestor",
      workflow: "CI",
      run_id: "98765",
      head_sha: "a1b2c3d",
    });
    expect(readFileSync(invocation.args.failed_log_path!, "utf8")).toContain("assertion failed");
  });

  it("notifies Discord with skipped: throttled even when it does not invoke", async () => {
    const actions = createActions();

    await actions.handle(ciFailureMessage("message-1"), "ci_failure");
    await actions.handle(ciFailureMessage("message-2"), "ci_failure");

    expect(notify).toHaveBeenCalledTimes(2);
    const [firstNotice, secondNotice] = notify.mock.calls.map((call) => call[0] as MailActionNotice);
    expect(firstNotice).toMatchObject({ kind: "ci_failure", repo: "LUDIARS/Quaestor", skipped: null });
    expect(secondNotice).toMatchObject({ skipped: "throttled" });
  });

  it("serialises throttle checks so concurrent notices invoke only once", async () => {
    let releaseInvoke = (): void => undefined;
    let markInvokeStarted = (): void => undefined;
    const invokeStarted = new Promise<void>((resolve) => { markInvokeStarted = resolve; });
    const invokeGate = new Promise<void>((resolve) => { releaseInvoke = resolve; });
    invoke.mockImplementation(async () => {
      markInvokeStarted();
      await invokeGate;
      return { runId: "run-1" };
    });
    const actions = createActions();

    const first = actions.handle(ciFailureMessage("message-1"), "ci_failure");
    await invokeStarted;
    const second = actions.handle(ciFailureMessage("message-2"), "ci_failure");
    releaseInvoke();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result.invoked)).toHaveLength(1);
    expect(results.filter((result) => result.skipped === "throttled")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a different head sha within the (repo, workflow) interval and daily limits", async () => {
    const actions = createActions();

    await actions.handle(ciFailureMessage("message-1", { headSha: "aaaaaaa" }), "ci_failure");
    now += HOUR; // 6 時間未満
    const tooSoon = await actions.handle(ciFailureMessage("message-2", { headSha: "bbbbbbb" }), "ci_failure");
    now += 6 * HOUR;
    const later = await actions.handle(ciFailureMessage("message-3", { headSha: "ccccccc" }), "ci_failure");

    expect(tooSoon).toMatchObject({ invoked: false, skipped: "throttled" });
    expect(later.invoked).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not invoke for repositories outside the allowlist", async () => {
    const actions = createActions({ repoAllowlist: ["LUDIARS/*"] });

    const result = await actions.handle(
      ciFailureMessage("message-1", { repo: "outsider/Repo" }),
      "ci_failure",
    );

    expect(result).toMatchObject({ invoked: false, skipped: "repo_not_allowed" });
    expect(invoke).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated and path-like repository notifications", async () => {
    const unauthenticated = ciFailureMessage("message-1");
    delete unauthenticated.headers["Authentication-Results"];

    expect(await createActions().handle(unauthenticated, "ci_failure"))
      .toMatchObject({ invoked: false, skipped: "unauthenticated_sender" });
    expect(await createActions().handle(dependabotMessage("message-2", "LUDIARS/.."), "dependabot"))
      .toMatchObject({ invoked: false, skipped: "repo_not_allowed" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports whether the action notification was actually sent", async () => {
    notify.mockResolvedValue({ sent: false, reason: "delivery failed" });

    const result = await createActions().handle(ciFailureMessage("message-1"), "ci_failure");

    expect(result).toMatchObject({ invoked: true, notified: false });
    expect(result.outcome).toContain("notification_failed");
  });

  it("skips the invoke when the failed log cannot be fetched", async () => {
    const actions = createActions({ fetchFailedLog: async () => null });

    expect(await actions.handle(ciFailureMessage("message-1"), "ci_failure"))
      .toMatchObject({ invoked: false, skipped: "log_unavailable" });
    expect(invoke).not.toHaveBeenCalled();
    expect(throttle.get("ci_failure:sha:LUDIARS/Quaestor:CI:a1b2c3d")).toBeUndefined();
  });

  it("runs the repository deps sweep at most once per day per repository", async () => {
    const actions = createActions();

    const first = await actions.handle(dependabotMessage("message-1"), "dependabot");
    now += 20 * HOUR;
    const sameWindow = await actions.handle(dependabotMessage("message-2"), "dependabot");
    now += 12 * HOUR; // 24 時間超、 かつ別日
    const nextDay = await actions.handle(dependabotMessage("message-3"), "dependabot");

    expect(first).toMatchObject({ invoked: true });
    expect(sameWindow).toMatchObject({ invoked: false, skipped: "throttled" });
    expect(nextDay.invoked).toBe(true);
    expect(invoke.mock.calls.map((call) => (call[0] as DelegationInvocation).callName))
      .toEqual(["deps-sweep-repo", "deps-sweep-repo"]);
  });

  it("reports disabled instead of invoking when realtime is off", async () => {
    const actions = createActions({ enabled: false });

    expect(await actions.handle(ciFailureMessage("message-1"), "ci_failure"))
      .toMatchObject({ invoked: false, skipped: "disabled" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  function createActions(opts: {
    enabled?: boolean;
    repoAllowlist?: string[];
    fetchFailedLog?: () => Promise<string | null>;
  } = {}): MailActions {
    return new MailActions({
      throttle,
      notify,
      invoke,
      fetchFailedLog: opts.fetchFailedLog ?? (async () => "assertion failed at foo.test.ts"),
      now: () => now,
      config: {
        enabled: opts.enabled ?? true,
        repoAllowlist: opts.repoAllowlist ?? ["LUDIARS/*"],
        arsRoot: join(tmpdir(), "ars-root"),
        logDir,
      },
    });
  }
});

describe("jstDay", () => {
  it("rolls over at JST midnight rather than UTC midnight", () => {
    expect(jstDay(Math.floor(Date.parse("2026-09-04T14:59:00Z") / 1000))).toBe("2026-09-04");
    expect(jstDay(Math.floor(Date.parse("2026-09-04T15:01:00Z") / 1000))).toBe("2026-09-05");
  });
});

function ciFailureMessage(
  id: string,
  opts: { repo?: string; headSha?: string } = {},
): MailMessage {
  const repo = opts.repo ?? "LUDIARS/Quaestor";
  const [owner, name] = repo.split("/");
  const headSha = opts.headSha ?? "a1b2c3d";
  return {
    id,
    threadId: `thread-${id}`,
    from: { address: "notifications@github.com" },
    to: ["me@example.test"],
    subject: `[${repo}] Run failed: CI - main (${headSha})`,
    date: new Date("2026-09-04T03:00:00Z"),
    text: `https://github.com/${repo}/actions/runs/98765`,
    snippet: "snippet",
    labelIds: ["INBOX"],
    attachments: [],
    headers: {
      "List-ID": `${repo} <${name}.${owner}.github.com>`,
      "X-GitHub-Reason": "ci_activity",
      "Authentication-Results": "mx.google.com; dkim=pass header.d=github.com; dmarc=pass header.from=github.com",
    },
  };
}

function dependabotMessage(id: string, repo = "LUDIARS/Quaestor"): MailMessage {
  const [owner, name] = repo.split("/");
  return {
    ...ciFailureMessage(id, { repo }),
    subject: `[${repo}] Dependabot alert: lodash`,
    text: "",
    headers: {
      "List-ID": `${repo} <${name}.${owner}.github.com>`,
      "X-GitHub-Reason": "security_alert",
      "Authentication-Results": "mx.google.com; dkim=pass header.d=github.com; dmarc=pass header.from=github.com",
    },
  };
}
