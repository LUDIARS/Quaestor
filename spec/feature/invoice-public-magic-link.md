# Public Invoice Magic Links

## Purpose

Quaestor sends a time-limited HTTPS link instead of attaching invoice PDFs to email. The link token
is the sole recipient credential on the public path. All issuer CRUD routes remain behind Cloudflare
Access; only `/v1/invoices/share/*` is eligible for a narrowly scoped Access Bypass policy.

## Domain

The target domain is **`invoice-delivery`**. It owns the registered delivery-contact ledger,
immutable document/recipient snapshots at link issuance, SES/Slack link delivery, recipient-channel
challenge-and-response used as the passkey-enrollment gate, recipient passkeys (WebAuthn public keys),
passkey-signed explicit acceptance of invoice contents, the recipient-facing evidence bundle, and the
RFC 3161 timestamp request for that evidence. It does not own the Google OAuth consent UI, Slack OAuth,
contract drafting, government-ID proofing, certificate-backed (accredited CA) electronic signatures, or
operating a timestamp authority.

## Configuration

Configuration is owned by the single loader `src/services/app-config.ts` (`quaestor.config.json` is
the source of truth, env is override only — see `spec/setup/config-and-secrets.md`).

| Config key | Required | Env override | Purpose |
|---|---:|---|---|
| `invoiceShare.publicUrl` | yes | `QUAESTOR_PUBLIC_URL` | Clean HTTPS origin dedicated to magic links, for example `https://qs-magiclink.ai-run-do.com`. |
| `invoiceShare.roots` | no | `QUAESTOR_INVOICE_SHARE_ROOTS` (`;`-separated) | PDF roots. Defaults to `data`, `app_data/invoices`. |
| `invoiceShare.email.region` | for email | `QUAESTOR_SES_REGION` | Amazon SES region that hosts the verified sending identity, for example `ap-northeast-1`. |
| `invoiceShare.email.fromAddress` | for email | `QUAESTOR_SES_FROM_ADDRESS` | Bare sender address on a domain verified in SES (DKIM/SPF/DMARC published), for example `invoice@qs-magiclink.ai-run-do.com`. |
| `invoiceShare.email.configurationSet` | no | `QUAESTOR_SES_CONFIGURATION_SET` | Optional SES configuration set for reputation/event metrics. Event destinations never receive message bodies. |
| `invoiceShare.email.senderName` | for email | `QUAESTOR_INVOICE_SENDER_NAME` | Name included in every invoice-delivery message. Store the production value in the encrypted secret store; an absent or invalid value fails delivery closed. |
| `invoiceShare.timestampAuthority.url` | no | `QUAESTOR_TSA_URL` | RFC 3161 timestamp authority that stamps the acceptance evidence digest. Defaults to `https://freetsa.org/tsr`. |
| `invoiceShare.timestampAuthority.enabled` | no | `QUAESTOR_TSA_ENABLED` | `false` skips external timestamping (`timestamp_status = skipped`). Defaults to `true`. |
| `invoiceShare.localTest` | no | `QUAESTOR_LOCAL_TEST` | Local manual-testing mode; defaults to `false` and must stay `false` in production. See "Local test mode". |

The send-only IAM credentials (`QUAESTOR_SES_ACCESS_KEY_ID`, `QUAESTOR_SES_SECRET_ACCESS_KEY`,
optional `QUAESTOR_SES_SESSION_TOKEN`) live in the encrypted secret store and are injected into env
at startup. Quaestor never reads the operator's personal `AWS_*` variables, shared credentials file, or
SSO cache, so the delivery credential is a dedicated identity whose only permission is `ses:SendEmail`
from the configured `fromAddress`.

`QUAESTOR_INVOICE_SENDER_NAME` is likewise loaded from the encrypted store before configuration is
resolved. It is rendered only in the recipient-facing invoice message and is never logged or committed.

`invoiceShare.publicUrl` must not contain credentials, a path, query, or fragment. Missing or
insecure configuration fails link creation with `503 not_configured` instead of falling back to a
loopback URL; the only exception is the explicit local test mode below.

### Local test mode

`invoiceShare.localTest: true` reconfigures the running process for same-machine manual testing
without SES or Cloudflare: the production entrypoint overrides the link origin to
`http://localhost:<server.port>` (WebAuthn RP ID `localhost` — a plain-HTTP origin is accepted only
when this flag is set and only for the hostname `localhost`, never for other hosts or IPs), and every
outgoing mail (magic link, enrollment code, evidence bundle) is written to `app_data/outbox/` as a
text file with attachments beside it instead of being sent. Nothing reaches SES. The flag is a
deliberate operator action for a test machine; it must never be enabled in production because the
issuer can then read links and codes from the outbox directory, which removes the
operator-cannot-read-the-link property this feature exists to provide.

- **SPEC-INVOICE-LOCALTEST-001** — with `localTest` off (the default), `http://` origins remain
  rejected with `503 not_configured` and mail goes only through the configured SES notifier. With it
  on, the accepted insecure origin is exactly `http://localhost[:port]`, and mail is written to the
  outbox directory instead of any network delivery. Roots are compared after `realpath`, so a root reached through a symlink still matches.

## Issuer API and link confidentiality

The normal issuer flow creates and sends the link inside Quaestor. It never returns the bearer URL or
token to the caller. Email delivery requires an active registered contact and an idempotency UUID:

```http
POST /v1/invoices/:id/share-links/email
Content-Type: application/json

{
  "document_path": "E:\\Document\\Ars\\Quaestor\\data\\invoice.pdf",
  "expires_in_days": 14,
  "recipient_id": "8f6e9e65-e402-4b0a-9ca8-8ebf88755c10",
  "idempotency_key": "16c30b12-bad5-48e4-a7dc-0abe70700612",
  "billing_period": "2026年7月分"
}
```

Revoke it immediately:

```http
POST /v1/invoices/:id/share-links/:shareId/revoke
```

The response contains delivery/share IDs, status, expiry, document metadata, and the recipient
snapshot, but never `share_url` or `token`. The same idempotency key returns the completed audit row
without sending again. A pending or failed attempt is not retried automatically because the provider
may have accepted the message before a network failure became visible. Send failure revokes the new
link. The delivery ledger stores the destination digest and provider message ID, never the bearer URL.

`POST /v1/invoices/:id/share-links` is not registered in normal application construction. Tests may
enable it only through the non-configurable `unsafeExposeInvoiceShareUrl` dependency-injection flag.
This preserves deterministic public-route tests without creating a production escape hatch.

Symmetrically, the SES client is built only when `invoiceEmailNotifier: "auto"` is passed
explicitly, which only the production server entrypoint does. An application assembled without an
injected notifier has no mail sender at all and fails closed with `503 not_configured`, so a test or
embedding host can never reach the real sending credential or send to a fixture address.

Quaestor is the delivery service in this trust model. People using the issuer API do not receive the
link. The mail provider is Amazon SES precisely because SES retains no copy of a sent message: there
is no "Sent" mailbox, and configuration-set event destinations carry delivery metadata but never the
body, so neither the issuer nor the operator can read the bearer link back from the provider after the
fact. The link therefore exists only in transit and in the recipient's mailbox. What remains is the
usual administrator caveat — someone with live access to Qs process memory could observe a token while
it is being issued — and production access to that host must be limited and auditable. The previous
Gmail/ADC design, where the operator's own mailbox kept a readable copy of every link, is retired and
must not be reintroduced.

SQLite stores only the link token's SHA-256 digest. The PDF must be below 25 MiB, start with `%PDF-`,
and resolve inside an allowed root. Its size and SHA-256 are recorded at issuance and rechecked against
the exact bytes served on every download; replacement after issuance fails closed with `409`.

- **SPEC-INVOICE-EMAIL-001** — Qs sends each message through Amazon SES (`SESv2 SendEmail`,
  SigV4-signed HTTPS) from the configured verified sender using a dedicated send-only credential
  taken from the encrypted store; it never reads the operator's personal AWS credentials, never keeps
  a copy of the sent message, and never logs credentials, signatures, raw links, or message bodies.
  Missing region/sender name/credentials fail closed with `503 not_configured` before any link is created;
  a signature rejection maps to `502 authentication_failed`, other provider failures to `502 api_error`.
  Implemented by `src/services/ses-email-client.ts` and `resolveInvoiceEmailNotifier` in `src/app.ts`.
- **SPEC-INVOICE-EMAIL-002** — issue and delivery are one failure unit; failed delivery revokes the
  link, and UUID idempotency prevents an ordinary client retry from sending the invoice twice.
- **SPEC-INVOICE-EMAIL-003** — the normal email delivery response and Slack delivery response never
  expose the bearer link. Only the recipient-channel message contains it.

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
- **SPEC-INVOICE-DELIVERY-003** — every issuer route that accepts an invoice `:id` accepts only a
  positive decimal integer in its entirety; partial numeric strings such as `12abc` are invalid.
- **SPEC-INVOICE-DELIVERY-004** — a PDF response reads exactly the issuance-time byte length and
  verifies that buffer's SHA-256 before delivery. Shortened, extended, or replaced files fail closed
  with `409`, and a post-issuance oversized replacement is never read into process memory.

## Recipient API

| Route | Result |
|---|---|
| `GET /v1/invoices/share/:token` | Minimal Japanese landing page with invoice summary. `?view=document` returns the verified PDF inline and `?view=evidence` returns the accepted share's evidence bundle as an attachment (`404` until acceptance exists). The acceptance control depends on state: accepted → record + evidence link; recipient has an active passkey → "sign with passkey" (JS); recipient registered but no passkey → email-OTP enrollment form; link not bound to a registered recipient → notice that on-page acceptance is unavailable. |
| `POST /v1/invoices/share/:token/accept` | The complete acceptance flow. Form bodies implement the enrollment gate: `confirm=accepted` emails a six-digit challenge; `challenge_id` plus `code` verifies it and — **without creating acceptance** — issues a one-time, 15-minute passkey enrollment grant. JSON bodies select `passkey-options`, `passkey-register`, or `passkey-accept` with `phase`; these issue WebAuthn options, register the credential, or verify the assertion and record acceptance respectively. |
| `GET /v1/invoices/share/passkey.js` | Same-origin browser script used by the landing/enrollment pages. |

### 公開面は 3 本に固定する

前段 (Cloudflare) は `share/` 配下を丸ごと転送する。したがって **何を公開するかの判断は
アプリ側が持つ**。公開してよい面は次の 3 本だけで、`tests/invoice-share-public-surface.test.ts`
がこの一覧との一致を検証する (増やすと CI が落ちる)。

| 公開面 | 内容 |
|---|---|
| `GET /v1/invoices/share/<token>` | ランディング。`?view=document` で PDF 本体、`?view=evidence` で証跡バンドル |
| `POST /v1/invoices/share/<token>/accept` | 合意フロー一式。form body = OTP フェーズ、JSON body = パスキーフェーズ (`phase` で分岐) |
| `GET /v1/invoices/share/passkey.js` | ブラウザスクリプト |

子パスを増やさないのは、前段の転送条件と実装がズレると **ページは出るのに操作だけ無反応**
という無言の故障になるため (2026-09-01 に `passkey.js` と `passkey/*` で発生)。PDF・証跡は
クエリで出し分け、パスキーの各段階は `/accept` の `phase` に載せる。

`phase` の値: `passkey-options` (`purpose` が `register` / `assert`) / `passkey-register` /
`passkey-accept`。OTP フェーズは form-urlencoded のまま `confirm=accepted` と
`challenge_id` + `code` で分岐する。後方互換だった `/accept/confirm` は削除した
(前段を通らず、`/accept` の body 分岐で同じことができるため)。

Invalid, expired, revoked, cancelled-invoice, and unknown links return the same public error page.
The public response never exposes invoice metadata, storage paths, token hashes, or audit rows.
Responses use `no-store`, `no-referrer`, `nosniff`, frame denial, no-index headers, and a restrictive
CSP (`default-src 'none'; script-src 'self'; connect-src 'self'`). The rate limiter and these headers
are applied once at `/v1/invoices/share/*` in `src/app.ts` because several routers share that prefix.
A local fixed-window limiter allows 60 requests per five minutes per Cloudflare client address.
Because that address comes from a client-supplied header, the limiter tracks at most 10,000 distinct
addresses and evicts the oldest, so header rotation cannot grow process memory without bound.
Opening a link increments an audit counter but never consumes it, because email security scanners
may prefetch links. Links remain reusable until expiry or explicit revocation.

- **SPEC-INVOICE-ACCESS-002** — the public-link fixed-window limiter bounds its tracked client-address
  keys. It prunes expired windows before admitting a new key and evicts the oldest live key when the
  capacity remains full, preventing forged forwarding headers from causing unbounded memory growth.

## Explicit acceptance

Acceptance is a **passkey (WebAuthn) signature over an acceptance statement that embeds the PDF digest**.
The private key exists only on the recipient's device, so neither the issuer nor the Quaestor operator
can produce a valid acceptance after the fact; the recipient additionally receives a self-contained
evidence bundle, and the evidence digest is stamped by an external RFC 3161 timestamp authority.

### Enrollment (first passkey per delivery contact)

The landing page shows the PDF link, a document-hash identifier, a required confirmation checkbox,
and a button that starts email verification. This first POST never creates acceptance. Quaestor sends
a six-digit code to the recipient email snapshotted at link creation. The code is valid for 15 minutes
and five attempts, and a share issues at most five challenges in total. The database stores only an
HMAC keyed by the bearer token. A successful code does **not** record agreement: it consumes the
challenge and issues a one-time enrollment grant (15 minutes, HMAC keyed by the bearer token) that
authorises `navigator.credentials.create()` for the delivery contact. The enrollment page then
registers the passkey and immediately continues to the signature step below. A mail scanner can open
the link and submit the first form, but cannot read the recipient mailbox, cannot obtain a grant, and
cannot sign.

What the email gate does and does not protect: it binds the first credential to control of the
registered mailbox, so a party holding only the bearer link (forwarded mail, a scanner, a leaked log)
cannot enroll their own key as the recipient. It gives **no** protection against the Quaestor operator,
who can observe both the link and the code at send time and could enroll a key of their own; the only
defence against that actor is an out-of-band binding of the public-key fingerprint (contract text,
or a separate-channel confirmation of `public_key_sha256` after enrollment). That binding is reserved
(`enrolled_via = contract_fingerprint`) and not implemented yet, so today the non-repudiation argument
against the operator rests on the recipient keeping their evidence bundle and fingerprint.

Later invoices for the same contact and the same normalized recipient-email identity skip email entirely:
the landing page offers "sign with passkey" whenever that identity has an active credential. A contact
email change does not carry the old identity's keys into newly issued shares. The issuer can list and revoke credentials via
`GET /v1/invoice-delivery-contacts/:id/passkeys` and `POST …/passkeys/:passkeyId/revoke`; revocation is
irreversible and returns the contact to the enrollment gate. `enrolled_via` is `email_otp` today;
`contract_fingerprint` is reserved for registering a public-key fingerprint written into the contract.

### Acceptance statement and challenge

`POST …/accept {phase:"passkey-options", purpose:"assert"}` builds:

```json
{ "v": "invoice-acceptance-statement-v1", "share_id": "…", "invoice_id": 12,
  "document_sha256": "…", "agreement_version": "invoice-content-v1", "agreement_text": "…",
  "recipient_company": "…", "recipient_email_sha256": "…",
  "issued_at": 1787130000, "expires_at": 1787130300, "nonce": "…" }
```

The WebAuthn challenge is `base64url(SHA-256(canonical JSON))` (keys sorted, no whitespace). The
authenticator signs `authenticatorData || SHA-256(clientDataJSON)` and clientDataJSON carries the
challenge, so signature → challenge → statement → PDF digest is one verifiable chain. Quaestor stores
the statement and `HMAC(token, challenge_id, challenge)`; challenges expire after five minutes, are
consumed once, and a share issues at most 30. Enrollment challenges are random and not content-bound.

### Verification and record

The accept POST re-reads and hashes the PDF; a changed document returns `409` and creates no audit
row. It then checks, in order: challenge unconsumed/unexpired and HMAC-matching the value presented in
clientDataJSON; statement matches the live share, PDF digest, and agreement version; the credential
belongs to the share's delivery contact and is not revoked; the assertion verifies (`@simplewebauthn/server`:
origin = `invoiceShare.publicUrl`, RP ID = its hostname, type `webauthn.get`, user verification, signature
counter not regressed). Failures are `400`/`404`/`409`/`410`, never acceptance. One acceptance is stored
per share. The append-only record snapshots everything the OTP design recorded plus:

- `authentication_method = passkey`, the passkey ID and credential ID, the public-key fingerprint
  (SHA-256 of the COSE key);
- the statement JSON, the exact clientDataJSON, authenticatorData and signature (base64url);
- `evidence_sha256` over the canonical, timestamp-independent fields emitted in the evidence bundle
  (format, statement, assertion, credential ID/algorithm/COSE key/fingerprint, and core acceptance fields),
  so a recipient can recompute the TSA message imprint from the JSON alone;
- timestamp state: `pending | granted | failed | skipped`, authority URL, the raw RFC 3161
  `TimeStampResp` (DER), request/grant times, attempt count, last error code.

### Evidence bundle and external timestamp

After the row is written, Quaestor (1) requests one RFC 3161 timestamp for `evidence_sha256`
(DER `TimeStampReq` built with `node:crypto`, `certReq TRUE`, 10 s timeout; the response must be
`granted`/`grantedWithMods` and must contain the request imprint and nonce, otherwise it is treated as
a failure), and (2) emails the recipient the evidence bundle as a JSON attachment (SESv2 `Raw`, MIME
built in `src/services/mime-message.ts`). Neither step can undo acceptance: a timestamp failure
leaves `pending` and an hourly job retries for seven days (then `failed`); a mail failure is logged. The
bundle (`quaestor-invoice-acceptance-evidence-v1`) contains the statement, the assertion parts, the
public key as COSE, SPKI PEM and JWK with its fingerprint, the acceptance metadata and digest, and
the timestamp token when granted. It is re-downloadable from `…?view=evidence` while the link is valid
and by the issuer from `GET /v1/invoices/:id/share-links/:shareId/acceptance/evidence`; third-party
verification steps are in `docs/invoice-acceptance-evidence-verification.md`.

The location signal is defense-in-depth, not identity proof or an acceptance condition. Quaestor
uses latitude and longitude only transiently to compare the request with an issuer reference point,
then stores only `inside`, `outside`, or `unavailable`; neither endpoint coordinates nor distance are
persisted. Missing Cloudflare headers, a missing reference point, VPNs, mobile networks, and
geolocation error all reduce confidence, so this signal must never reject or establish agreement by
itself. A valid `CF-Ray` and syntactically valid `CF-Connecting-IP` are both required before location
headers are trusted; the origin must remain reachable only through the private Cloudflare Tunnel.
The connecting IP is used for this trust check only and is not added to the acceptance ledger.

The issuer can retrieve the record with `GET /v1/invoices/:id/share-links/:shareId/acceptance` (the DER
token is reported as `timestamp_token_present`; the token itself is in the evidence endpoint).

Clauses:

- **SPEC-INVOICE-ACCEPTANCE-001** — acceptance requires a valid passkey assertion over the stored
  acceptance statement while the link/invoice remain active, the exact issued PDF still matches its
  stored size and SHA-256, and the credential is an unrevoked key of the share's delivery contact;
  cross-site requests are rejected.
- **SPEC-INVOICE-ACCEPTANCE-002** — acceptance is append-only and idempotent per share; it stores the
  exact terms, recipient snapshot, document digest, authentication method, challenge ID, timestamp,
  privacy-reduced request metadata, and the full signature material needed for independent verification.
- **SPEC-INVOICE-ACCEPTANCE-003** — the email code is only the enrollment gate: a verified code issues
  a one-time grant and never an acceptance; challenges expire after 15 minutes, lock after five
  failures, and a share issues at most five, so holding the link bounds code guesses at 25 and
  confirmation emails at 5; beyond that the flow fails closed with `429`.
- **SPEC-INVOICE-ACCEPTANCE-004** — when Cloudflare visitor-location headers and an encrypted issuer
  reference point are available, acceptance evidence stores only coarse country/region and an
  inside/outside/unavailable proximity result. Raw coordinates and distance are never persisted,
  and the signal is non-blocking corroboration rather than proof of identity or legal consent.
- **SPEC-INVOICE-ACCEPTANCE-005** — passkeys belong to delivery contacts; registration requires an
  unconsumed enrollment grant obtained through the email gate (or, reserved, a contract fingerprint),
  uses `attestation: none` with user verification, stores the normalized recipient-email identity hash,
  COSE public key, fingerprint, algorithm, counter and transports, and the issuer can list and
  irreversibly revoke them. A key is offered only to shares with the same contact and email identity hash.
- **SPEC-INVOICE-ACCEPTANCE-006** — the signed challenge is the SHA-256 of the canonical acceptance
  statement carrying the PDF digest, agreement text/version, share and invoice IDs, a nonce and a
  five-minute expiry; challenges are stored as token-keyed HMACs and consumed once; a presented
  challenge that does not reproduce the stored HMAC, or a statement that no longer matches the live
  share/document, creates no acceptance.
- **SPEC-INVOICE-ACCEPTANCE-007** — after acceptance the recipient is sent, and can re-download, a
  self-contained evidence bundle from which a third party can verify the signature against the public
  key and the PDF digest without Quaestor's database; delivery failure never revokes acceptance.
- **SPEC-INVOICE-ACCEPTANCE-008** — the evidence digest is submitted to the configured RFC 3161
  authority; the raw response is stored only when granted and carrying the same imprint and nonce;
  failure leaves `pending` for periodic retry (seven days, then `failed`), `enabled:false` records
  `skipped`, and no timestamp outcome blocks or reverses acceptance.

## Access audit log

Each successful public landing-page view and verified PDF response appends a distinct access event.
Invalid, expired, revoked, rate-limited, and document-changed requests are not persisted, preventing
unauthenticated traffic from creating unbounded audit rows. Acceptance POSTs are recorded only in
the acceptance ledger and do not masquerade as page or PDF views.

The event contains its type (`landing_view` or `document_view`), timestamp, valid Cloudflare Ray ID,
SHA-256 digests of the client address and User-Agent, and the same privacy-reduced Cloudflare location
signal used for acceptance evidence: source, coarse country/region codes, and an
inside/outside/unavailable issuer-reference result. Raw client addresses, raw User-Agents, coordinates,
distances, and magic-link tokens are never stored in this ledger. The location signal is recorded only
when a valid `CF-Ray` and syntactically valid `CF-Connecting-IP` make the Cloudflare headers trustworthy;
otherwise it is `unavailable`. The issuer can retrieve newest-first events with
`GET /v1/invoices/:id/share-links/:shareId/access-logs?limit=100`; the limit range is 1–500 and the
response returns both `items` and the uncapped `total`.

- **SPEC-INVOICE-ACCESS-001** — successful landing/PDF accesses are appended to the matching share
  with privacy-minimized request evidence, while the existing first/last/count summary is updated in
  the same database transaction.
- **SPEC-INVOICE-ACCESS-002** — access evidence stores only the trusted Cloudflare location source,
  coarse country/region, and an inside/outside/unavailable issuer-reference result. Raw coordinates,
  distance, and the connecting IP are never persisted.

This record is a clickwrap-style agreement authenticated by a public-key signature from a credential
enrolled through control of the registered recipient email, in addition to possession of the delivery
link. The signature binds the signer's key to the exact PDF digest and agreement text, which gives the
two elements Japanese Electronic Signatures Act guidance describes for an electronic signature —
attribution to the actor and detection of alteration — and the recipient-held evidence bundle plus the
external timestamp make the record verifiable without trusting Quaestor's operator. It is still not a
signature backed by an accredited certification authority, so the statutory presumption of Article 3
is not claimed, and it does not prove that a natural person rather than an authorised device holder
acted.

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

The API response omits the link; only the Slack message contains it. The default destination is loaded
from the encrypted store. A one-off request may instead provide
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

Posting or opening the link proves delivery/access, not consent. Slack read state is never treated as
acceptance. Final consent still requires the passkey signature flow described above (email C&R only gates the first enrollment).

Slack references: [`conversations.open`](https://docs.slack.dev/reference/methods/conversations.open/)
and [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/).

## Storage migration

Contacts live in `invoice_delivery_contacts`, share tokens and recipient snapshots in
`invoice_share_tokens`, delivery attempts in `invoice_share_deliveries`, one-time email challenges in
`invoice_share_challenges`, passkey enrollment grants in `invoice_share_enrollment_grants`, recipient
public keys in `invoice_recipient_passkeys`, WebAuthn challenges (with the signed statement) in
`invoice_share_webauthn_challenges`, and final acceptances with signature material and timestamp state
in `invoice_share_acceptances` (schema version 15; see `src/db/schema.ts`).
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

## 調査ログ (一時)

公開経路は Cloudflare → cloudflared → Quaestor と 3 段を挟むため、「利用者の画面で動かない」
ときに **サーバまで届いているのか** が分からないと切り分けが始まらない。2026-09-01 に、
Cloudflare 側で 404 になっていたスクリプトと API を、サーバログが無いために往復して突き止める
事故が起きた。そのため `/v1/invoices/share/*` の共通 guard を通過したリクエストを入口と出口の
2 行で記録する。レート制限より後ろで記録し、拒否済みの大量リクエストでログファイルを肥大化させない。

- prefix は `[verbose-invoice-share]`。撤去時はこの文字列で全箇所を grep できる。
- 出力は stdout に加えて `logs/quaestor.log` (`QUAESTOR_LOG_FILE` で変更可)。端末を閉じても残す。
- 記録するのは method / 指紋化した path・token・client・User-Agent / Cloudflare 経由か / status / 所要時間。
- **token 本体は出さない**。パスに埋まった token も指紋 (`<token:xxxxxxxx>`) へ置換する。
  生の client address・User-Agent・メールアドレス・PDF の中身・WebAuthn の署名・例外本文も出さない。
- 入口の行だけで出口の行が無ければ、途中で落ちたと判断できる。

- **SPEC-INVOICE-ACCESS-003** — `/v1/invoices/share/*` の共通 guard を通過した調査ログは入口と出口を相関可能な形で
  stdout と専用ファイルへ記録する。magic-link token、client address、User-Agent、例外本文などの
  リクエスト由来データは生値を永続化せず、必要な相関情報だけを指紋化する。

これは一時的な足場で、安定後に撤去する。撤去条件:

- [ ] 公開経路について 1 週間以上、利用者報告由来の不具合が出ていない
- [ ] ログから「これが取れていれば防げた」種類の不具合がもう出てこない
- [ ] 定常監視に残すべき行を仕分け、一般ログへ降格する
