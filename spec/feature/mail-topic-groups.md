# Mail notification grouping

## SPEC-MAIL-TOPIC-GROUPS-001
neco asked to unify GitHub notifications for Yahata Takuto's SS and all V Point
mail. Display GitHub notifications by exact owner/repository parsed from the
subject after reply/forward prefixes; require github.com sender domain and keep
different owners/repos separate. Repository identity is case-insensitive.

Unify NFKC-normalized Vポイント / V Point subject mentions and the observed dedicated
sender mytc@tsite.jp under Vポイント. Partner campaigns may have different senders.
These are organizational labels, not claims about authenticated brand ownership.
Rule data lives in src/mail/topic-groups.ts and is deterministic, with no LLM.

Read groups across all persisted history, including review, CI and invoice outcomes.
On neco's follow-up to review and regroup the existing groups, other valid senders
are grouped by their exact normalized email address regardless of subject/body
template. Never merge unrelated senders simply because they share a mail domain.
Topic groups take precedence over fine-grained ignored-template groups; each mail
belongs to at most one group. Missing/malformed senders retain the legacy grouping.
Stable topic:<sha256> IDs are distinct from exclusion-rule fingerprints.
Group details include all classifications unless an explicit kind filter is given.
Both totals and details use the same predicate and deterministic pagination.

Do not change outcomes, analysis cache, blackbox rules or message content, trigger
Gmail fetches, or reanalyze mail when viewing groups. A topic group is not a new
ignore rule. UI identifies mixed classifications and preserves per-message result.
Revisor validation covers grouping, separation, Unicode, pagination and read-only
API behavior. Actual stored SS owner spelling is not inferred from a display name;
all valid GitHub owner/repo notifications use the same grouping mechanism.
