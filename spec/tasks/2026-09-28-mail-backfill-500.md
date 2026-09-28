---
task: mail-backfill-500
project: Qs
kind: feature
created: 2026-09-28
memory_links: []
---

# Start analysis with 500 unseen emails

Human instruction: 解析ループ開始; まず500件くらいやってもらって.
The incremental crawler stops on known mail, so add a bounded backfill operation
to the same worker instead of starting a competing ingestion process.

Acceptance: SPEC-MAIL-CRAWLER-004. Persist target/progress/request identity, skip
known IDs, retain quota cooldown and page checkpoints, stop at 500 or exhaustion.
After review/merge, submit one live 500-message request and report actual progress;
do not equate API acceptance with completed mail analysis.
