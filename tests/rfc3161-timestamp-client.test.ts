import { describe, it, expect } from "vitest";
import {
  Rfc3161Error,
  Rfc3161TimestampClient,
  encodeTimeStampReq,
  readPkiStatus,
} from "../src/services/rfc3161-timestamp-client.js";
import { fakeRfc3161Response, tlv } from "./helpers/fake-rfc3161.js";

const IMPRINT = "ab".repeat(32);
const NONCE = Buffer.from("0102030405060708", "hex");

function response(status: number, imprint = IMPRINT, nonce = NONCE): Buffer {
  return fakeRfc3161Response({ status, imprint: Buffer.from(imprint, "hex"), nonce });
}

describe("Rfc3161TimestampClient", () => {
  it("TimeStampReq の DER は固定 (version 1 / sha256 imprint / nonce / certReq TRUE)", () => {
    const der = encodeTimeStampReq(Buffer.from(IMPRINT, "hex"), NONCE);
    expect(der.toString("hex")).toBe(
      "3043" // SEQUENCE, 67 bytes
      + "020101" // version 1
      + "3031300d060960864801650304020105000420" + IMPRINT // messageImprint
      + "0208" + "0102030405060708" // nonce
      + "0101ff", // certReq TRUE
    );
    // 先頭ビットが立つ nonce は 0x00 前置で正の INTEGER になる
    expect(encodeTimeStampReq(Buffer.from(IMPRINT, "hex"), Buffer.from("ff", "hex")).toString("hex")).toContain("020200ff");
  });

  it("granted 応答は raw DER を返し、 imprint / nonce が含まれない応答や拒否は失敗にする", async () => {
    const seen: { url: string; contentType: string | undefined; redirect: RequestRedirect | undefined }[] = [];
    const make = (body: Buffer, status = 200) => new Rfc3161TimestampClient({
      url: "https://tsa.example/tsr",
      nonceFactory: () => NONCE,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          contentType: (init?.headers as Record<string, string>)["content-type"],
          redirect: init?.redirect,
        });
        return new Response(new Uint8Array(body), { status });
      },
    });
    const granted = await make(response(0)).timestamp(IMPRINT);
    expect(granted.status).toBe(0);
    expect(granted.response.equals(response(0))).toBe(true);
    expect(seen[0]).toEqual({
      url: "https://tsa.example/tsr",
      contentType: "application/timestamp-query",
      redirect: "error",
    });
    expect((await make(response(1)).timestamp(IMPRINT)).status).toBe(1);

    await expect(make(response(2)).timestamp(IMPRINT)).rejects.toMatchObject({ code: "rejected" });
    await expect(make(response(0, "cd".repeat(32))).timestamp(IMPRINT)).rejects.toMatchObject({ code: "mismatch" });
    await expect(make(response(0, IMPRINT, Buffer.from("0909090909090909", "hex"))).timestamp(IMPRINT)).rejects.toMatchObject({ code: "mismatch" });
    const statusInfo = tlv(0x30, tlv(0x02, Buffer.from([0])));
    const unrelatedBytes = tlv(0x30, Buffer.concat([
      tlv(0x04, Buffer.from(IMPRINT, "hex")),
      tlv(0x02, NONCE),
    ]));
    await expect(make(tlv(0x30, Buffer.concat([statusInfo, unrelatedBytes]))).timestamp(IMPRINT))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(make(Buffer.from("not der")).timestamp(IMPRINT)).rejects.toBeInstanceOf(Rfc3161Error);
    await expect(make(Buffer.from([0x30, 0x81, 0xff, 0x00])).timestamp(IMPRINT))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(make(Buffer.alloc(64 * 1024 + 1)).timestamp(IMPRINT))
      .rejects.toMatchObject({ code: "malformed" });
    await expect(make(response(0), 500).timestamp(IMPRINT)).rejects.toMatchObject({ code: "transport" });
    await expect(make(response(0)).timestamp("zz")).rejects.toMatchObject({ code: "malformed" });
    expect(() => new Rfc3161TimestampClient({ url: "http://127.0.0.1/tsr" }))
      .toThrowError(Rfc3161Error);
    expect(() => new Rfc3161TimestampClient({ url: "https://user:secret@tsa.example/tsr" }))
      .toThrowError(Rfc3161Error);
  });

  it("通信例外は transport として扱う", async () => {
    const client = new Rfc3161TimestampClient({ fetchImpl: async () => { throw new Error("down"); } });
    await expect(client.timestamp(IMPRINT)).rejects.toMatchObject({ code: "transport" });
    expect(client.url).toBe("https://freetsa.org/tsr");
  });

  it("readPkiStatus は SEQ → SEQ → INTEGER だけを読む", () => {
    expect(readPkiStatus(response(0))).toBe(0);
    expect(readPkiStatus(response(5))).toBe(5);
    expect(() => readPkiStatus(Buffer.from([0x04, 0x01, 0x00]))).toThrow(Rfc3161Error);
  });
});
