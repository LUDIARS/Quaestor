import { useEffect, useState } from "react";
import { MailIgnoreGroups } from "../components/MailIgnoreGroups.js";

const KINDS: Record<string, string> = { invoice: "請求書・領収書", cloud_notice: "クラウド通知",
  ci_failure: "CI失敗", dependabot: "依存更新", ignore: "対象外" };
interface MailRow {
  message_id: string; subject: string; from_address: string; kind: string;
  outcome: string; error: string | null; received_at: number; processed_at: number;
}

function resultLabel(outcome: string): string {
  if (outcome.startsWith("ignored: pattern ")) return "共通パターンで除外（LLM不使用）";
  if (outcome.startsWith("committed:")) return "取り込み済み";
  const labels: Record<string, string> = { ignored: "対象外（判定済み）", processing: "処理中",
    needs_review: "要確認", duplicate: "添付重複", error: "解析エラー", notified: "通知済み",
    notification_disabled: "通知無効", notification_failed: "通知失敗", notification_skipped: "通知省略" };
  return labels[outcome] ?? outcome;
}
function timestamp(value: number): string {
  return new Date(value * 1000).toLocaleString("ja-JP");
}

/** Viewing persisted history never starts ingestion or reanalysis. */
export function MailHistory() {
  const [view, setView] = useState<"messages" | "groups">("groups");
  const [group, setGroup] = useState<{ id: string; title: string } | null>(null);
  const [kind, setKind] = useState("");
  const [revision, setRevision] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [items, setItems] = useState<MailRow[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (view !== "messages") return;
    const controller = new AbortController();
    setItems(null); setError(false);
    const query = new URLSearchParams({ offset: String(offset) });
    if (kind) query.set("kind", kind);
    if (group) query.set("group", group.id);
    void fetch(`/v1/mail-history?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("history unavailable");
        const value = await response.json() as { items: MailRow[]; hasMore: boolean };
        if (!Array.isArray(value.items) || typeof value.hasMore !== "boolean") throw new Error("invalid history");
        if (!controller.signal.aborted) { setItems(value.items); setHasMore(value.hasMore); }
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [kind, offset, revision, group, view]);
  return <section className="space-y-4">
    <h1 className="text-xl font-semibold">メール解析履歴</h1>
    <p className="text-sm text-subtle">取得・分類したメールの保存履歴です。対象外のメールも表示します。この画面の閲覧・更新では再解析しません。メール本文は保存していません。</p>
    <div className="flex gap-3">
      <button type="button" aria-pressed={view === "groups"} className="border border-border rounded px-3 py-2" onClick={() => setView("groups")}>除外ルール別グループ</button>
      <button type="button" aria-pressed={view === "messages" && !group} className="border border-border rounded px-3 py-2" onClick={() => { setView("messages"); setGroup(null); setKind(""); setOffset(0); }}>メール一覧</button>
    </div>
    {view === "groups" ? <MailIgnoreGroups onSelect={(id, title) => { setGroup({ id, title }); setKind("ignore"); setOffset(0); setView("messages"); }} /> : <>
    {group && <p className="text-sm">グループ: {group.title} <button type="button" className="underline ml-2" onClick={() => setView("groups")}>グループ一覧へ戻る</button></p>}
    <div className="flex flex-wrap items-center gap-3">
      <label>分類 <select disabled={!!group} className="border border-border bg-surface rounded p-2" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }}>
        <option value="">すべて</option>
        {Object.entries(KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <button type="button" className="border border-border rounded px-3 py-2" onClick={() => { setOffset(0); setRevision((value) => value + 1); }}>履歴を更新</button>
    </div>
    {error && <p role="alert">履歴を取得できません。アクセス権と接続を確認して再度お試しください。</p>}
    {!items && !error && <p role="status">読み込み中…</p>}
    {items && <>
      <p role="status">{items.length > 0 ? `${offset + 1}〜${offset + items.length}件を表示` : "0件"}（受信日時順）</p>
      {items.length === 0 && <p>{kind ? "この分類の履歴はありません。" : "解析履歴はまだありません。"}</p>}
      <ul className="space-y-3">
        {items.map((mail) => <li key={mail.message_id} className="rounded border border-border bg-surface p-4 space-y-2 break-words">
          <div className="flex flex-wrap gap-2 text-sm"><span className="rounded bg-muted px-2 py-1">{KINDS[mail.kind] ?? mail.kind}</span><span>{resultLabel(mail.outcome)}</span></div>
          <h2 className="font-semibold">{mail.subject || "（件名なし）"}</h2>
          <p className="text-sm">差出人: {mail.from_address}</p>
          <p className="text-xs text-subtle">受信: {timestamp(mail.received_at)} ／ 処理: {timestamp(mail.processed_at)}</p>
          {mail.error && <p className="text-sm" role="status">エラー: {mail.error}</p>}
          <details className="text-xs text-subtle"><summary>処理詳細</summary><p>{mail.outcome}</p><p>メールID: {mail.message_id}</p></details>
        </li>)}
      </ul>
      <div className="flex gap-3">
        <button type="button" className="border border-border rounded px-3 py-2 disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>前へ</button>
        <button type="button" className="border border-border rounded px-3 py-2 disabled:opacity-40" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>次へ</button>
      </div>
    </>}
    </>}
  </section>;
}
