# Incremental Gmail crawler

## SPEC-MAIL-CRAWLER-001
Production starts a persistent crawler when mail intake is enabled and credentials
are configured. Each scan starts with the newest list page (10 IDs); subsequent
pages use nextPageToken. Existing configured query/date/category scope is retained.
The shipped/default query starts at 2026-01-01 00:00 JST (after:1767193200),
as requested by neco. After explicit all-mail authorization, inbox/category filters
are removed. Gmail's default exclusion of spam/trash remains. Previously analyzed
messages are skipped; this does not reclassify old review outcomes.
The fixed date uses seconds to avoid Gmail's PST interpretation of date strings:
https://developers.google.com/workspace/gmail/api/guides/filtering.
Check history before fetching bodies. Stop scanning at the first completed ID;
error/processing rows are not completion boundaries, but are not replayed either.
The configured query must retain Gmail's newest-first mailbox listing behavior;
this is a new-mail frontier scan, not arbitrary historical gap backfill.

Ten is a page size, not a per-minute cap. Continue pages until a known ID, mailbox
end, request budget, or 60-second processing window. Start the next window no earlier
than 60 seconds after its predecessor. A single in-flight operation can overrun
the window; never abort accounting work halfway. No overlapping ticks.
The old production /sweep operation returns 409 to avoid concurrent bulk downloading.
GET /v1/mail/crawler exposes readiness, counts, safe error code and next attempt time
under the existing direct-loopback access boundary.

## SPEC-MAIL-CRAWLER-002
Gmail HTTP requests share a serialized transport and a rolling 60-second budget
of 5400 units (10% headroom below the currently published new-user 6000 limit).
List costs 5, get/attachment 20, history 2, profile 1, watch 100. Actual provider
limits can be lower or shared with other clients. On 429 or known 403 quota reasons,
persist a cooldown using Retry-After and any ISO retry timestamp, never earlier
than 60 seconds. Repeated failures exponentially back off to one hour; provider
specified longer waits are honored. Record status/reason only, not raw responses.
This replaces blind whole-batch retries and does not guarantee account-wide quota
compliance across unrelated clients. No credential values are logged.

## SPEC-MAIL-CRAWLER-003
SQLite retains page token, pending IDs, next attempt time, error and progress.
Save the pending page before processing any body, then remove IDs one at a time
after durable processing. Restart/partial fetch failure resumes remaining IDs,
not a fresh newest-page search that would stop on this crawler's own completed mail.
When the scan ends, the next poll starts from the newest page. Query changes reset
the cursor. Shutdown clears the timer and drains active work before closing the DB.
Successfully ignored new messages continue updating the existing non-LLM evidence
and reusable template rules; automatic adoption retains the protection checks.
Until the separately approved Luna integration is configured, unknown messages
stay pending with mail_analysis_unconfigured instead of being marked ignored.

Validation: Revisor tests cover multi-page throughput, known-ID stop, concurrent
ticks, partial failure/restart, time window continuation, provider cooldown and
rolling budget. TypeScript checked locally; real provider behavior checked after merge.

## SPEC-MAIL-CRAWLER-004
POST /v1/mail/crawler/backfill accepts request_id (8-80 alphanumeric/hyphen chars)
and limit (1-500), only from the existing trusted direct-loopback boundary.
An explicit request enables bounded historical discovery in the same crawler.
Skip every existing history row without refetching its body; continue beyond known
IDs until limit newly processed messages or mailbox exhaustion. Preserve the
configured Gmail query, learned rules, Luna cache, rolling quota and retry delays.

Persist request identity, target, count and active/completed/exhausted status in
the existing crawl state. The same latest request ID and limit returns its status;
a changed limit for that ID or a different request during active work returns 409.
Reject starts while a tick is running. Preserve pending work and cooldown on start,
restart discovery at the newest page, and reset discovery after the bounded run.
IDs queued beyond the target remain unprocessed and may be found by a later run.
A query change resets the run. An accepted request is not evidence of completion.
Normal newest-mail polling resumes after completion/exhaustion.

## SPEC-MAIL-CRAWLER-005
After neco explicitly authorized all unprocessed 2026 mail and its Luna analysis,
POST /v1/mail/crawler/backfill also accepts until_exhausted:true instead of limit.
Both fields together are invalid. Persist target:null for an explicitly unbounded
run; continue past 500 until the configured query is exhausted. Keep rolling quota,
cooldowns, checkpoint persistence and the single worker. Retrying the same request
ID returns its status; changing the mode for that ID conflicts. Null is not the
default for old callers. Normal polling resumes when the scan exhausts.

## SPEC-MAIL-CRAWLER-006
neco requested status every ten minutes for long-running operations. Run the
session-owned read-only monitor from the project body after starting the job:
node --import tsx src/cli/mail-progress.ts <catalog-loopback-base-url> <request-id>
LICTOR_PORT must refer to the caller's current sidecar. No session identity is
saved. The helper reads crawler status every 30 seconds, reports immediately on
start, then every ten minutes and on completion/error transitions. It never starts
ingestion. It ends after final report or replacement of its monitored request.

Messages contain only counts, state and safe error codes. Pending IDs count is not
presented as total remaining. Lictor's /v1/internal/send-file sends the UTF-8 status
and caption to this session. Monitor state/lock/receipt live under ignored
app_data/mail-progress/<request-id>. API acceptance is not delivery proof; reconcile
the accepted message ID with Cc delivery if necessary. Unknown delivery leaves a
pending marker and stops automatic resends. An orphan lock requires checking the
old process before removal. A session that ends also requires restarting the helper
under a current sidecar. Service interruption is reported and status reads retry.

The send-file acceptance envelope is { ok: true, relayed: 1, message: { message: { id } } }:
Lictor wraps the complete Cc chat response. Only a positive safe-integer numeric id
is valid; strings, missing IDs, invalid envelopes and HTTP failures cannot advance
the checkpoint or replace the previous receipt. receipt.json.messageId retains this
Cc acceptance ID, not a Discord message ID or delivery confirmation. Create the
pending marker exclusively before preparing or sending the report; an existing
marker blocks another attempt without overwriting its evidence. Leave it in place
on ambiguous responses, transport failures or incomplete local persistence.

Reference: actio:47daf22c-5f9f-4775-9e41-c84ebefeade6.
