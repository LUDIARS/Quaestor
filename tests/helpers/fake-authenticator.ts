/**
 * テスト用の疑似 WebAuthn 認証器。 ES256 鍵対を持ち、 registration / assertion の応答 JSON を
 * ブラウザと同じ形で組み立てる。 CBOR は必要最小限 (map / bstr / tstr / int / array) だけ実装する。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

export interface FakeRegistrationOptions {
  challenge: string;
  rp: { id?: string };
}

export interface FakeAssertionOptions {
  challenge: string;
  rpId?: string;
}

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  counter: number;

  constructor(options: { counter?: number } = {}) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = randomBytes(16);
    this.counter = options.counter ?? 0;
  }

  get credentialIdB64url(): string {
    return this.credentialId.toString("base64url");
  }

  /** COSE_Key (EC2 / P-256 / ES256) の CBOR bytes。 */
  cosePublicKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return cborMap([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
  }

  register(options: FakeRegistrationOptions, origin: string, overrides: { rpId?: string; flags?: number } = {}) {
    const rpId = overrides.rpId ?? options.rp.id ?? new URL(origin).hostname;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false,
    }));
    const flags = overrides.flags ?? (0x01 | 0x04 | 0x40); // UP | UV | AT
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId), Buffer.from([flags]), uint32(this.counter),
      Buffer.alloc(16), credIdLen, this.credentialId, this.cosePublicKey(),
    ]);
    const attestationObject = cborMap([
      ["fmt", "none"], ["attStmt", cborMap([])], ["authData", authData],
    ]);
    return {
      id: this.credentialIdB64url,
      rawId: this.credentialIdB64url,
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
    };
  }

  assert(options: FakeAssertionOptions, origin: string, overrides: {
    rpId?: string; flags?: number; counter?: number; challenge?: string; tamperSignature?: boolean;
  } = {}) {
    const rpId = overrides.rpId ?? options.rpId ?? new URL(origin).hostname;
    const challenge = overrides.challenge ?? options.challenge;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge, origin, crossOrigin: false,
    }));
    const counter = overrides.counter ?? ++this.counter;
    const flags = overrides.flags ?? (0x01 | 0x04);
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), uint32(counter)]);
    const signer = createSign("SHA256");
    signer.update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
    let signature = signer.sign(this.privateKey);
    if (overrides.tamperSignature) signature = Buffer.concat([signature.subarray(0, -1), Buffer.from([signature.at(-1)! ^ 0x01])]);
    return {
      id: this.credentialIdB64url,
      rawId: this.credentialIdB64url,
      type: "public-key" as const,
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: null,
      },
    };
  }
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

// ---- 最小 CBOR エンコーダ ----------------------------------------------------

type CborValue = number | string | Buffer | CborValue[] | Map<CborValue, CborValue> | Buffer;

function cborMap(entries: [number | string, CborValue][]): Buffer {
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [encode(k), encode(v)])]);
}

function encode(value: CborValue): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encode)]);
  throw new Error("unsupported CBOR value");
}

function head(major: number, length: number): Buffer {
  const m = major << 5;
  if (length < 24) return Buffer.from([m | length]);
  if (length < 0x100) return Buffer.from([m | 24, length]);
  if (length < 0x10000) { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(length, 1); return b; }
  const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(length, 1); return b;
}
