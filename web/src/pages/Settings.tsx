import { useEffect, useState } from "react";
import { OcrEvolutionCard } from "../components/ocr-evolution/OcrEvolutionCard";

function WebHostsSection() {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const r = await fetch("/v1/config/web").then((res) => res.json()) as { allowed_hosts: string[] };
      setHosts(r.allowed_hosts);
      setDraft(r.allowed_hosts.join("\n"));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply() {
    const parsed = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await fetch("/v1/config/web", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_hosts: parsed }),
      }).then((res) => res.json()) as { allowed_hosts: string[]; note?: string };
      setHosts(r.allowed_hosts);
      setDraft(r.allowed_hosts.join("\n"));
      if (r.note) setNote(r.note);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const currentJoined = (hosts ?? []).join("\n");
  const parsedDraft = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Web allowedHosts</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Vite dev server が受け付ける外部ホスト名 (quaestor.config.json の <code>web.allowedHosts</code>)。
          <code>localhost</code> / <code>127.0.0.1</code> は常に許可。
          Cloudflare Tunnel・Tailscale 等の外部アクセス用ホスト名を 1 行 1 ホストで登録。
        </p>
        <p className="text-xs text-amber-600 mt-1">変更は dev server 再起動後に反映されます。</p>
      </div>

      <div className="border rounded p-3 space-y-2">
        <div className="text-xs text-gray-500">現在の設定:</div>
        {hosts === null ? (
          <div className="text-sm text-gray-400">...</div>
        ) : hosts.length === 0 ? (
          <div className="text-sm text-gray-400">(未設定)</div>
        ) : (
          <div className="flex flex-col gap-1">
            {hosts.map((h) => (
              <code key={h} className="text-xs bg-green-50 border border-green-200 text-green-800 px-2 py-0.5 rounded">{h}</code>
            ))}
          </div>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder={"quaestor.example.com\nother.example.com"}
          className="w-full border rounded px-2 py-1 text-sm font-mono"
        />

        <button
          disabled={busy || parsedDraft.join("\n") === currentJoined}
          onClick={() => void apply()}
          className="px-3 py-1 bg-blue-50 border border-blue-400 text-blue-700 rounded text-sm disabled:opacity-40"
        >
          apply
        </button>
        {note && <div className="text-xs text-gray-500">{note}</div>}
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </div>
  );
}

export function Settings() {
  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <header>
        <h1 className="text-xl font-bold">設定</h1>
      </header>
      <section>
        <WebHostsSection />
      </section>
      <section>
        <OcrEvolutionCard />
      </section>
    </div>
  );
}
