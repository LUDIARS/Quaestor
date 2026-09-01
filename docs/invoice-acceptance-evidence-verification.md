# 請求内容への合意 — 証跡バンドルの検証手順

Quaestor が合意時に送る `invoice-acceptance-XXXXXXXX.json` (format
`quaestor-invoice-acceptance-evidence-v1`) は、 送信元のデータベースを一切参照せずに次の 3 点を
第三者が確認できるように作られています。

1. **誰が**: `credential.public_key_*` の鍵に対応する秘密鍵の保持者が署名した (秘密鍵は署名者の端末にしか存在しない)
2. **何に**: 署名対象 (`statement`) に請求書 PDF の SHA-256 と合意文言が含まれている
3. **いつ**: `timestamp.token_der_b64` (RFC 3161) が、 証跡のハッシュがその時刻に存在したことを外部機関の署名で示す

## 0. バンドルの構造

| 欄 | 内容 |
|---|---|
| `statement` | 署名対象。 `document_sha256` (PDF の SHA-256)、 `agreement_text`、 `share_id`、 `nonce`、 `expires_at` 等 |
| `assertion.client_data_json_b64url` | ブラウザが組み立てた clientDataJSON。 `challenge` に statement のハッシュが入る |
| `assertion.authenticator_data_b64url` | 認証器データ (RP ID ハッシュ・フラグ・カウンタ) |
| `assertion.signature_b64url` | `authenticatorData ‖ SHA-256(clientDataJSON)` への署名 (ES256 は ECDSA/DER、 RS256 は RSASSA-PKCS1-v1_5) |
| `credential.public_key_spki_pem` / `public_key_jwk` / `public_key_cose_b64url` | 同じ公開鍵の 3 表現。 `public_key_sha256` は COSE bytes の SHA-256 (指紋) |
| `acceptance.evidence_sha256` | タイムスタンプ対象の証跡ハッシュ |
| `timestamp` | `granted` なら RFC 3161 TimeStampResp (DER, base64) と TSA の URL |

## 1. PDF が署名対象と一致するか

```bash
sha256sum invoice.pdf          # Linux/macOS
Get-FileHash invoice.pdf -Algorithm SHA256   # PowerShell
```

出力が `statement.document_sha256` と一致すれば、 手元の PDF が署名された文書です。

## 2. challenge が statement から導かれているか

```bash
# statement をキー昇順・空白なしで直列化し、 SHA-256 を base64url にする
node -e '
const b = require("./invoice-acceptance-XXXXXXXX.json");
const canon = JSON.stringify(Object.fromEntries(Object.entries(b.statement).sort(([x],[y]) => x < y ? -1 : 1)));
const ch = require("crypto").createHash("sha256").update(canon).digest("base64url");
const cd = JSON.parse(Buffer.from(b.assertion.client_data_json_b64url, "base64url"));
console.log(ch === cd.challenge ? "challenge OK" : "challenge MISMATCH", cd.type, cd.origin);
'
```

`type` は `webauthn.get`、 `origin` は送信元のマジックリンク origin (例 `https://qs-magiclink.ai-run-do.com`) です。

## 3. 署名の検証

```bash
node -e '
const b = require("./invoice-acceptance-XXXXXXXX.json");
const crypto = require("crypto");
const cd = Buffer.from(b.assertion.client_data_json_b64url, "base64url");
const ad = Buffer.from(b.assertion.authenticator_data_b64url, "base64url");
const sig = Buffer.from(b.assertion.signature_b64url, "base64url");
const v = crypto.createVerify("SHA256");
v.update(Buffer.concat([ad, crypto.createHash("sha256").update(cd).digest()]));
console.log(v.verify(b.credential.public_key_spki_pem, sig) ? "signature OK" : "signature INVALID");
'
```

`openssl` でも確認できます (ES256 の場合):

```bash
node -e 'const b=require("./invoice-acceptance-XXXXXXXX.json");process.stdout.write(b.credential.public_key_spki_pem)' > pub.pem
node -e 'const b=require("./invoice-acceptance-XXXXXXXX.json");const c=require("crypto");process.stdout.write(Buffer.concat([Buffer.from(b.assertion.authenticator_data_b64url,"base64url"),c.createHash("sha256").update(Buffer.from(b.assertion.client_data_json_b64url,"base64url")).digest()]))' > signed.bin
node -e 'const b=require("./invoice-acceptance-XXXXXXXX.json");process.stdout.write(Buffer.from(b.assertion.signature_b64url,"base64url"))' > sig.der
openssl dgst -sha256 -verify pub.pem -signature sig.der signed.bin
```

公開鍵指紋 `credential.public_key_sha256` は、 契約書や管理画面に記載された指紋と突き合わせます。

## 4. 外部タイムスタンプの検証 (RFC 3161)

まず、配布 JSON だけからタイムスタンプ対象のハッシュを再計算します。`timestamp`、公開鍵の派生表現
(`public_key_spki_pem` / `public_key_jwk`)、表示用の `accepted_at_iso`、ハッシュ自身は対象外です。

```bash
node -e '
const b=require("./invoice-acceptance-XXXXXXXX.json"),c=require("crypto");
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const p={format:b.format,statement:b.statement,assertion:b.assertion,
credential:{id_b64url:b.credential.id_b64url,algorithm:b.credential.algorithm,public_key_cose_b64url:b.credential.public_key_cose_b64url,public_key_sha256:b.credential.public_key_sha256},
acceptance:{acceptance_id:b.acceptance.acceptance_id,share_id:b.acceptance.share_id,invoice_id:b.acceptance.invoice_id,accepted_at:b.acceptance.accepted_at,document_sha256:b.acceptance.document_sha256,agreement_version:b.acceptance.agreement_version,agreement_text:b.acceptance.agreement_text}};
const digest=c.createHash("sha256").update(JSON.stringify(sort(p))).digest("hex");
console.log(digest===b.acceptance.evidence_sha256?"evidence digest OK":"evidence digest MISMATCH",digest);
'
```

`evidence digest OK` を確認したうえで、同じ値が TSA の署名対象かを検証します。

```bash
node -e 'const b=require("./invoice-acceptance-XXXXXXXX.json");process.stdout.write(Buffer.from(b.timestamp.token_der_b64,"base64"))' > token.tsr
# TSA の CA 証明書 (FreeTSA の場合 https://freetsa.org/files/cacert.pem)
openssl ts -reply -in token.tsr -text            # genTime (打刻時刻) と messageImprint を表示
openssl ts -verify -digest <acceptance.evidence_sha256> -in token.tsr -CAfile cacert.pem
```

`messageImprint` が `acceptance.evidence_sha256` と一致し、 `Verification: OK` が出れば、 その証跡は
TSA が記した `genTime` に存在していたことになります。 `timestamp.status` が `pending` のバンドルは
後でマジックリンクの `?view=evidence` から最新版を取得してください。

## 5. 何が保証され、 何が保証されないか

- 保証される: 署名鍵の保持者がこの PDF ハッシュと合意文言を含む statement に署名したこと、
  その証跡が TSA の時刻以前に存在したこと。 送信元の運用者が後から署名を作ることはできない。
- 保証されない: 鍵の保持者が自然人本人であること (端末・認証器の管理は受領側の責任)、
  認定認証事業者による本人確認 (電子署名法 3 条の推定効は主張しない)。
