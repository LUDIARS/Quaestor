---
task: mail-crawler-failure-reason
project: Qs
kind: fix
created: 2026-10-13
memory_links: []
---

# Record why the mail crawler fails

The crawler stored only mail_crawl_failed and logged nothing, so repeated
list failures after 2026-10-13 recovery could not be diagnosed.

- [x] Classify failures without secrets (src/services/mail-crawl-failure.ts)
- [x] Log stage/class/code/status/reason via the app logger at warn
- [x] Expose failures and lastFailure in GET /v1/mail/crawler; keep lastError
- [x] Unit tests for classification, secret exclusion and crawler wiring

Acceptance: SPEC-MAIL-CRAWLER-007. Root-cause analysis of the Gmail list failure is out of scope.
Reference: actio:e60edb63-0d44-4891-be46-b8efc8a70f2b.
