# 請求書合意の OTP をパスキー署名 (WebAuthn) + 証跡バンドル + 外部タイムスタンプへ置換する — 実装設計

- 日付: 2026-08-19
- 発案: neco (要件: 運用者=管理者に対しても「受領者本人が、この内容に、この時刻に合意した」を
  後から否認されない / 管理者が偽造できない形で残す。 OTP は廃止してよい)
- 対象 spec: `spec/feature/invoice-public-magic-link.md` 「Explicit acceptance」節 (本 PR で改訂)、
  `spec/setup/config-and-secrets.md` (タイムスタンプ局の設定行を追加)
- ドメイン: `invoice-delivery` (既存)。 Anatomia supply はこのドメインへ紐づける。

## 1. 背景と決定

現行の最終合意は「登録メールへ 6 桁 OTP → 入力」 (`email_otp`) である。 OTP はマジックリンクと
**同じ SES 経路で同じ宛先に** 送られるため、 管理者に対する秘匿性には何も足していない (管理者は
リンクも OTP も送信時点で見られる立場にある)。 さらに OTP は「受領者側に秘密鍵が無い」ので、
管理者が監査行を書き足しても受領者は反証できない。 要件は **対管理者の非否認性** なので:

1. **合意の認証をパスキー (WebAuthn) の assertion 署名へ置き換える。** 秘密鍵は受領者端末にしか
   存在せず、 署名対象 (clientDataJSON の challenge) に請求書 PDF の SHA-256・合意文言・share ID を
   埋めるので、 「誰が (鍵)・何に (文書ハッシュ)」 が 1 つの署名で結ばれる = 電子署名法 2 条 1 項
   の 2 要件 (本人性・非改竄性) の技術的実体を持つ。 認定認証事業者の電子証明書は使わないので
   法 3 条の推定効までは主張しない (spec の法的注記を更新)。
2. **受領者へ証跡バンドル (JSON) を送る。** 受領者の手元に 署名・公開鍵・文書ハッシュ・合意文言 が
   残ることで、 管理者が DB を書き換えても受領者側のコピーと突き合わせられる。
3. **外部タイムスタンプ (RFC 3161) を付与する。** 証跡ハッシュをタイムスタンプ局 (TSA) に打刻して
   もらい、 「この証跡はこの時刻に存在した」 を管理者の外で保証する。 取得は非同期・失敗しても合意
   は成立 (後追いリトライ)。
4. OTP は「最終合意の認証」からは外す。 ただし **パスキー初回登録時の本人紐付け** には既定で
   OTP を 1 回だけ使う (§2 判断 A)。 コードは削除せず、 役割を「登録ゲート」に限定する。

## 2. 判断待ち事項と既定値

| # | 論点 | 既定 (neco 未回答時) | 代替 |
|---|---|---|---|
| A | パスキー公開鍵と受領者 (delivery contact) の紐付け | **初回のみ OTP** (neco 2026-08-19 確定: 現状維持。OTP はリンク単独漏洩への対策であり、管理者に対しては効かないことを spec に明記): 契約先ごとに最初のパスキー登録時だけ既存 OTP を通し、 通過後に `navigator.credentials.create()`。 2 回目以降の請求は OTP 無し | 契約書に公開鍵指紋を記載し OTP 完全廃止。 `enrolled_via = 'contract_fingerprint'` を schema に予約し、 管理 API から指紋を事前登録する経路を後続 PR で足せる形にする |
| B | タイムスタンプ局 | **FreeTSA (RFC 3161, `https://freetsa.org/tsr`)**: 無料・同期 HTTP 1 往復・`openssl ts -verify` で第三者検証可。 要求/応答は DER を `node:crypto` + 手書き最小 ASN.1 で扱う (要求 ≈ 60 bytes、 応答は status だけ読み raw 保存) | OpenTimestamps (Bitcoin アンカー)。 確定まで数時間〜、 検証に ots クライアントが要り、 相手に説明しづらいので採らない |
| C | `@simplewebauthn/server` の依存追加 | **追加する (推奨)**。 attestation/CBOR/COSE/署名検証は誤実装が致命的で、 テスト済みライブラリを使うのが安全側。 SES の時の「依存追加しない」は SDK 肥大回避が理由で、 署名検証ライブラリには当てはまらない | 自作 (CBOR decoder + COSE→JWK + `crypto.verify`)。 ≈300 行の安全性クリティカルなコード。 依存ゼロ方針を優先するなら選ぶ |

## 3. フロー

### 3.1 受領者 (公開経路 `/v1/invoices/share/:token/*`)

```
GET /share/:token                 ランディング。 合意済なら記録表示。 未合意なら
                                  - 契約先に有効パスキーあり → 「パスキーで合意する」ボタン (JS)
                                  - 無し                    → 「メールで本人確認して鍵を登録する」(既存 OTP フォーム)
POST /share/:token/accept         [既存] confirm=accepted → OTP 発行 / challenge_id+code → OTP 検証。
                                  変更点: OTP 検証成功は **合意を作らず**、 登録許可 (enrollment grant) を
                                  発行してパスキー登録ページへ進める。
POST /share/:token/passkey/options  JSON。 {purpose:"register", grant_id} または {purpose:"assert"}。
                                  challenge を発行し WebAuthn options を返す。
POST /share/:token/passkey/register JSON。 attestationResponse + grant_id → 公開鍵を contact に保存。
POST /share/:token/passkey/accept   JSON。 assertionResponse → 署名検証 → 合意確定 → 証跡バンドル送信
                                  → タイムスタンプ (非同期)。
GET  /share/:token/evidence.json  合意済 share の証跡バンドル (リンク所持者向け再取得)。
```

- ページ JS は inline ではなく `GET /share/passkey.js` (静的、 `script-src 'self'`) で配信。
  CSP に `script-src 'self'; connect-src 'self'` を足す (既定 CSP は `default-src 'none'` のまま)。
- RP ID = `invoiceShare.publicUrl` のホスト名、 origin = `publicUrl`。 設定追加なし。
- 子パス (`/passkey/*`, `/evidence.json`) は Access Bypass が `/v1/invoices/share/*` 全体なので
  追加設定不要。 過去の `/accept/confirm` 404 はデプロイ遅延で、 パス設計の問題ではなかった。

### 3.2 署名対象 (acceptance statement) と challenge

```json
{
  "v": "invoice-acceptance-statement-v1",
  "share_id": "…", "invoice_id": 12,
  "document_sha256": "…64hex…",
  "agreement_version": "invoice-content-v1", "agreement_text": "私は送信先の担当者として…",
  "recipient_company": "…", "recipient_email_sha256": "…",
  "issued_at": 1787130000, "expires_at": 1787130300,
  "nonce": "…base64url 16B…"
}
```

- `challenge = base64url(sha256(canonical JSON))`。 canonical = キー昇順・空白なし。
- 受領者ブラウザはこの challenge を `navigator.credentials.get()` に渡し、 認証器が
  `authenticatorData || sha256(clientDataJSON)` に署名する。 clientDataJSON に challenge が入るので、
  署名 → challenge → statement → PDF SHA-256 の連鎖で文書に結び付く。
- DB には statement 平文と `challenge_hash = HMAC(token, challenge_id, challenge)` を保存 (OTP と同じ
  「トークン鍵付き HMAC」方針)。 nonce と expires (5 分) で再利用を閉じる。 消費は 1 回。

### 3.3 検証と合意確定 (`passkey/accept`)

1. share を `loadDocument` で再検証 (PDF 再ハッシュ、 `document_changed` → 409)。
2. challenge を引き、 未消費・未期限・statement の `document_sha256` が現物と一致。
3. assertion 検証 (origin / rpId / type=webauthn.get / challenge 一致 / UP フラグ / signCount 非後退 /
   署名を保存済み公開鍵で検証)。 失敗は 400、 鍵不一致は 404 (列挙回避)。
4. 監査行 (`invoice_share_acceptances`) を `authentication_method='passkey'` で追記。 statement 全文、
   clientDataJSON、 authenticatorData、 signature、 credential_id、 公開鍵指紋を保存 (§4)。
5. `evidence_sha256` = 署名・鍵を含む canonical 証跡の SHA-256。 これを TSA へ打刻依頼 (§3.4)。
6. 受領者へ証跡バンドルをメール添付で送信 (§3.5)。 送信失敗は合意を取り消さない (証跡は
   `evidence.json` から再取得できる)。 ログに `evidence_mail_failed` を残す。

### 3.4 RFC 3161 タイムスタンプ (`rfc3161-timestamp-client.ts`)

- TimeStampReq DER: `SEQUENCE { version 1, messageImprint { sha256 OID 2.16.840.1.101.3.4.2.1, OCTET STRING },
  nonce INTEGER(random 64bit), certReq TRUE }` を手書きエンコード。
- `POST <tsa.url>` `Content-Type: application/timestamp-query`、 応答 `application/timestamp-reply`。
- 応答は `TimeStampResp.status.status` (0=granted, 1=grantedWithMods) だけ DER から読み、 raw DER を
  `timestamp_token` に保存。 genTime の抽出は行わず、 第三者検証は
  `openssl ts -verify -digest <evidence_sha256> -in token.tsr -CAfile <TSA cacert>` を README に記す。
- 状態: `timestamp_status ∈ {pending, granted, failed}`。 合意確定時に 1 回同期試行 (timeout 10 s)。
  失敗/timeout は `pending` のままにし、 `EvidenceTimestampRetryJob` (起動時 + 1 時間毎、 最大 7 日)
  が `pending` 行を再試行。 `failed` は 7 日超過で確定。
- 設定: `invoiceShare.timestampAuthority.url` (既定 `https://freetsa.org/tsr`)、 `enabled` (既定 true)、
  env 上書き `QUAESTOR_TSA_URL` / `QUAESTOR_TSA_ENABLED`。 無効時は `status='skipped'`。

### 3.5 証跡バンドル (`invoice-acceptance-evidence-bundle.ts`)

```json
{
  "format": "quaestor-invoice-acceptance-evidence-v1",
  "statement": { …§3.2… },
  "assertion": { "client_data_json_b64url": "…", "authenticator_data_b64url": "…", "signature_b64url": "…" },
  "credential": { "id_b64url": "…", "public_key_jwk": {...}, "public_key_sha256": "…", "algorithm": -7 },
  "acceptance": { "accepted_at": 1787130123, "evidence_sha256": "…" },
  "timestamp": { "authority": "https://freetsa.org/tsr", "status": "granted", "token_der_b64": "…" } | { "status": "pending" },
  "verify": "docs/invoice-acceptance-evidence-verification.md の手順"
}
```

- 受領者宛メール: 件名「【Qs】請求内容への合意の控え (署名証跡)」、 本文に文書識別子と検証手順 URL、
  添付 `invoice-acceptance-<shareIdの先頭8>.json`。 SESv2 `Content.Raw` (MIME multipart を手組み、
  `ses-email-client.ts` に `attachments` を追加)。 タイムスタンプが `pending` のまま送る場合は本文に
  その旨を書き、 granted 後に `evidence.json` で最新版を取れることを案内する (再送メールは出さない)。
- 発行者 (管理) 側: `GET /v1/invoices/:id/share-links/:shareId/acceptance/evidence` で同じ JSON。

### 3.6 管理 (Cloudflare Access 内)

- `GET /v1/invoice-delivery-contacts/:id/passkeys` (id, 指紋, 登録日, enrolled_via, 失効日)
- `POST /v1/invoice-delivery-contacts/:id/passkeys/:passkeyId/revoke`
- web: `InvoiceDeliveryContacts.tsx` に「パスキー: 登録 n 件 / 指紋先頭 12 桁 / 失効」表示と失効ボタン。

## 4. スキーマ (version 15)

```sql
CREATE TABLE invoice_recipient_passkeys (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES invoice_delivery_contacts(id) ON DELETE CASCADE,
  recipient_email_sha256 TEXT NOT NULL,             -- 登録時の宛先 identity。メール変更後へ鍵を持ち越さない
  credential_id TEXT NOT NULL UNIQUE,          -- base64url
  public_key_cose TEXT NOT NULL,               -- base64url(COSE_Key)
  public_key_sha256 TEXT NOT NULL CHECK (length(public_key_sha256) = 64),
  algorithm INTEGER NOT NULL,                  -- COSE alg (-7 ES256 / -257 RS256)
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                             -- JSON array
  aaguid TEXT,
  enrolled_via TEXT NOT NULL CHECK (enrolled_via IN ('email_otp','contract_fingerprint')),
  enrollment_challenge_id TEXT,                -- OTP challenge の id (email_otp のとき)
  enrolled_share_id TEXT REFERENCES invoice_share_tokens(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_invoice_recipient_passkey_contact ON invoice_recipient_passkeys(contact_id, revoked_at);

CREATE TABLE invoice_share_webauthn_challenges (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','assert')),
  statement_json TEXT,                         -- assert のみ
  challenge_hash TEXT NOT NULL CHECK (length(challenge_hash) = 64),
  enrollment_grant_id TEXT,                    -- register のみ (OTP 通過で発行)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_invoice_share_webauthn_challenge_share ON invoice_share_webauthn_challenges(share_id, created_at);

CREATE TABLE invoice_share_enrollment_grants (   -- OTP 通過 → パスキー登録許可 (15 分・1 回)
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES invoice_share_tokens(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  otp_challenge_id TEXT NOT NULL,
  grant_hash TEXT NOT NULL CHECK (length(grant_hash) = 64),  -- HMAC(token, id)
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);

-- invoice_share_acceptances 追加列 (ensureColumn)
authentication_method: 'passkey' を許容 (既存値はそのまま)
passkey_id TEXT, credential_id TEXT, statement_json TEXT,
client_data_json TEXT, authenticator_data_b64url TEXT, assertion_signature_b64url TEXT,
public_key_sha256 TEXT,
timestamp_status TEXT NOT NULL DEFAULT 'skipped',   -- pending|granted|failed|skipped
timestamp_authority TEXT, timestamp_token BLOB, timestamp_requested_at INTEGER,
timestamp_granted_at INTEGER, timestamp_attempts INTEGER NOT NULL DEFAULT 0, timestamp_last_error TEXT
```

`evidence_sha256` の対象は「タイムスタンプ以外の全証跡 (statement/assertion/credential/accepted_at)」。
既存 `email_otp` 行の `evidence_sha256` 計算は変えない (互換)。

## 5. 変更ファイル一覧

| 操作 | パス | 内容 |
|---|---|---|
| 新規 | `src/db/invoice-recipient-passkey-repo.ts` | パスキー CRUD + signCount 更新 + 失効 |
| 新規 | `src/db/invoice-share-webauthn-challenge-repo.ts` | challenge 発行/消費 |
| 新規 | `src/db/invoice-share-enrollment-grant-repo.ts` | OTP 通過 grant |
| 変更 | `src/db/invoice-share-acceptance-repo.ts` | passkey 列・timestamp 列、 `updateTimestamp`、 `listTimestampPending` |
| 変更 | `src/db/schema.ts` | §4、 `user_version = 15` |
| 新規 | `src/services/invoice-acceptance-statement.ts` | statement 正規化・challenge 導出・検証 (純粋関数) |
| 新規 | `src/services/invoice-passkey-service.ts` | 登録/assertion の options 生成と検証 (判断 C: `@simplewebauthn/server` ラッパ、 または `webauthn/` 自作 3 ファイル) |
| 新規 | `src/services/invoice-share-passkey-acceptance-service.ts` | §3.3 の合意確定ユースケース |
| 変更 | `src/services/invoice-share-acceptance-service.ts` | `confirm` の結果を「合意」から「enrollment grant 発行」へ。 クラス名は維持、 責務は OTP ゲートへ |
| 新規 | `src/services/rfc3161-timestamp-client.ts` | DER 要求/応答、 fetch |
| 新規 | `src/services/evidence-timestamp-service.ts` | 同期 1 回 + 再試行ジョブ、 状態遷移 |
| 新規 | `src/services/invoice-acceptance-evidence-bundle.ts` | バンドル JSON 生成 (純粋) |
| 新規 | `src/services/invoice-acceptance-evidence-mailer.ts` | バンドル添付メール |
| 変更 | `src/services/invoice-email-notifier.ts` / `ses-email-client.ts` | `attachments` (Raw MIME) |
| 変更 | `src/services/app-config.ts` | `invoiceShare.timestampAuthority` |
| 新規 | `src/api/invoice-share-passkeys.ts` | `/share/:token/passkey/*`, `/share/:token/evidence.json`, `/share/passkey.js` |
| 変更 | `src/api/invoice-shares.ts` | OTP 成功後の遷移先をパスキー登録ページへ、 acceptance evidence GET、 CSP 追記 |
| 変更 | `src/api/invoice-delivery-contacts.ts` | passkeys list / revoke |
| 新規 | `src/invoices/invoice-share-passkey-page.ts` | 登録ページ / 合意ページ (JS は静的配信) |
| 新規 | `src/invoices/assets/invoice-share-passkey.js` | `credentials.create/get` → fetch JSON。 base64url ヘルパ込み、 依存なし |
| 変更 | `src/invoices/invoice-share-page.ts` | 合意ボタンの分岐・法的注記文言更新 |
| 変更 | `src/app.ts` | 配線、 再試行ジョブ起動 (production entrypoint のみ) |
| 変更 | `web/src/components/InvoiceDeliveryContacts.tsx` | パスキー表示・失効 |
| 新規 | `docs/invoice-acceptance-evidence-verification.md` | 受領者/第三者向け検証手順 (openssl / WebCrypto) |
| 変更 | `spec/feature/invoice-public-magic-link.md` | Explicit acceptance 節・clauses (ACCEPTANCE-001/002/003 改訂、 005〜008 追加)、 storage migration v15、 法的注記 |
| 変更 | `spec/setup/config-and-secrets.md` | TSA 設定行 |
| 変更 | `package.json` | 判断 C=採用時のみ `@simplewebauthn/server` |
| 新規 | `tests/invoice-acceptance-statement.test.ts`, `tests/invoice-passkey-acceptance.test.ts`, `tests/rfc3161-timestamp-client.test.ts`, `tests/invoice-acceptance-evidence-bundle.test.ts` | §6 |
| 変更 | `tests/invoice-shares.test.ts` | OTP 成功が合意を作らないことへ更新 |

## 6. テスト

- statement: canonical 化の安定性、 challenge 導出、 `document_sha256` 不一致の検出。
- passkey 受入 (e2e, buildApp): テスト内で ES256 鍵対を `node:crypto` で作り、 authenticatorData と
  clientDataJSON を組み立てて署名する疑似認証器を用意 → 登録 → assertion → 合意行が `passkey`、
  evidence.json が返る、 2 回目は冪等。 不正 origin / 期限切れ challenge / 他 share の challenge /
  signCount 後退 / 改竄 PDF (409) / 失効パスキー は全部 4xx で合意無し。
- OTP ゲート: 成功で grant が出て合意は作られない。 grant 期限切れ・再利用は 4xx。
- RFC3161: 固定 nonce で要求 DER のバイト列をスナップショット、 granted/rejected/timeout の状態遷移、
  再試行ジョブが pending だけを拾う。
- バンドル: 署名検証をバンドルだけから (DB を見ずに) 再現できること。
- SES Raw MIME: 添付ありメッセージのヘッダ/boundary/base64 の形。
- 実機: Excubitor 経由で起動後、 ブラウザ (自分の Windows Hello) で登録 → 合意 → メール受信 →
  `openssl ts -verify` までを手動確認 (Revisor 後、 neco 立会いの任意項目)。

## 7. やらないこと

- 認定認証事業者の電子証明書・eシール、 政府 ID 確認。
- OTP コードの完全削除 (判断 A=代替案が選ばれたら次 PR で削除)。
- OpenTimestamps。
- 管理 UI からのパスキー事前登録 (判断 A=代替案用の経路、 schema だけ予約)。
