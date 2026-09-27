# Ignored mail groups and operator batches

## SPEC-MAIL-IGNORE-GROUPS-001

The history screen initially aggregates all completed ignored mail by the existing
sender / normalized subject / body structure fingerprint. Each group shows its
count, example sender and subject, newest receipt time and rule state. Selecting
a group lists its mail with pagination. Aggregation is independent of the current
history page. Protected/ineligible mail and unprofiled mail are separate buckets,
not claimed to be a single family. The existing history access boundary applies.

## SPEC-MAIL-IGNORE-GROUPS-002

An explicit local operator command POST /v1/mail/ignore-patterns/activate-observed
with approve:true creates rules from the eligible evidence currently stored.
This is distinct from automatic mining, which still requires five messages.
All three hashed features and current policy must match; retired rules remain
retired. Attachments, protected content and positive classifications retain their
existing precedence. Repeating the command creates no duplicate rules.

## SPEC-MAIL-IGNORE-GROUPS-003

POST /v1/mail/sweep accepts optional limit:1..250. It searches the existing query
with a 500-message window, removes previously claimed message IDs and processes
at most limit new messages. Atomic claims still prevent concurrent reprocessing.
It does not broaden the configured date/category scope. A window containing fewer
new messages produces a smaller batch; this API does not promise full pagination
of the Gmail mailbox. Omitting limit preserves the normal 50-message sweep.

Validation: TypeScript checks; Revisor tests for grouping across pages, explicit
activation idempotency/retirement, and batching past prior claims. Real operation
must report actual processed counts, not merely the requested batch size.
