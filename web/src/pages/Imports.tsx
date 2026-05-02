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

const BRANDS = ["", "ufj", "smbc", "amazon-order-history", "smbc-bank"];

export function Imports() {
  const [list, setList] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [brand, setBrand] = useState("");
  const [account, setAccount] = useState("");
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<PostResult | null>(null);

  async function refresh() {
    try {
      const j = await (await fetch("/v1/imports?limit=50")).json() as { items: ImportRow[] };
      setList(j.items);
      setLoading(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function upload() {
    if (!file) return;
    setPosting(true);
    setErr(null);
    setResult(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // base64 encode (chunked to avoid stack overflow on big files)
      let s = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        s += String.fromCharCode(...buf.subarray(i, i + chunk));
      }
      const b64 = btoa(s);
      const body: Record<string, unknown> = {
        content_b64: b64,
        filename: file.name,
      };
      if (brand) body.brand = brand;
      if (account) body.account = account;
      const res = await fetch("/v1/imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
        <div style={{ display: "grid", gap: "0.5rem", maxWidth: 500 }}>
          <label>
            ファイル: <input type="file" accept=".csv,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            brand:
            <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ marginLeft: "0.5rem" }}>
              {BRANDS.map((b) => <option key={b} value={b}>{b || "(auto-detect)"}</option>)}
            </select>
          </label>
          <label>
            account 上書き:
            <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="例: SMBC-NL" style={{ marginLeft: "0.5rem" }} />
          </label>
          <button className="btn" onClick={() => void upload()} disabled={!file || posting}>
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
