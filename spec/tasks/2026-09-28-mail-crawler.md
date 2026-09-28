---
task: mail-crawler
project: Qs
kind: feature
created: 2026-09-28
memory_links: []
---

# Rate-aware incremental mail crawler

Human instructions: crawl newest mail in ten-ID pages until previously processed
mail is reached; process as much as the minute's quota/time allows, not ten per minute.
Retain partial progress across limits and restarts. Reuse learned ignore patterns.
Follow-up: analyze unknown mail with Luna and derive rules to reduce subsequent
LLM use. Concrete external mail-data transmission requires the pending approval
after automatic approval review rejected that portion; do not infer it from model selection.

Acceptance: no duplicate analysis of completed mail, no body fetch for known IDs,
safe provider diagnostics, bounded usage, durable retry/cursor and shutdown cleanup.
Relevant spec: spec/feature/mail-crawler.md. Review/merge/reflection through Revisor.
