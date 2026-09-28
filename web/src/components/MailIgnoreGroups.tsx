import { useEffect, useState } from "react";

interface Group { id: string; count: number; sender: string; subject: string;
  lastReceived: number; state: string; ruleId: string | null }
const LABELS: Record<string, string> = { auto: "有効ルール", trial: "試行ルール", candidate: "ルール候補",
  retired: "撤回済み", ineligible: "自動ルール化対象外", unprofiled: "特徴未補完", topic: "通知グループ（分類混在）" };

/** @implements SPEC-MAIL-TOPIC-GROUPS-001 */
export function MailIgnoreGroups({ onSelect }: { onSelect: (id: string, title: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<{ items: Group[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setError(false);
    void fetch(`/v1/mail-history/groups?offset=${offset}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("groups unavailable");
        const value = await response.json() as { items: Group[]; hasMore: boolean };
        if (!Array.isArray(value.items) || typeof value.hasMore !== "boolean") throw new Error("invalid groups");
        if (!controller.signal.aborted) setPage(value);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [offset, revision]);
  return <div className="space-y-3">
    <p className="text-sm text-subtle">GitHub通知はリポジトリ別、Vポイント関連はひとつに、そのほかは同じ送信元でまとめます。要確認メールも含みます。グループをまとめても、各メールの判定や自動除外ルールは変わりません。</p>
    <button type="button" className="border border-border rounded px-3 py-2" onClick={() => { setOffset(0); setRevision((value) => value + 1); }}>グループを更新</button>
    {error && <p role="alert">グループを取得できません。接続を確認して再度お試しください。</p>}
    {!page && !error && <p role="status">読み込み中…</p>}
    {page && <>
      {page.items.length === 0 && <p>除外グループはありません。</p>}
      <ul className="space-y-3">{page.items.map((group) => {
        const special = group.id === "ineligible" || group.id === "unprofiled";
        const title = special ? LABELS[group.id] ?? group.id : group.subject || "（件名なし）";
        return <li key={group.id} className="rounded border border-border bg-surface p-4 space-y-2 break-words">
          <div className="flex flex-wrap gap-3"><strong>{group.count} 通</strong><span>{LABELS[group.state] ?? group.state}</span></div>
          <h2 className="font-semibold">{title}</h2>
          {!special && <><p className="text-sm">送信元: {group.sender}</p><p className="text-xs text-subtle">{group.state === "topic" ? "通知の種類や解析結果をまたいでまとめています。各メールの判定は詳細で確認できます。" : "件名はグループ内の一例です。"}</p></>}
          {special && <p className="text-sm text-subtle">共通パターンのグループには含めていないメールです。</p>}
          <p className="text-xs text-subtle">最終受信: {new Date(group.lastReceived * 1000).toLocaleString("ja-JP")}{group.ruleId ? ` ／ ルール: ${group.ruleId}` : ""}</p>
          <button type="button" className="border border-border rounded px-3 py-2" onClick={() => onSelect(group.id, title)}>この{group.count}通を見る</button>
        </li>;
      })}</ul>
      <div className="flex gap-3">
        <button type="button" className="border border-border rounded px-3 py-2 disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>前へ</button>
        <button type="button" className="border border-border rounded px-3 py-2 disabled:opacity-40" disabled={!page.hasMore} onClick={() => setOffset(offset + 50)}>次へ</button>
      </div>
    </>}
  </div>;
}
