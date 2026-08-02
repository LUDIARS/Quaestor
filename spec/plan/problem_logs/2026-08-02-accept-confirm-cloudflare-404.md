# Acceptance confirmation returned a blank Cloudflare 404

- Date: 2026-08-02
- Status: fixed in working tree
- Area: invoice public magic-link / Cloudflare Tunnel ingress
- Severity: high (the recipient receives an OTP but cannot finalize agreement)

## Summary

After entering the emailed OTP and pressing the final agreement button, the recipient saw a blank
page and no acceptance was recorded. This is a production-path regression introduced when the OTP
confirmation phase added a new `/accept/confirm` child route.

## Evidence

- At 2026-08-02 23:03 JST, a controlled request to the public
  `POST /v1/invoices/share/:token/accept/confirm` route returned HTTP 404 with an empty body.
- The same share successfully reached `POST /accept` and sent OTP messages.
- The latest two challenge rows remained unconsumed with `attempt_count = 0`; the share had no
  `invoice_share_acceptances` row. The confirmation request therefore did not reach Quaestor.
- No bearer token or OTP value was written to this log.

## Regression Context

The dedicated `qs-magiclink.ai-run-do.com` origin already routed the landing, PDF, and `/accept`
paths. The application later emitted `/accept/confirm`, but Cloudflare ingress did not route that
child path consistently. Earlier local tests called the application directly and could not detect
the edge-routing mismatch.

## Cause

The confirmation form depended on a newly introduced public child path. Cloudflare returned its
empty fallback 404 before the request reached Quaestor, so application error handling and challenge
attempt accounting never ran.

## Fix Requirements

- Submit both challenge creation and OTP confirmation to the already-routed `/accept` path.
- Dispatch by validated form fields: `confirm=accepted` begins a challenge; `challenge_id` plus a
  six-digit `code` confirms it.
- Keep `/accept/confirm` as a compatibility alias without requiring it in the public Tunnel rule.
- Continue rejecting cross-site posts and malformed confirmation bodies.

## Verification

- Add a route test proving the generated form targets `/accept` and that OTP confirmation succeeds
  on that same route.
- Keep compatibility coverage for `/accept/confirm`.
- After merge, verify the public Cloudflare path returns a non-empty Japanese success page and an
  acceptance audit row.

## Follow-up

- Record the public-path E2E result in the Discord TestWorkflow thread.
- Use Mailpit only for local deterministic tests; production delivery still requires an authenticated
  mailbox or mail provider.
