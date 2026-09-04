/**
 * CI 失敗 / Dependabot の通知メールを検知したあとの起動。
 *
 * 判断は決定的コードだけで行う (本文は読まない・要約もしない)。 材料はヘッダと件名、
 * および `gh run view --log-failed` が取ってくる失敗ログのファイルパスに限る。
 * 起動先は Concordia の delegation テンプレ (ci-failure-fix / deps-sweep-repo)。
 *
 * 同時実行数の上限は Concordia の admin.delegation_max_concurrency が持つので数え直さない。
 * ここが持つのは debounce だけ。 キューは実行を直列化するだけで投げた分は必ず走るため、
 * 壊れたワークフロー 1 本で委託枠を何時間も塞がないよう起動そのものを絞る。
 *
 * spec/feature/mail-realtime.md
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MailMessage } from "@ludiars/mail-inbox";
import type { MailActionThrottleRepo } from "../db/mail-action-throttle-repo.js";
import {
  isAllowedRepo,
  isAuthenticatedGithubNotice,
  isValidRepo,
  parseGithubNotice,
  type GithubNotice,
} from "../mail/github-notice.js";
import { resolveServiceBaseUrl } from "./excubitor-catalog.js";
import type { MailActionNotice } from "./mail-notices.js";
import type { NotifyResult } from "./notification-service.js";

export type MailActionKind = "ci_failure" | "dependabot";

/** 起動を見送った理由。 通知の `skipped:` にそのまま載る。 */
export type MailActionSkip =
  | "throttled"
  | "repo_not_allowed"
  | "repo_unknown"
  | "run_unknown"
  | "log_unavailable"
  | "invoke_failed"
  | "coordinator_unreachable"
  | "unauthenticated_sender"
  | "disabled";

export interface MailActionResult {
  kind: MailActionKind;
  repo: string | null;
  invoked: boolean;
  skipped: MailActionSkip | null;
  runId: string | null;
  notified: boolean;
  /** mail_messages.outcome に載せる短い文字列 */
  outcome: string;
}

export interface MailActionsConfig {
  enabled: boolean;
  /** ci_failure の起動対象リポジトリ (owner/name、 末尾 `/*` で owner 配下すべて) */
  repoAllowlist: string[];
  /** 委託先 worktree の親。 未指定なら env ARS_ROOT / プロセスの親ディレクトリ */
  arsRoot?: string;
  /** 失敗ログの保存先 (既定 app_data/mail-actions) */
  logDir?: string;
  /** ci_failure の (repo, workflow) あたりの最小間隔 (秒)。 既定 6 時間 */
  ciFailureIntervalSec?: number;
  /** ci_failure の (repo, workflow) あたりの 1 日の上限。 既定 3 回 */
  ciFailureDailyLimit?: number;
  /** dependabot の同一リポあたりの最小間隔 (秒)。 既定 24 時間 */
  dependabotIntervalSec?: number;
}

export interface DelegationInvocation {
  callName: string;
  args: Record<string, string>;
}

export interface MailActionsDeps {
  throttle: MailActionThrottleRepo;
  notify: (notice: MailActionNotice) => Promise<NotifyResult>;
  config: MailActionsConfig;
  /** delegation 起動。 既定は Excubitor catalog で解決した Concordia の loopback API */
  invoke?: (invocation: DelegationInvocation) => Promise<{ runId: string | null }>;
  /** 失敗ログの取得。 既定は `gh run view --log-failed`。 取れなければ null */
  fetchFailedLog?: (input: { repo: string; runId: string }) => Promise<string | null>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const HOUR_SEC = 3600;
const DEFAULTS = {
  logDir: "app_data/mail-actions",
  ciFailureIntervalSec: 6 * HOUR_SEC,
  ciFailureDailyLimit: 3,
  dependabotIntervalSec: 24 * HOUR_SEC,
};
const GH_TIMEOUT_MS = 120_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export class MailActions {
  /** throttle の確認から記録までを直列化し、同一プロセス内の二重起動を防ぐ。 */
  private actionChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MailActionsDeps) {}

  /**
   * 1 通の通知メールを処理する。 起動しなかった場合も必ず Discord へ通知する。
   *
   * @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-007 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-008 (spec/feature/mail-realtime.md)
   * @implements SPEC-MAIL-REALTIME-009 (spec/feature/mail-realtime.md)
   */
  async handle(message: MailMessage, kind: MailActionKind): Promise<MailActionResult> {
    const notice = parseGithubNotice(message);
    const decided = !this.deps.config.enabled
      ? { invoked: false, skipped: "disabled" as MailActionSkip, runId: null }
      : !isAuthenticatedGithubNotice(message)
        ? { invoked: false, skipped: "unauthenticated_sender" as MailActionSkip, runId: null }
        : await this.runSerially(kind, notice);

    const notification = await this.deps.notify({
      messageId: message.id,
      kind,
      subject: message.subject,
      receivedAt: Math.floor(message.date.getTime() / 1000),
      repo: notice.repo,
      workflow: notice.workflow,
      headSha: notice.headSha,
      runUrl: notice.runUrl,
      runId: decided.runId,
      skipped: decided.skipped,
    });

    const actionOutcome = decided.skipped
      ? `${kind}; skipped: ${decided.skipped}`
      : `${kind}; invoked`;

    return {
      kind,
      repo: notice.repo,
      invoked: decided.invoked,
      skipped: decided.skipped,
      runId: decided.runId,
      notified: notification.sent,
      outcome: notification.sent ? actionOutcome : `${actionOutcome}; notification_failed`,
    };
  }

  private runSerially(
    kind: MailActionKind,
    notice: GithubNotice,
  ): Promise<{ invoked: boolean; skipped: MailActionSkip | null; runId: string | null }> {
    const next = this.actionChain.then(() => this.run(kind, notice));
    this.actionChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async run(
    kind: MailActionKind,
    notice: GithubNotice,
  ): Promise<{ invoked: boolean; skipped: MailActionSkip | null; runId: string | null }> {
    const repo = notice.repo;
    if (!repo) return skip("repo_unknown");
    if (!isAllowedRepo(repo, this.deps.config.repoAllowlist)) return skip("repo_not_allowed");
    return kind === "ci_failure" ? this.runCiFailure(repo, notice) : this.runDependabot(repo);
  }

  /** @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md) */
  private async runCiFailure(
    repo: string,
    notice: GithubNotice,
  ): Promise<{ invoked: boolean; skipped: MailActionSkip | null; runId: string | null }> {
    const workflow = notice.workflow ?? "unknown";
    const headSha = notice.headSha;
    const runId = notice.runId;
    if (!runId || !headSha) return skip("run_unknown");

    const now = this.now();
    const day = jstDay(now);
    // (1) head_sha 単位で 1 回きり。 再実行や連続失敗で同じコミットに何度も PR を出さない。
    const shaKey = `ci_failure:sha:${repo}:${workflow}:${headSha}`;
    if (this.deps.throttle.get(shaKey)) return skip("throttled");
    // (2) 同じ (repo, workflow) は 6 時間に 1 回・ 1 日 3 回まで。
    const rateKey = `ci_failure:rate:${repo}:${workflow}`;
    const rate = this.deps.throttle.get(rateKey);
    const interval = this.deps.config.ciFailureIntervalSec ?? DEFAULTS.ciFailureIntervalSec;
    const dailyLimit = this.deps.config.ciFailureDailyLimit ?? DEFAULTS.ciFailureDailyLimit;
    if (rate && now - rate.last_fired_at < interval) return skip("throttled");
    if (this.deps.throttle.firedToday(rateKey, day) >= dailyLimit) return skip("throttled");

    const logPath = await this.storeFailedLog(repo, runId);
    if (!logPath) return skip("log_unavailable");

    const invoked = await this.invoke({
      callName: "ci-failure-fix",
      args: {
        repo,
        workflow,
        run_id: runId,
        head_sha: headSha,
        failed_log_path: logPath,
        target_repo: repositoryPath(repo, this.deps.config.arsRoot),
      },
    });
    if (!invoked.ok) return skip(invoked.skipped);

    this.deps.throttle.record(shaKey, now, day);
    this.deps.throttle.record(rateKey, now, day);
    return { invoked: true, skipped: null, runId: invoked.runId };
  }

  /** @implements SPEC-MAIL-REALTIME-008 (spec/feature/mail-realtime.md) */
  private async runDependabot(
    repo: string,
  ): Promise<{ invoked: boolean; skipped: MailActionSkip | null; runId: string | null }> {
    const now = this.now();
    const day = jstDay(now);
    const key = `dependabot:${repo}`;
    const previous = this.deps.throttle.get(key);
    const interval = this.deps.config.dependabotIntervalSec ?? DEFAULTS.dependabotIntervalSec;
    // 同一リポは 24 時間に 1 回。 同じ日に既に起動していれば日次 sweep との重複も避ける。
    if (previous && (now - previous.last_fired_at < interval || previous.day === day)) {
      return skip("throttled");
    }

    const invoked = await this.invoke({
      callName: "deps-sweep-repo",
      args: { target_repo: repositoryPath(repo, this.deps.config.arsRoot) },
    });
    if (!invoked.ok) return skip(invoked.skipped);

    this.deps.throttle.record(key, now, day);
    return { invoked: true, skipped: null, runId: invoked.runId };
  }

  private async invoke(
    invocation: DelegationInvocation,
  ): Promise<{ ok: true; runId: string | null } | { ok: false; skipped: MailActionSkip }> {
    try {
      const custom = this.deps.invoke;
      const result = custom
        ? await custom(invocation)
        : await this.postInvoke(invocation);
      return { ok: true, runId: result.runId };
    } catch (error) {
      return { ok: false, skipped: invokeSkipOf(error) };
    }
  }

  /** Concordia の endpoint は Excubitor catalog から解決する (ポートを焼き付けない)。 */
  private async postInvoke(invocation: DelegationInvocation): Promise<{ runId: string | null }> {
    const baseUrl = resolveServiceBaseUrl("concordia", { envName: "CONCORDIA_URL" });
    if (!baseUrl) throw new UnreachableCoordinatorError();
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${baseUrl}/v1/delegation/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        call_name: invocation.callName,
        args: invocation.args,
        spawn: true,
        triggered_by: "quaestor-mail-intake",
      }),
    });
    if (!res.ok) throw new Error(`invoke failed: HTTP ${res.status}`);
    const body = await res.json().catch(() => null) as { run?: { id?: string } } | null;
    return { runId: body?.run?.id ?? null };
  }

  /**
   * 失敗ログを決定的コードで取得してファイルへ落とす。 委託にはこのパスだけを渡す
   * (長いログをプロンプトへ貼らない、 メール本文は渡さない)。
   */
  private async storeFailedLog(repo: string, runId: string): Promise<string | null> {
    const log = this.deps.fetchFailedLog
      ? await this.deps.fetchFailedLog({ repo, runId }).catch(() => null)
      : await runGhFailedLog(repo, runId);
    if (!log) return null;
    const dir = this.deps.config.logDir ?? DEFAULTS.logDir;
    const path = join(dir, `ci-failure-${repo.replace(/[^\w.-]+/g, "_")}-${runId}.log`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, log.slice(0, MAX_LOG_BYTES), "utf8");
    return path;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }
}

class UnreachableCoordinatorError extends Error {
  constructor() {
    super("delegation endpoint is not declared in the Excubitor catalog");
    this.name = "UnreachableCoordinatorError";
  }
}

function invokeSkipOf(error: unknown): MailActionSkip {
  return error instanceof UnreachableCoordinatorError ? "coordinator_unreachable" : "invoke_failed";
}

function skip(reason: MailActionSkip): { invoked: false; skipped: MailActionSkip; runId: null } {
  return { invoked: false, skipped: reason, runId: null };
}

/** 委託の作業ディレクトリ。 owner/name の name 側だけを ${ARS_ROOT} の下に並べる規約。 */
export function repositoryPath(repo: string, arsRoot?: string): string {
  if (!isValidRepo(repo)) throw new RangeError("invalid GitHub repository name");
  const [, name] = repo.split("/");
  if (!name) throw new RangeError("invalid GitHub repository name");
  const root = resolve(arsRoot ?? process.env.ARS_ROOT ?? join(process.cwd(), ".."));
  const target = resolve(root, name);
  const relativeTarget = relative(root, target);
  if (relativeTarget === "" || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new RangeError("repository path escapes ARS_ROOT");
  }
  return target;
}

/** throttle の日次判定は JST 固定 (稼働マシンのタイムゾーン設定に依存させない)。 */
export function jstDay(epochSec: number): string {
  const jst = new Date((epochSec + 9 * HOUR_SEC) * 1000);
  return jst.toISOString().slice(0, 10);
}

/** `gh run view <run-id> --log-failed --repo <repo>` の stdout。 失敗したら null。 */
async function runGhFailedLog(repo: string, runId: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("gh", ["run", "view", runId, "--log-failed", "--repo", repo], {
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, GH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_LOG_BYTES) stdout += chunk.toString("utf8");
    });
    child.on("error", () => { finish(null); });
    child.on("close", (code) => { finish(code === 0 && stdout.trim() !== "" ? stdout : null); });
  });
}
