import type { MailRecoveryJobsRepo } from "../db/mail-recovery-jobs-repo.js";
import type { MailRecoveryGate } from "./mail-recovery-gate.js";
import { GmailRateLimit } from "./gmail-rate-limit.js";
import { emptyCounts, recoverWindow, WINDOW_START, WINDOW_END,
  type RecoveryJob, type RecoveryRequest, type RecoveryWindowDeps } from "./mail-recovery-window.js";

interface RecoveryDeps extends RecoveryWindowDeps {
  jobs: MailRecoveryJobsRepo;
  gate: MailRecoveryGate;
  ready: () => boolean;
  crawlerStatus: () => { lastError: string | null; nextAt: number };
  connectionRevision: () => string;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

export class MailRecoveryService {
  private dryRun?: { id: string; revision: string };
  constructor(private readonly deps: RecoveryDeps) {}

  status(id: string): RecoveryJob | undefined { return this.deps.jobs.get(id); }

  start(request: RecoveryRequest): RecoveryJob {
    const { jobs, gate } = this.deps;
    const existing = jobs.get(request.request_id);
    if (existing) {
      if (existing.mode !== request.mode || existing.dry_run_id !== request.dry_run_id) throw new Error("request_conflict");
      return existing;
    }
    if (!this.deps.ready()) throw new Error("recovery_unavailable");
    const crawler = this.deps.crawlerStatus();
    const crawlerRetryAt = /^gmail_(?:0|403|429)_/.test(crawler.lastError ?? "") ? crawler.nextAt : 0;
    const retryAt = Math.max(crawlerRetryAt, jobs.providerRetryAt());
    if (retryAt > Date.now()) throw new GmailRateLimit(retryAt, 0, "cooldown");
    const revision = this.deps.connectionRevision();
    if (request.mode === "import_missing" && (!this.dryRun || this.dryRun.id !== request.dry_run_id
      || this.dryRun.revision !== revision)) throw new Error("completed_dry_run_required");
    const job: RecoveryJob = { ...request, startUtc: WINDOW_START, endUtc: WINDOW_END,
      phase: "scanning", exhausted: false, retryAt: null, counts: emptyCounts() };
    const lease = gate.acquire();
    try { jobs.insert(job); }
    catch (error) { lease.release(); throw error; }
    if (request.mode === "dry_run") this.dryRun = undefined;
    void this.run(job, revision, lease.signal).catch(() => {
      // The aggregate record could not be finalized. Never log a provider/SQLite payload.
      this.deps.logger?.warn({ event: "mail_recovery_status_failed" }, "mail recovery status write failed");
    }).finally(lease.release);
    return job;
  }

  private async run(job: RecoveryJob, revision: string, signal: AbortSignal): Promise<void> {
    const save = () => this.deps.jobs.save(job);
    const check = () => {
      if (this.deps.connectionRevision() !== revision) throw new Error("gmail_connection_changed");
    };
    try {
      await recoverWindow(this.deps, job, signal, check, save);
      check();
    } catch {
      job.phase = signal.aborted ? "interrupted" : "partial";
      if (!signal.aborted) job.counts.failures++;
    }
    if (job.phase !== "partial") job.retryAt = null;
    save();
    if (job.mode === "dry_run" && job.phase === "finished" && job.exhausted) {
      this.dryRun = { id: job.request_id, revision };
    }
  }
}
