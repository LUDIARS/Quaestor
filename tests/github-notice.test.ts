import { describe, expect, it } from "vitest";
import {
  isAllowedRepo,
  isAuthenticatedGithubNotice,
  parseGithubNotice,
} from "../src/mail/github-notice.js";

describe("parseGithubNotice", () => {
  it("takes the repository and reason from headers without reading the body", () => {
    const notice = parseGithubNotice({
      headers: {
        "List-ID": "LUDIARS/Quaestor <Quaestor.LUDIARS.github.com>",
        "X-GitHub-Reason": "ci_activity",
      },
      subject: "[LUDIARS/Quaestor] Run failed: CI - main (a1b2c3d)",
      text: "",
    });

    expect(notice).toMatchObject({
      repo: "LUDIARS/Quaestor",
      reason: "ci_activity",
      workflow: "CI",
      headSha: "a1b2c3d",
      runUrl: null,
      runId: null,
    });
  });

  it("derives the repository from the mailing list address when no display name is present", () => {
    expect(parseGithubNotice({
      headers: { "list-id": "<Quaestor.LUDIARS.github.com>" },
      subject: "Run failed: Nightly (0123456789abcdef0123456789abcdef01234567)",
      text: "",
    })).toMatchObject({
      repo: "LUDIARS/Quaestor",
      workflow: "Nightly",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("falls back to the subject prefix and rejects run URLs outside github.com", () => {
    const notice = parseGithubNotice({
      headers: {},
      subject: "[LUDIARS/Ergo] Dependabot alert: lodash",
      text: "See https://evil.example/LUDIARS/Ergo/actions/runs/42 for details",
    });

    expect(notice.repo).toBe("LUDIARS/Ergo");
    expect(notice.runUrl).toBeNull();
    expect(notice.runId).toBeNull();
    expect(notice.workflow).toBeNull();
  });

  it("extracts the Actions run id from a github.com run URL", () => {
    expect(parseGithubNotice({
      headers: { "list-id": "LUDIARS/Quaestor <Quaestor.LUDIARS.github.com>" },
      subject: "[LUDIARS/Quaestor] Run failed: CI - main (a1b2c3d)",
      text: "https://github.com/LUDIARS/Quaestor/actions/runs/98765 finished",
    })).toMatchObject({
      runUrl: "https://github.com/LUDIARS/Quaestor/actions/runs/98765",
      runId: "98765",
    });
  });

  it("rejects a run URL for a different repository", () => {
    expect(parseGithubNotice({
      headers: { "list-id": "LUDIARS/Quaestor <Quaestor.LUDIARS.github.com>" },
      subject: "[LUDIARS/Quaestor] Run failed: CI - main (a1b2c3d)",
      text: "https://github.com/outsider/Repo/actions/runs/98765",
    })).toMatchObject({ runUrl: null, runId: null });
  });

  it("drops a malformed reason header rather than passing it through", () => {
    expect(parseGithubNotice({
      headers: { "x-github-reason": "ci activity; drop table" },
      subject: "no repository here",
      text: "",
    })).toMatchObject({ repo: null, reason: null });
  });
});

describe("isAllowedRepo", () => {
  it("accepts exact entries and owner wildcards, and rejects everything else", () => {
    expect(isAllowedRepo("LUDIARS/Quaestor", ["LUDIARS/*"])).toBe(true);
    expect(isAllowedRepo("ludiars/quaestor", ["LUDIARS/Quaestor"])).toBe(true);
    expect(isAllowedRepo("other/repo", ["LUDIARS/*"])).toBe(false);
    expect(isAllowedRepo(null, ["LUDIARS/*"])).toBe(false);
    expect(isAllowedRepo("LUDIARS/Quaestor", [])).toBe(false);
    expect(isAllowedRepo("LUDIARS/..", ["LUDIARS/*"])).toBe(false);
  });
});

describe("isAuthenticatedGithubNotice", () => {
  it("requires a github.com sender with a passing Gmail authentication result", () => {
    expect(isAuthenticatedGithubNotice({
      from: { address: "notifications@github.com" },
      headers: {
        "Authentication-Results": "mx.google.com; dkim=pass header.d=github.com; dmarc=pass header.from=github.com",
      },
    })).toBe(true);
    expect(isAuthenticatedGithubNotice({
      from: { address: "notifications@github.com" },
      headers: {},
    })).toBe(false);
    expect(isAuthenticatedGithubNotice({
      from: { address: "attacker@example.test" },
      headers: { "Authentication-Results": "mx.google.com; dmarc=pass header.from=github.com" },
    })).toBe(false);
  });
});
