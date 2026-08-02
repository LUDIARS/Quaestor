# Magic-link transient Cloudflare 502 after PDF return

- Date: 2026-08-02
- Status: investigating
- Area: invoice public magic-link / Cloudflare Tunnel
- Severity: medium (recipient temporarily could not return to the invoice agreement page)

## Summary

After opening the invoice PDF from a valid magic link and navigating back, the recipient saw a Cloudflare 502 response. This is a delivery-path incident because the recipient could not continue to the agreement action even though the PDF had opened successfully.

## Evidence

- The recipient opened the landing page at `2026-08-02 18:18:34 +09:00` and the PDF at `18:18:37 +09:00`; both successful accesses were recorded in `invoice_share_access_logs`.
- The recipient reported a 502 immediately after returning from the PDF.
- Quaestor returned HTTP 200 from `GET /health` at `18:19:26` and again at `18:20:28`.
- Excubitor reported the service as `running`, with TCP health passing on `localhost:17400`. Its most recent recorded downtime was `16:36:02`, not during this incident.
- The same Node listener remained active on `127.0.0.1:17400`; no process restart was observed.
- The Cloudflare public path returned the expected application 404 for an invalid token at `18:20:42`, showing that the route had recovered.
- Twenty public requests between `18:21:56` and `18:22:02` all returned the expected 404 in 0.087-0.330 seconds; no 502 recurred.
- The recipient retried the same flow and reported that it completed successfully.
- The subsequent production-link verification returned HTTP 200 for both the landing page and PDF without another 502.
- The incident occurred immediately after the Tunnel public-hostname path was changed to include `/accept`.

## Regression Context

The landing page, PDF route, and acceptance route had just passed end-to-end checks. The 502 appeared only after the Cloudflare Tunnel rule update and was not reproduced once the rule had settled.

## Cause

Quaestor itself did not stop. The leading hypothesis is a transient Cloudflare Tunnel ingress reload or propagation gap while the remote-managed public-hostname configuration was updating.

An origin-address mismatch remains a secondary risk: Quaestor listens on `127.0.0.1:17400`, while `localhost` also resolves to IPv6 on this host and `::1:17400` does not accept connections. The remote Tunnel service URL must be confirmed as `http://127.0.0.1:17400`, not `http://localhost:17400`.

## Fix Requirements

- Set the Tunnel origin explicitly to `http://127.0.0.1:17400`.
- Confirm that only one public-hostname rule owns `qs-magiclink.ai-run-do.com` and that no older overlapping path rule remains.
- Preserve the path rule `^/v1/invoices/share/[^/]+(/document[.]pdf|/accept)?$`; both challenge creation and confirmation use the stable `/accept` path.
- Add an external HTTP check for the public magic-link origin so transient Cloudflare failures are visible separately from Excubitor's local TCP health.
- Keep invoice delivery idempotent so a transient 502 never causes duplicate email delivery or duplicate acceptance records.

## Verification

- Re-run landing, PDF, browser-back, and acceptance flows after the Tunnel origin is pinned to IPv4.
- Repeat the public-path probe across at least one Tunnel configuration refresh and verify that no request returns 502.
- Verify that a repeated acceptance POST remains idempotent and returns the accepted page.

## Follow-up

- Inspect Cloudflare Tunnel connector events around `2026-08-02 18:18:37 +09:00` if retained.
- Add the public-path check to the operational monitoring used for month-end invoice delivery.
