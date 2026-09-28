# Incremental Gmail crawler

## SPEC-MAIL-CRAWLER-001
Production starts a persistent crawler when mail intake is enabled and credentials
are configured. Each scan starts with the newest list page (10 IDs); subsequent
pages use nextPageToken. Existing configured query/date/category scope is retained.
The shipped/default query starts at 2026-01-01 00:00 JST (after:1767193200),
as requested by neco. Inbox and promotions/social filters remain enabled.
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
