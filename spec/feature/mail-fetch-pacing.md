# Gmail request pacing

## SPEC-MAIL-FETCH-PACING-001

The production Gmail source serializes its HTTP requests and waits 200ms before
each request. This applies to list, message and attachment requests, for both
Web OAuth and environment credentials. Concurrent source callers share the queue.
Injected test sources remain unchanged. Authentication tokens remain entirely in
the backend. Failed requests propagate through the existing sanitized error path,
while later requests are not permanently blocked by a rejected queue promise.

Motivation: the first 250-message batch after PR #2120 attempted a 500-message
search window and returned mail_rate_limit twice with zero processed messages.
The precise provider quota was not observed. The dependency uses five concurrent
message requests without pacing; this adapter bounds request rate locally.

Validation: deterministic serialization and queue recovery tests via Revisor;
TypeScript check; repeat the authorized real batch after merge and verify history.
