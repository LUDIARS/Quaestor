---
task: mail-history-search
project: Qs
kind: fix
created: 2026-09-28
memory_links: []
---

# Discover unprocessed older mail

Human instruction: 新着ないなら、未処理の過去のメールを検索していってほしい.
The first bounded 500-message run exhausted the configured three-day query after
38 new messages. Remove newer_than:3d from the shipped and default query so the
same crawler can page into older inbox mail. Keep category filters and history
deduplication. No Gmail labels, mail content or authentication data are changed.

After merge and config reflection, start a bounded 462-message backfill under a
new request ID to finish the original 500-message allocation. Existing nextAt
state resets on a query change; ensure any provider cooldown is retained before
activating the new query. Completion requires observing actual progress; record
exhaustion or errors honestly. Related spec: SPEC-MAIL-CRAWLER-004.
