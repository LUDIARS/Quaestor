import type Database from "better-sqlite3";
import type { MailMessage } from "@ludiars/mail-inbox";
import { evaluate, makeSqliteBlackBox, ruleFingerprint, type BlackBox, type Condition } from "@ludiars/blackbox";
import { ignoreFeatures } from "../mail/ignore-features.js";
import { IGNORE_POLICY } from "../mail/ignore-policy.js";
import { MailIgnoreEvidenceRepo } from "../db/mail-ignore-evidence-repo.js";

const DOMAIN = "mail.bulk-ignore";

/** Deterministic mining adapter for the shared blackbox stores/evaluator. Never calls decide/LLM. */
export class MailIgnoreEngine {
  private readonly box: BlackBox;
  private readonly evidence: MailIgnoreEvidenceRepo;
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    this.box = makeSqliteBlackBox(db);
    this.evidence = new MailIgnoreEvidenceRepo(db);
  }

  pendingIds(limit: number): string[] {
    return this.evidence.pendingIds(limit);
  }

  rules(): { id: string; state: string; evidence: number }[] {
    const evidence = this.evidence.features();
    return this.box.rules.listByDomain(DOMAIN).map((rule) => ({ id: rule.id, state: rule.state,
      evidence: evidence.filter((features) => evaluate(rule.when, features)).length }));
  }

  /** Call only for successfully claimed, ordinarily ignored mail, after positive classification. */
  match(message: MailMessage, persist: boolean): string | null {
    const candidate = ignoreFeatures(message);
    if (!candidate) return null;
    const rule = this.box.rules.listByDomain(DOMAIN).find((value) => value.state === "auto"
      && value.output === "ignore" && evaluate(value.when, candidate.features));
    if (!rule) return null;
    if (persist) this.box.ledger.record({ domain: DOMAIN, input: { messageId: message.id },
      features: candidate.features, output: "ignore", source: "rule", ruleId: rule.id,
      confidence: rule.confidence, rationale: "Repeated sender, subject template and body structure",
      status: "auto", shadow: [], createdAt: new Date(this.now()).toISOString() });
    return rule.id;
  }

  /** Distinct message IDs vote once. Guards/nonmatching bodies are recorded as ineligible. */
  observe(message: MailMessage): void {
    const candidate = ignoreFeatures(message);
    this.db.transaction(() => {
      const inserted = this.evidence.record(message.id, IGNORE_POLICY.version, candidate, Math.floor(this.now() / 1000));
      if (!inserted || !candidate) return;
      if (this.evidence.support(candidate.fingerprint) < IGNORE_POLICY.minimumMessages) return;
      const when: Condition = { op: "and", clauses: Object.entries(candidate.features)
        .map(([feature, value]) => ({ op: "cmp", feature, cmp: "==", value })) };
      // A retired rule remains retired; repeated evidence must not revive it.
      if (this.box.rules.findByFingerprint(DOMAIN, ruleFingerprint(when, "ignore"))) return;
      this.box.engine.addRule({ domain: DOMAIN, description: "Repeated ignored mail template (non-LLM)",
        when, output: "ignore", state: "auto", source: "seed", confidence: 0.8 });
    })();
  }

  stats(): { observed: number; eligible: number; activeRules: number; retiredRules: number; minimumMessages: number } {
    const counts = this.evidence.counts();
    const rules = this.box.rules.listByDomain(DOMAIN);
    return { ...counts, activeRules: rules.filter((rule) => rule.state === "auto").length,
      retiredRules: rules.filter((rule) => rule.state === "retired").length, minimumMessages: IGNORE_POLICY.minimumMessages };
  }

  retire(ruleId: string): boolean {
    const rule = this.box.rules.get(ruleId);
    return rule?.domain === DOMAIN && !!this.box.engine.setRuleState(ruleId, "retired");
  }
}
