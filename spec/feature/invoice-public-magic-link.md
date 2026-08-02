# Public Invoice Magic Links

## Purpose

Quaestor sends a time-limited HTTPS link instead of attaching invoice PDFs to email. The link token
is the sole recipient credential on the public path. All issuer CRUD routes remain behind Cloudflare
Access; only `/v1/invoices/share/*` is eligible for a narrowly scoped Access Bypass policy.

## Configuration

Configuration is owned by the single loader `src/services/app-config.ts` (`quaestor.config.json` is
the source of truth, env is override only — see `spec/setup/config-and-secrets.md`).

| Config key | Required | Env override | Purpose |
|---|---:|---|---|
| `invoiceShare.publicUrl` | yes | `QUAESTOR_PUBLIC_URL` | Clean HTTPS origin dedicated to magic links, for example `https://qs-magiclink.ai-run-do.com`. |
| `invoiceShare.roots` | no | `QUAESTOR_INVOICE_SHARE_ROOTS` (`;`-separated) | PDF roots. Defaults to `data`, `app_data/invoices`. |

`invoiceShare.publicUrl` must not contain credentials, a path, query, or fragment. Missing or
insecure configuration fails link creation with `503 not_configured` instead of falling back to a
loopback URL. Roots are compared after `realpath`, so a root reached through a symlink still matches.

## Issuer API

Create a 14-day link (1–30 days accepted):

```http
POST /v1/invoices/:id/share-links
Content-Type: application/json

{
  "document_path": "E:\\Document\\Ars\\Quaestor\\data\\invoice.pdf",
  "expires_in_days": 14
}
```

Revoke it immediately:

```http
POST /v1/invoices/:id/share-links/:shareId/revoke
```

The create response returns the raw URL once. SQLite stores only its SHA-256 digest. The PDF must
be below 25 MiB, start with `%PDF-`, and resolve inside an allowed root. Its size and SHA-256 are
recorded at issuance and rechecked against the exact bytes served on every download; replacement
after issuance fails closed with `409`.

## Recipient API

| Route | Result |
|---|---|
| `GET /v1/invoices/share/:token` | Minimal Japanese landing page with invoice summary. |
| `GET /v1/invoices/share/:token/document.pdf` | Verified PDF rendered inline. |

Invalid, expired, revoked, cancelled-invoice, and unknown links return the same public error page.
The public response never exposes invoice metadata, storage paths, token hashes, or audit rows.
Responses use `no-store`, `no-referrer`, `nosniff`, frame denial, no-index headers, and restrictive
CSP. A local fixed-window limiter allows 60 requests per five minutes per Cloudflare client address.
Opening a link increments an audit counter but never consumes it, because email security scanners
may prefetch links. Links remain reusable until expiry or explicit revocation.

## Storage migration

Share tokens live in `invoice_share_tokens` (see `src/db/schema.ts`). Local databases created before
this feature shipped may hold a same-named but incompatible table. On startup `applyMigrations`
renames such a table to `invoice_share_tokens_legacy_v8` — rows are retained for manual inspection,
never dropped — and frees the `idx_invoice_share_invoice` / `idx_invoice_share_expiry` index names so
the current table gets its own indexes. Detection is by column set, so the step is idempotent. If
`invoice_share_tokens_legacy_v8` is already present the migration fails closed rather than
overwriting an earlier backup; resolve it by renaming or dropping that table by hand.

## Cloudflare Access

Magic links use their own hostname (`invoiceShare.publicUrl`, currently
`qs-magiclink.ai-run-do.com`) so that the bypass policy never widens the main `qs.ai-run-do.com`
application. A dedicated hostname does **not** narrow what the origin serves: the same backend
answers every `/v1/*` route on any hostname that reaches it, so the magic-link hostname needs its
own Access application or the issuer CRUD routes become publicly reachable through it.

Required setup:

1. Keep the existing Access application for `qs.ai-run-do.com` unchanged.
2. Add a self-hosted Access application covering the magic-link hostname as a whole
   (`qs-magiclink.ai-run-do.com`) with the same issuer-only policy — this is the default-deny.
3. Add a more-specific self-hosted application only for:

```text
qs-magiclink.ai-run-do.com/v1/invoices/share/*
```

Attach a `Bypass` / `Everyone` policy to that last application only. Do not bypass `/v1/invoices/*`,
`/health`, or either hostname as a whole. The origin must remain reachable only through the
Cloudflare Tunnel, and the tunnel ingress rule for the magic-link hostname must point at the backend
(`127.0.0.1:17400`) — routing it through the Vite dev server would additionally require the hostname
in `web.allowedHosts`.
