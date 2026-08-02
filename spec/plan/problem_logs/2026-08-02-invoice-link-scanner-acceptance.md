# Possible automated scanner recorded invoice acceptance

- Date: 2026-08-02
- Status: remediated in `feat/invoice-channel-challenge`; verification pending under session policy
- Area: invoice public magic-link / acceptance evidence
- Severity: high (legal agreement evidence may be attributed to automation rather than a human recipient)

## Summary

The production MELPOT invoice link recorded an acceptance about 35 seconds after email delivery. The activity sequence is consistent with an automated email-security browser following the link, opening the PDF, returning to the page, and submitting the acceptance form. The record must not be treated as confirmed human agreement without recipient confirmation.

## Evidence

- Recipient: the registered MELPOT delivery contact (address intentionally not recorded here; it is in
  `invoice_delivery_contacts`); invoice ID `39`; share ID `48502bbf-3166-47b6-90ae-c8ff49cd69a1`.
- A single user-agent hash performed a landing view at Unix `1785663108`, a PDF view at `1785663110`, another landing view at `1785663114`, and acceptance at `1785663116`.
- The matching user-agent SHA-256 is `3d4ab79e0f5f9dbce76fcd9bd236434dba46ee63b03eb392bab406c82444f740`.
- The acceptance CF-Ray was `a24c128f7c1bd755-NRT`.
- Additional landing requests with different user-agent/address hashes occurred in the same delivery window, consistent with link-scanning infrastructure.
- The acceptance endpoint requires only the bearer magic-link token plus the pre-rendered form value `confirm=accepted`; it does not require recipient-entered information or a second factor.
- `src/api/invoice-shares.ts:67-78` accepts a direct POST whenever `confirm=accepted`; omitting `Sec-Fetch-Site` bypasses the only request-origin rejection.
- `src/invoices/invoice-share-page.ts:79-81` places the accepted value directly in the HTML checkbox, so an automated client can copy or construct it without interacting with the rendered button.
- Existing tests in `tests/invoice-shares.test.ts` and `tests/invoice-share-access.test.ts` intentionally create successful acceptances with a programmatic request whose body is only `confirm=accepted`.

## Regression Context

The flow was designed to preserve explicit button consent, but it did not account for email-security systems that execute browser interactions. A successful POST alone is therefore insufficient evidence that the named recipient acted.

## Cause

The acceptance form can be submitted by any agent possessing the magic-link URL. There is no step-up challenge that distinguishes the human recipient from an automated scanner, and the evidence model has no `suspected_automation` or invalidation state.

The current implementation therefore does **not** satisfy the requirement that routine automated link scanners must be unable to finalize acceptance. No additional production acceptance was created to prove this because the source and existing automated tests already demonstrate it conclusively.

## Fix Requirements

- Do not treat the current acceptance as legally confirmed until MELPOT verifies that a person performed it.
- Require recipient-entered information that is not prefilled in the page, preferably an email OTP or separately communicated approval code, before recording final acceptance.
- Record the initial button action as a pending intent and create the immutable final acceptance only after the challenge succeeds.
- Add an acceptance review state such as `pending`, `confirmed`, `suspected_automation`, or `superseded` without deleting the original audit event.
- Detect and flag implausibly fast delivery-to-acceptance sequences and known scanner user agents.
- Ensure automated preview and PDF fetches never create or finalize acceptance.

## Implemented Remediation

- The first checked POST now creates only a pending email challenge and never an acceptance row.
- Final acceptance requires a six-digit code sent to the recipient email snapshotted when the link
  was issued. Codes expire after 15 minutes and lock after five failed attempts, and a share issues
  at most five challenges in total so a link holder cannot reset the attempt budget indefinitely.
- Code plaintext is never stored. The database contains an HMAC keyed by the bearer token, so a DB
  reader without the delivered link cannot cheaply enumerate the six-digit code.
- Acceptance evidence records `authentication_method=email_otp` and the consumed challenge ID.
- Normal email/Slack delivery responses no longer disclose the bearer URL; the standalone raw-link
  issue endpoint is absent unless a test-only dependency-injection switch is explicitly enabled.
- Scanner classification and acceptance review-state workflows remain defense-in-depth follow-ups;
  they are no longer required to prevent a link scanner from creating a final acceptance.

## Verification

- Simulate an email security crawler that visits every link and submits visible forms; no final acceptance may be created.
- Verify that a human can complete the step-up challenge and that repeat submissions are idempotent.
- Verify that challenge failures, expiry, and retries do not alter the PDF hash or recipient snapshot.
- Confirm that the audit API distinguishes scanner-suspected events from verified human acceptance.

## Follow-up

- Ask MELPOT whether a person clicked the agreement button at the recorded time.
- At the sender's explicit request, the suspect acceptance row for invoice `39` was deleted. The invoice, share link, delivery record, and seven access-log rows were preserved; the acceptance audit endpoint now returns 404.
- Do not resend or revoke the production link until the sender chooses the remediation path.
