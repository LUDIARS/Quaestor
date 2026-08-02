# Public Invoice Magic Links

## Purpose

Quaestor sends a time-limited HTTPS link instead of attaching invoice PDFs to email. The link token
is the sole recipient credential on the public path. All issuer CRUD routes remain behind Cloudflare
Access; only `/v1/invoices/share/*` is eligible for a narrowly scoped Access Bypass policy.

## Domain

The target domain is **`invoice-delivery`**. It owns the registered delivery-contact ledger,
immutable document/recipient snapshots at link issuance, link delivery, and explicit acceptance of
invoice contents. It does not own Gmail authentication, Slack OAuth, contract drafting, identity
proofing, certificate-backed electronic signatures, or qualified timestamp services.

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
  "expires_in_days": 14,
  "recipient_id": "8f6e9e65-e402-4b0a-9ca8-8ebf88755c10"
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

### Delivery-contact API

`/v1/invoice-delivery-contacts` provides list, create, replace, and soft-delete operations. Email is
normalized to lowercase and unique case-insensitively. A deactivated contact cannot be attached to
a new link. Project-specific recipients belong in the local database and are never committed as
source fixtures or configuration. The invoice screen provides registration, editing, and
deactivation controls backed by this API.

```http
POST /v1/invoice-delivery-contacts
Content-Type: application/json

{
  "company_name": "Example Customer",
  "email": "billing@example.com"
}
```

Clauses:

- **SPEC-INVOICE-DELIVERY-001** — the contact ledger validates company/email, normalizes email,
  rejects duplicates, and uses soft deletion so past delivery evidence remains understandable.
  Reactivation is explicit: an update that omits `active` keeps the stored value, so editing a
  company name or address never silently returns a deactivated contact to the selectable set.
- **SPEC-INVOICE-DELIVERY-002** — when `recipient_id` is supplied, link issuance requires an active
  contact and copies its ID, company, and email into the share row. Later contact edits never rewrite
  an issued link's recipient evidence.

## Recipient API

| Route | Result |
|---|---|
| `GET /v1/invoices/share/:token` | Minimal Japanese landing page with invoice summary. |
| `GET /v1/invoices/share/:token/document.pdf` | Verified PDF rendered inline. |
| `POST /v1/invoices/share/:token/accept` | Requires the confirmation checkbox and records agreement to the verified PDF. |

Invalid, expired, revoked, cancelled-invoice, and unknown links return the same public error page.
The public response never exposes invoice metadata, storage paths, token hashes, or audit rows.
Responses use `no-store`, `no-referrer`, `nosniff`, frame denial, no-index headers, and restrictive
CSP. A local fixed-window limiter allows 60 requests per five minutes per Cloudflare client address.
Opening a link increments an audit counter but never consumes it, because email security scanners
may prefetch links. Links remain reusable until expiry or explicit revocation.

## Explicit acceptance

The landing page shows the PDF link, a document-hash identifier, a required confirmation checkbox,
and a `請求内容に合意する` button. The server re-reads and hashes the PDF before accepting; a changed
document returns `409` and creates no audit row. One acceptance is stored per share, so retries are
idempotent. The append-only record snapshots:

- share/invoice IDs and recipient company/email;
- the full PDF SHA-256;
- agreement version and exact agreement text;
- acceptance timestamp, Cloudflare Ray ID when valid, and a SHA-256 of the User-Agent;
- an evidence checksum over the canonical event fields.

The issuer can retrieve it with `GET /v1/invoices/:id/share-links/:shareId/acceptance`. The evidence
checksum detects accidental inconsistency but is not an independent timestamp or protection against
an administrator who can rewrite both the row and checksum.

Clauses:

- **SPEC-INVOICE-ACCEPTANCE-001** — acceptance requires an explicit checked form POST while the
  link/invoice remain active and the exact issued PDF still matches its stored size and SHA-256;
  requests explicitly marked cross-site by Fetch Metadata are rejected.
- **SPEC-INVOICE-ACCEPTANCE-002** — acceptance is append-only and idempotent per share; it stores the
  exact terms, recipient snapshot, document digest, timestamp, and privacy-reduced request metadata.

## Access audit log

Each successful public landing-page view and verified PDF response appends a distinct access event.
Invalid, expired, revoked, rate-limited, and document-changed requests are not persisted, preventing
unauthenticated traffic from creating unbounded audit rows. Acceptance POSTs are recorded only in
the acceptance ledger and do not masquerade as page or PDF views.

The event contains its type (`landing_view` or `document_view`), timestamp, valid Cloudflare Ray ID,
and SHA-256 digests of the client address and User-Agent. Raw client addresses, raw User-Agents, and
magic-link tokens are never stored in this ledger. The issuer can retrieve newest-first events with
`GET /v1/invoices/:id/share-links/:shareId/access-logs?limit=100`; the limit range is 1–500 and the
response returns both `items` and the uncapped `total`.

- **SPEC-INVOICE-ACCESS-001** — successful landing/PDF accesses are appended to the matching share
  with privacy-minimized request evidence, while the existing first/last/count summary is updated in
  the same database transaction.

This is a clickwrap-style evidence record authenticated by possession of a link delivered to the
registered address. It is not presented as a certificate-backed electronic signature. Japanese
Electronic Signatures Act guidance describes an electronic signature as requiring both attribution
to the actor and a way to verify that the signed information was not altered; stronger identity or
statutory presumptions require a separate signature/identity-proofing design.

Legal references: [Ministry of Justice overview of the Electronic Signatures Act](https://www.moj.go.jp/MINJI/minji32-1.html)
and the [MIC/MOJ/METI Q&A on Article 2(1)](https://www.meti.go.jp/covid-19/denshishomei_qa.html).

## Slack delivery

Quaestor can create the same link and post it to a Slack group direct message (MPIM). The PDF is not
uploaded to Slack. The message contains Japanese fallback text and a `請求書を確認する` button, and
link/media unfurling is disabled so Slack does not fetch the bearer URL for a preview.

Clauses (referenced from code with `@implements`):

- **SPEC-INVOICE-SLACK-001** — `POST /v1/invoices/:id/share-links/slack` accepts the request below,
  rejects unknown fields, and maps `InvoiceShareError` / `SlackDeliveryError` to their own status.
  Implemented by `src/api/invoice-slack-deliveries.ts`.
- **SPEC-INVOICE-SLACK-002** — link creation and the Slack post are one failure unit: the target is
  validated before any link is created, and a post failure revokes the link just created. Addressee
  and subject are attacker-influenced text and are escaped in both the fallback text and the blocks.
  Implemented by `src/services/invoice-slack-delivery.ts`.
- **SPEC-INVOICE-SLACK-003** — the send-only Slack Web API client resolves the MPIM, posts with
  unfurling disabled, and never puts the bot token or message body into an error. Implemented by
  `src/services/slack-web-api-client.ts`.
- **SPEC-INVOICE-SLACK-004** — the bot token and default target come from the encrypted store via
  env; supplying both target forms is a startup configuration error. Implemented by
  `resolveSlackNotifier` in `src/app.ts` and `resolveSlackInvoiceTarget`.

```http
POST /v1/invoices/:id/share-links/slack
Content-Type: application/json

{
  "document_path": "E:\\Document\\Ars\\Quaestor\\app_data\\invoices\\invoice.pdf",
  "expires_in_days": 14,
  "recipient_name": "Example Customer ご担当者様",
  "billing_period": "2026年7月分"
}
```

The default destination is loaded from the encrypted store. A one-off request may instead provide
either `conversation_id` (`G...`) or `user_ids` (2–8 distinct `U...` / `W...` IDs), but never both.
If Slack rejects the post, the newly created magic link is immediately revoked and the API returns
`502 api_error`. Missing Slack settings fail before link creation with `503 not_configured`.

Slack App setup:

1. Create an internal Slack App and add a bot user.
2. Add Bot Token Scopes `chat:write` and `mpim:write` under **OAuth & Permissions**.
3. Install or reinstall the app to the workspace and copy the `xoxb-...` Bot User OAuth Token.
4. Choose one target method:
   - Existing group DM: use its `G...` conversation ID only when the bot is already a member.
   - User IDs: save 2–8 workspace member IDs. Quaestor calls `conversations.open`; Slack creates or
     resumes the MPIM containing those users and the app. Slack Connect combinations may be rejected
     unless all external members already share a channel.
5. Store the token and target with the commands in `spec/setup/config-and-secrets.md`, then restart
   Quaestor through Excubitor.

Posting or opening the link proves delivery/access, not consent. Consent is recorded only by the
explicit checked acceptance POST described above; Slack read state is never treated as acceptance.

Slack references: [`conversations.open`](https://docs.slack.dev/reference/methods/conversations.open/)
and [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/).

## Storage migration

Contacts live in `invoice_delivery_contacts`, share tokens and recipient snapshots in
`invoice_share_tokens`, and acceptances in `invoice_share_acceptances` (see `src/db/schema.ts`).
Local databases created before
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
