# Luna analysis and reusable ignore rules

## SPEC-MAIL-LUNA-001
neco selected Luna and explicitly approved sending unknown email sender, subject,
body (at most 24,000 characters) and attachment names/types to OpenAI on 2026-09-28.
Send no attachment bytes or Gmail credentials. Use gpt-6-luna Responses API with
reasoning:none, store:false, no tools and at most 300 output tokens. Treat email
as untrusted data; validate a strict kind/confidence schema and handle refusal,
incomplete or malformed responses as errors. Log no raw request/response content.
Use backend QUAESTOR_MAIL_LUNA_API_KEY or OPENAI_API_KEY via existing secret injection.
Missing/invalid credentials leave unknown mail pending with an explicit diagnostic.
Crawler status includes the selected model and a credentials-present boolean, never the key.

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
invalid/refused results, no-key failure, per-ID cache/single flight, rule reuse,
protected/actionable mail, retirement, and replay safety. Real model quality remains
to be measured on authorized mail; confidence is a model signal, not a guarantee.
