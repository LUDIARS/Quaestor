---
task: mail-luna-cli
project: Qs
kind: fix
created: 2026-09-28
memory_links: []
---

# Run Luna through authenticated Codex

Human instruction: LunaはSatellesかcodex execで動かして.
Choose installed codex exec, using the existing ChatGPT login. This supersedes the
API-key prerequisite of #2129 without expanding the approved email data scope.

Acceptance: SPEC-MAIL-LUNA-001; stdin-only bounded inputs, no model tools, no saved
CLI sessions, strict output validation, safe failure and unchanged history/rules.
Implementation belongs to mail-intake. Review through Revisor and verify reflected
transport after merge. Do not claim real model success from executable presence.
