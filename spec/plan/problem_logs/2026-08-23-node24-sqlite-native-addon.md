# Node 24 SQLite native addon incompatibility

- Date: 2026-08-23
- Status: fixed in working tree
- Area: dependency/runtime compatibility
- Severity: service installation or startup failure

## Summary

Upgrading the runtime to Node.js 24 exposed a regression in the SQLite native addon dependency. Quaestor still selected a pre-Node-24 major of `better-sqlite3`.

## Evidence

`package.json` declared `better-sqlite3` as `^11.7.0`. Native addons built or downloaded for an older Node ABI cannot be reused safely by Node 24.

## Regression Context

The runtime major version was advanced without an equivalent native-addon compatibility gate across repositories.

## Cause

The SQLite binding was pinned below the organization Node 24 baseline. Existing dependency caches can also retain an addon compiled for the previous Node ABI.

## Fix Requirements

- Pin `better-sqlite3` to `13.0.3`.
- Regenerate the lockfile without executing dependency lifecycle scripts.
- Reinstall dependencies under Node 24 before starting the service.

## Verification

The backend CI matrix covers both the declared Node 22 minimum and the Node 24 deployment baseline. Its existing test suite opens multiple in-memory `better-sqlite3` databases after a clean `npm ci`, so the native addon is exercised on both runtimes.

No tests were run in this session by policy; Revisor owns CI execution.

## Follow-up

Dependency caches must include the Node major version and lockfile hash so binaries are not reused across Node upgrades.

