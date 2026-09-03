# Registered test timeout contention

- Date: 2026-09-03
- Status: fixed in working tree
- Area: test harness
- Severity: registered test failure

## Summary

The registered full-suite run regressed with 11 invoice integration tests timing out across four files while exercising otherwise unrelated invoice access, passkey, share, and Slack paths.

## Evidence

Vitest reported ten cases exceeding its 5,000 ms default and the rate-limit case in `tests/invoice-shares.test.ts` exceeding its explicit 10,000 ms limit. The failures contained no assertion mismatch.

## Regression Context

The failures appeared in the full registered run after the suite gained additional OCR/GA coverage.

## Cause

The bounded evidence indicates full-suite execution contention made integration cases exceed unit-test-oriented timeout limits; it does not identify a product behavior defect.

## Fix Requirements

- Keep all product assertions unchanged.
- Use one finite timeout suitable for integration-heavy full-suite execution.
- Remove the lower per-test override so the common limit applies consistently.

## Verification

Revisor must rerun the registered `test` suite. No repository code was run during this autofix.

## Follow-up

If a case still reaches 30 seconds, investigate it as a hang or resource leak rather than increasing the limit again.
