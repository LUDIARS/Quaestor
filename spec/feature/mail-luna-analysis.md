# Luna analysis and reusable ignore rules

## SPEC-MAIL-LUNA-001
neco selected Luna and explicitly approved sending unknown email sender, subject,
body (at most 24,000 characters) and attachment names/types to OpenAI on 2026-09-28.
Send no attachment bytes or Gmail credentials. On 2026-09-28 neco further directed
Luna to run through Satelles or codex exec; use codex exec with the existing ChatGPT
login, gpt-6-luna, reasoning:none, read-only sandbox and never approval policy.
No API-key fallback. QUAESTOR_CODEX_PATH can select an absolute native executable;
otherwise resolve codex from PATH or the standard Windows installation.

Pass bounded email JSON only on stdin, never in arguments or files. Use an empty
temporary working directory containing only the output schema, ephemeral sessions,
ignore-user-config and project_doc_max_bytes=0. Disable shell, execution, browser,
MCP configuration from user config, plugins, hooks, apps and agent tools. Retain no
stdout/stderr logs. Existing Codex login/auth storage remains in the user's profile;
ephemeral execution is a CLI session policy, not an API store:false parameter.
Whitelist only runtime/auth-location/proxy environment variables; do not inherit
API keys, Gmail credentials or coordinator session variables.

Accept strict kind/confidence JSON only after a successful turn AND zero process
exit. Reject malformed output, unexpected tools, timeout (45s), and output above
2 MB. Kill and reap failed children; remove the temporary schema/directory.
CLI or authentication failure leaves unknown mail pending with a safe diagnostic.
Status reports model, transport=codex-exec, authentication=codex-login and executable
presence as configured; configured does not assert that login is currently valid.

## SPEC-MAIL-LUNA-002
Trusted configured classification and learned ignore rules run before Luna.
Cache validated kind/confidence/model by Gmail ID immediately on successful analysis.
Concurrent requests for the same ID share a single analysis. Persist mail history
and rule evidence transactionally; a restart after cached analysis reuses it.
No body text or prompt is stored in the analysis cache.

## SPEC-MAIL-LUNA-003
An ignore result with confidence >=0.95 AND existing deterministic financial,
security, attachment and body-size guards creates a rule immediately. Conditions
remain exact hashed sender + subject template + body structure; no generated code
or regex is executed. Never revive a retired rule. Subsequent matches bypass Luna.
Low-confidence or actionable/protected results become analysis_review in history;
Input truncated beyond the approved 24,000 characters also always becomes review.
they cannot create automatic financial entries, trigger actions or seed ignore rules.
Existing trusted positive rules keep their normal behavior. Every successful
analysis is saved; only eligible ignore results become automatic exclusion rules.

Validation: tests for wire data bounds, no attachments/credentials in input,
invalid/refused results, CLI failure, per-ID cache/single flight, rule reuse,
protected/actionable mail, retirement, and replay safety. Real model quality remains
to be measured on authorized mail; confidence is a model signal, not a guarantee.
