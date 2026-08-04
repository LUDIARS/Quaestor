# Reconcile test cannot write temporary receipt PNG

- Date: 2026-08-04
- Status: fixed in working tree
- Area: receipt reconciliation test fixture output
- Severity: test reliability

## Summary

The `tests/reconcile.test.ts` suite failed during the full test run because a
temporary receipt PNG could not be written below `E:\tmp`. This is a regression
in test reliability: a reconciliation test should create and clean up its own
isolated fixture output without relying on an externally writable shared path.

## Evidence

- Command: `npm test`
- Failing suite: `tests/reconcile.test.ts`
- Observed path pattern: `E:\tmp\qrecon-test\2026\08\<receipt-id>.png`
- Observed error: `EPERM` while writing the PNG, followed by an invalid JSON
  response assertion failure.

## Regression Context

The same full test command completed 330 of 333 tests. The other two failures
were updated schema-version expectations and were fixed separately; this failure
remained scoped to reconciliation fixture I/O.

## Cause

The test hard-coded the POSIX path `/tmp/qrecon-test`. On Windows this resolved
to the current drive as `E:\tmp\qrecon-test`, a stale shared directory where the
test runner could not create PNG files. A probe confirmed writes there were
denied, while a unique directory returned by `os.tmpdir()` was writable.

## Fix Requirements

- Use a uniquely owned, writable temporary directory for each API test setup.
- Clean up resources on both success and failure.
- Preserve the production reconciliation behavior; constrain the change to test
  fixture setup or its injected storage boundary unless investigation proves a
  production defect.

## Verification

- Reproduce `tests/reconcile.test.ts` from a clean task worktree. (Reproduced:
  10 passed, 1 failed before the fix.)
- Confirm the suite passes without an `EPERM` write failure.
- Run the affected reconciliation tests after the fix.

Verified after the fix:

- `npm test -- tests/reconcile.test.ts`: 11 passed.
- `npm test`: 43 files and 336 tests passed.

## Follow-up

- Determine whether any shared temporary output from earlier test runs requires
  manual cleanup outside this repository.
