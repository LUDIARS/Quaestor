import { useEffect, useState } from "react";

interface ImportRow {
  id: number;
  source: string;
  brand: string | null;
  account: string | null;
  filename: string | null;
  imported_at: number;
  metadata: string | null;
}

interface PostResult {
  import_id: number;
  brand: string;
  account: string;
  parsed: number;
  inserted: number;
  duplicates: number;
  warnings: string[];
}

type Mode = "file" | "text" | "screenshot";

const BRANDS = ["", "ufj", "smbc", "amazon-order-history", "smbc-bank"];

export function Imports() {
  const [list, setList] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [brand, setBrand] = useState("");
  const [account, setAccount] = useState("");
  const [smartEnabled, setSmartEnabled] = useState(false);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<PostResult | null>(null);

  async function refresh() {
    try {
      const [j, h] = await Promise.all([
        fetch("/v1/imports?limit=50").then((r) => r.json() as Promise<{ items: ImportRow[] }>),
        fetch("/health").then((r) => r.json() as Promise<{ ocr_enabled?: boolean }>),
      ]);
      setList(j.items);
      setSmartEnabled(!!h.ocr_enabled);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function bytesToB64(buf: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buf);
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  async function upload() {
    setPosting(true);
    setErr(null);
    setResult(null);
    try {
      let res: Response;
      if (mode === "file") {
        if (!file) throw new Error("ファイル未選択");
        const b64 = await bytesToB64(await file.arrayBuffer());
        const body: Record<string, unknown> = { content_b64: b64, filename: file.name };
        if (brand) body.brand = brand;
        if (account) body.account = account;
        res = await fetch("/v1/imports", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (mode === "text") {
        if (text.trim().length < 10) throw new Error("テキストが短すぎる");
        res = await fetch("/v1/imports/smart-text", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, account: account || undefined }),
        });
      } else {
        if (!screenshot) throw new Error("スクショ未選択");
        const b64 = await bytesToB64(await screenshot.arrayBuffer());
        const ext = screenshot.type.includes("png") ? "png" : "jpg";
        res = await fetch("/v1/imports/smart-screenshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image_b64: b64, ext, account: account || undefined }),
        });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string; supported_brands?: string[] };
        throw new Error(j.error ?? `${res.status}`);
      }
      const j = await res.json() as PostResult;
      setResult(j);
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div>
      <h2>Imports</h2>

      <section style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "1rem", borderRadius: 6, marginBottom: "1.5rem" }}>
        <h3 style={{ marginTop: 0, fontSize: "1rem" }}>新規取込</h3>
        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.75rem" }}>
          {(["file", "text", "screenshot"] as Mode[]).map((m) => (
            <button key={m}
              className="btn secondary"
              onClick={() => setMode(m)}
              disabled={(m !== "file") && !smartEnabled}
              title={(m !== "file") && !smartEnabled ? "ANTHROPIC_API_KEY 設定で有効化" : ""}
              style={{
                borderBottom: mode === m ? "2px solid var(--accent)" : "2px solid transparent",
                fontSize: "0.85rem",
                padding: "0.3rem 0.7rem",
              }}
            >
              {m === "file" ? "CSV / PDF" : m === "text" ? "テキスト貼付" : "スクショ"}
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gap: "0.5rem", maxWidth: 600 }}>
          {mode === "file" && (
            <>
              <label>
                ファイル: <input type="file" accept=".csv,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <label>
                brand:
                <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ marginLeft: "0.5rem" }}>
                  {BRANDS.map((b) => <option key={b} value={b}>{b || "(auto-detect)"}</option>)}
                </select>
              </label>
            </>
          )}
          {mode === "text" && (
            <>
              <label>
                テキスト (クレカ / 銀行明細を copy-paste):
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
                placeholder="2025/4/15  サイゼリヤ  1,820 円&#10;..."
              />
              <small style={{ color: "var(--muted)" }}>
                Claude vision/text で抽出 → transactions に insert。 ANTHROPIC_API_KEY が必要。
              </small>
            </>
          )}
          {mode === "screenshot" && (
            <>
              <label>
                スクショ (jpg/png): <input type="file" accept="image/*" onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)} />
              </label>
              <small style={{ color: "var(--muted)" }}>
                Claude vision で取引行を抽出 → transactions に insert。 ANTHROPIC_API_KEY が必要。
              </small>
            </>
          )}
          <label>
            account 上書き:
            <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="例: SMBC-NL" style={{ marginLeft: "0.5rem" }} />
          </label>
          <button className="btn" onClick={() => void upload()} disabled={posting}>
            {posting ? "uploading…" : "取込"}
          </button>
        </div>
        {err && <p className="error">{err}</p>}
        {result && (
          <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
            ✓ {result.brand} / {result.account} ｜ parsed: <strong>{result.parsed}</strong> ｜
            inserted: <strong style={{ color: "var(--ok)" }}>{result.inserted}</strong> ｜
            duplicates: {result.duplicates}
            {result.warnings.length > 0 && (
              <details style={{ marginTop: "0.5rem" }}>
                <summary style={{ cursor: "pointer" }}>warnings ({result.warnings.length})</summary>
                <pre style={{ fontSize: "0.75rem", overflow: "auto" }}>{result.warnings.join("\n")}</pre>
              </details>
            )}
          </div>
        )}
      </section>

      <h3 style={{ fontSize: "1rem" }}>取込履歴 ({list.length})</h3>
      {loading ? <p>loading…</p> : list.length === 0 ? <p style={{ color: "var(--muted)" }}>まだ取込なし</p> : (
        <ul style={{ display: "grid", gap: "0.5rem", listStyle: "none", padding: 0 }}>
          {list.map((r) => (
            <li key={r.id} className="last-capture">
              <code>#{r.id}</code> ｜ source: <strong>{r.source}</strong> ｜ brand: {r.brand ?? "-"} ｜ account: {r.account ?? "-"}
              <br />
              filename: {r.filename ?? "(なし)"} ｜ {new Date(r.imported_at * 1000).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
