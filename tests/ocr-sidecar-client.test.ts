import { describe, it, expect } from "vitest";
import { HttpOcrSidecarClient } from "../src/services/ocr-sidecar-client.js";
import { defaultOcrGenome } from "../src/services/ocr-ga.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpOcrSidecarClient", () => {
  it("detect: multipart (image + genome JSON) を /detect に POST し lines と elapsedMs を返す", async () => {
    const seen: Array<{ url: string; genome: string | null; imageName: string | null; redirect: RequestRedirect | undefined }> = [];
    let t = 1000;
    const client = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test/",
      now: () => { t += 500; return t; },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const form = init?.body as FormData;
        const image = form.get("image");
        seen.push({
          url: String(url),
          genome: typeof form.get("genome") === "string" ? (form.get("genome") as string) : null,
          imageName: image instanceof Blob && "name" in image ? String((image as { name: string }).name) : null,
          redirect: init?.redirect,
        });
        return jsonResponse({
          lines: [
            { polygon: [[0, 0], [10, 0], [10, 5], [0, 5]], bbox: [0, 0, 10, 5], text: "合計 4080", score: 0.9 },
            { bbox: "broken", text: "skip" },
          ],
          width: 600, height: 1000,
        });
      }) as typeof fetch,
    });

    const res = await client.detect(Buffer.from("jpg"), defaultOcrGenome(), "r1.jpg");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://sidecar.test/detect");
    expect(JSON.parse(seen[0]!.genome!)).toEqual(defaultOcrGenome());
    expect(seen[0]!.imageName).toBe("r1.jpg");
    expect(seen[0]!.redirect).toBe("error");
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]!.text).toBe("合計 4080");
    expect(res.width).toBe(600);
    expect(res.elapsedMs).toBe(500);
  });

  it("detect: 200 以外は例外", async () => {
    const client = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      fetchImpl: (async () => jsonResponse({ detail: "boom" }, 500)) as typeof fetch,
    });
    await expect(client.detect(Buffer.from("x"), defaultOcrGenome())).rejects.toThrow("/detect 500");
  });

  it("detect: タイムアウトで abort して例外 (timer は解放)", async () => {
    const client = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      timeoutMs: 20,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch,
    });
    await expect(client.detect(Buffer.from("x"), defaultOcrGenome())).rejects.toThrow(/timed out after 20 ms/);
  });

  it("detect: 1 並列に直列化する (前の応答が返るまで次を送らない)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const client = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      fetchImpl: (() => new Promise<Response>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        resolvers.push(() => { inFlight -= 1; resolve(jsonResponse({ lines: [], width: 1, height: 1 })); });
      })) as typeof fetch,
    });

    const a = client.detect(Buffer.from("a"), defaultOcrGenome());
    const b = client.detect(Buffer.from("b"), defaultOcrGenome());
    await Promise.resolve();
    expect(resolvers).toHaveLength(1); // 2 件目はまだ送られていない
    resolvers[0]!();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvers).toHaveLength(2);
    resolvers[1]!();
    await b;
    expect(maxInFlight).toBe(1);
  });

  it("detect: 失敗しても次の detect は流れる", async () => {
    let n = 0;
    const client = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      fetchImpl: (async () => (n++ === 0 ? jsonResponse({}, 503) : jsonResponse({ lines: [], width: 1, height: 1 }))) as typeof fetch,
    });
    await expect(client.detect(Buffer.from("a"), defaultOcrGenome())).rejects.toThrow();
    await expect(client.detect(Buffer.from("b"), defaultOcrGenome())).resolves.toBeTruthy();
  });

  it("health: device 情報を読む (旧 sidecar の無い項目は null)", async () => {
    const withDevice = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      fetchImpl: (async () => jsonResponse({ ok: true, model: "PP-OCRv5/japan", paddleocr_major: 3, device: "cpu", requested_device: "gpu", device_error: "no CUDA device visible" })) as typeof fetch,
    });
    expect(await withDevice.health()).toEqual({
      ok: true, model: "PP-OCRv5/japan", device: "cpu", requestedDevice: "gpu", deviceError: "no CUDA device visible", paddleocrMajor: 3,
    });

    const legacy = new HttpOcrSidecarClient({
      baseUrl: "http://sidecar.test",
      fetchImpl: (async () => jsonResponse({ ok: true, model: "PP-OCRv5/japan" })) as typeof fetch,
    });
    const h = await legacy.health();
    expect(h.device).toBeNull();
    expect(h.deviceError).toBeNull();
  });

  it("baseUrl の credential と非 HTTP scheme を拒否する", () => {
    expect(() => new HttpOcrSidecarClient({ baseUrl: "http://user:secret@sidecar.test" })).toThrow(/without credentials/);
    expect(() => new HttpOcrSidecarClient({ baseUrl: "file:///tmp/sidecar" })).toThrow(/HTTP/);
  });
});
