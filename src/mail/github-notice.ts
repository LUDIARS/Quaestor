/**
 * GitHub 通知メールから「どのリポジトリの何の通知か」を決定的に取り出す。
 *
 * リポジトリと通知理由はヘッダ (List-ID / X-GitHub-Reason) から取れるので **本文を読まない**。
 * workflow 名・head sha は Actions の失敗通知の件名にだけ載るので件名から取る。
 * run URL だけは本文からの抽出になるため、 github.com 配下の Actions run URL 以外は null にする
 * (spec/feature/mail-realtime.md)。
 *
 * LLM は使わない。 ここで取れなかった値は null にして、 呼び出し側が起動を見送る。
 */

import type { MailMessage } from "@ludiars/mail-inbox";

export interface GithubNotice {
  /** owner/name。 特定できなければ null */
  repo: string | null;
  /** X-GitHub-Reason の値 (ci_activity / security_alert など)。 無ければ null */
  reason: string | null;
  /** https://github.com/<owner>/<repo>/actions/runs/<id> のみ許可。 それ以外は null */
  runUrl: string | null;
  /** Actions 失敗通知の workflow 名 (件名由来)。 取れなければ null */
  workflow: string | null;
  /** 失敗時点の head sha (件名の短縮 sha)。 取れなければ null */
  headSha: string | null;
  /** runUrl から取り出した run id。 取れなければ null */
  runId: string | null;
}

/** `Owner/Repo <Repo.Owner.github.com>` 形式の List-ID からリポジトリを取る。 */
const LIST_ID_RE = /^\s*(?:"?([\w.-]+\/[\w.-]+)"?\s*)?<([\w.-]+)\.([\w.-]+)\.github\.com>\s*$/i;
/** 件名の `[owner/repo] ...` プレフィックス。 List-ID が無い通知のための予備。 */
const SUBJECT_REPO_RE = /^\s*\[([\w.-]+\/[\w.-]+)\]/;
/** `Run failed: <workflow> - <branch> (<sha>)` / `Run failed: <workflow> (<sha>)` */
const RUN_FAILED_RE = /run\s+failed:\s*(.+?)\s*(?:\(([0-9a-f]{7,40})\)\s*)?$/i;
const RUN_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/i;
const REASON_RE = /^[a-z_]{1,64}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * @implements SPEC-MAIL-REALTIME-004 (spec/feature/mail-realtime.md)
 * @implements SPEC-MAIL-REALTIME-009 (spec/feature/mail-realtime.md)
 */
export function parseGithubNotice(
  message: Pick<MailMessage, "headers" | "subject" | "text">,
): GithubNotice {
  const headers = lowerCaseKeys(message.headers);
  const repo = repoFromListId(headers["list-id"]) ?? repoFromSubject(message.subject);
  const reason = normalizeReason(headers["x-github-reason"]);
  const run = parseRunUrl(message.text, repo);
  const failed = parseRunFailedSubject(message.subject);
  return {
    repo,
    reason,
    runUrl: run?.url ?? null,
    runId: run?.id ?? null,
    workflow: failed.workflow,
    headSha: failed.headSha,
  };
}

/** allowlist に載っているリポジトリだけを起動対象にする (外部リポで委託を出さない)。 */
/** @implements SPEC-MAIL-REALTIME-009 (spec/feature/mail-realtime.md) */
export function isAllowedRepo(repo: string | null, allowlist: string[]): boolean {
  if (!isValidRepo(repo)) return false;
  const actual = repo.toLowerCase();
  return allowlist.some((entry) => {
    const expected = entry.trim().toLowerCase();
    if (expected === "") return false;
    if (expected.endsWith("/*")) return actual.startsWith(`${expected.slice(0, -1)}`);
    return actual === expected;
  });
}

/** Gmail が検証した github.com の DKIM/DMARC 結果が無いメールは起動材料にしない。 */
export function isAuthenticatedGithubNotice(
  message: Pick<MailMessage, "from" | "headers">,
): boolean {
  const fromDomain = message.from.address.split("@").pop()?.trim().toLowerCase();
  if (fromDomain !== "github.com") return false;
  const authenticationResults = lowerCaseKeys(message.headers)["authentication-results"] ?? "";
  if (!/^\s*mx\.google\.com\s*;/i.test(authenticationResults)) return false;
  const dmarcPassed = /\bdmarc=pass\b/i.test(authenticationResults)
    && /\bheader\.from=github\.com\b/i.test(authenticationResults);
  const githubDkimPassed = /\bdkim=pass\b[^;]*\bheader\.(?:d|i)=@?github\.com\b/i
    .test(authenticationResults);
  return dmarcPassed || githubDkimPassed;
}

/** GitHub の owner/name として妥当で、ファイルシステムの特殊要素を含まないことを確認する。 */
export function isValidRepo(repo: string | null): repo is string {
  if (!repo || !REPO_RE.test(repo)) return false;
  return repo.split("/").every((part) => part !== "." && part !== "..");
}

function repoFromListId(listId: string | undefined): string | null {
  if (!listId) return null;
  const matched = LIST_ID_RE.exec(listId);
  if (!matched) return null;
  if (matched[1]) return matched[1];
  const [, , name, owner] = matched;
  return name && owner ? `${owner}/${name}` : null;
}

function repoFromSubject(subject: string): string | null {
  return SUBJECT_REPO_RE.exec(subject)?.[1] ?? null;
}

function normalizeReason(reason: string | undefined): string | null {
  const value = reason?.trim().toLowerCase() ?? "";
  return REASON_RE.test(value) ? value : null;
}

function parseRunUrl(text: string, expectedRepo: string | null): { url: string; id: string } | null {
  const matched = RUN_URL_RE.exec(text ?? "");
  if (!matched) return null;
  const [, owner, repo, id] = matched;
  if (!owner || !repo || !id || `${owner}/${repo}`.toLowerCase() !== expectedRepo?.toLowerCase()) {
    return null;
  }
  return { url: `https://github.com/${owner}/${repo}/actions/runs/${id}`, id };
}

function parseRunFailedSubject(subject: string): { workflow: string | null; headSha: string | null } {
  const matched = RUN_FAILED_RE.exec(stripRepoPrefix(subject));
  if (!matched) return { workflow: null, headSha: null };
  const label = matched[1]?.trim() ?? "";
  // `<workflow> - <branch>` の branch 側は起動判断に使わないので落とす。
  const workflow = label.split(/\s+-\s+/)[0]?.trim() ?? "";
  return { workflow: workflow === "" ? null : workflow, headSha: matched[2] ?? null };
}

function stripRepoPrefix(subject: string): string {
  return subject.replace(SUBJECT_REPO_RE, "").trim();
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) result[key.toLowerCase()] = value;
  return result;
}
