import { createHash, randomBytes } from "node:crypto";
import { createRefreshTokenProvider, type AccessTokenProvider } from "@ludiars/mail-inbox";
import type { SecretStore } from "./secret-store.js";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
// These constants name encrypted-store entries; they are not credential values.
const CLIENT_ID_KEY = "QUAESTOR_GMAIL_CLIENT_ID";
const CLIENT_SECRET_KEY = "QUAESTOR_GMAIL_CLIENT_SECRET";
const REFRESH_TOKEN_KEY = "QUAESTOR_GMAIL_REFRESH_TOKEN";
const SESSION_MS = 10 * 60 * 1000;

export interface GmailClient { clientId: string; clientSecret: string }
interface BrowserSession {
  csrf: string;
  expires: number;
  result?: "saved" | "failed";
  pending?: { state: string; verifier: string; client: GmailClient };
}
export interface GmailAuthStatus {
  configured: boolean;
  clientConfigured: boolean;
  setupUrl: string;
  redirectUri: string;
}

/** Browser-bound OAuth transactions. Codes/tokens never leave the backend in responses. */
export class GmailOAuth {
  private readonly sessions = new Map<string, BrowserSession>();
  private cached?: { fingerprint: string; provider: AccessTokenProvider };
  readonly redirectUri: string;
  readonly setupUrl: string;

  constructor(
    private readonly store: Pick<SecretStore, "loadStrict" | "setMany">,
    readonly origin: string,
    private readonly fallback: Record<string, string | undefined> = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(origin);
    const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!allowedProtocol || url.origin !== origin) {
      throw new Error("Gmail OAuth requires a canonical HTTPS or loopback origin");
    }
    this.setupUrl = `${origin}/v1/gmail-auth/setup`;
    this.redirectUri = `${origin}/v1/gmail-auth/callback`;
  }

  status(): GmailAuthStatus {
    const values = this.values();
    return {
      configured: !!(values[CLIENT_ID_KEY] && values[CLIENT_SECRET_KEY] && values[REFRESH_TOKEN_KEY]),
      clientConfigured: !!(values[CLIENT_ID_KEY] && values[CLIENT_SECRET_KEY]),
      setupUrl: this.setupUrl, redirectUri: this.redirectUri,
    };
  }

  session(id?: string): { id: string; csrf: string; result?: string } {
    this.prune();
    const existing = id ? this.sessions.get(id) : undefined;
    if (id && existing) return { id, csrf: existing.csrf, result: existing.result };
    // Bound memory without a background timer or silently evicting active authorizations.
    if (this.sessions.size >= 32) throw new Error("OAuth session capacity reached");
    const key = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(32).toString("base64url"), expires: this.now() + SESSION_MS };
    this.sessions.set(key, session);
    return { id: key, csrf: session.csrf };
  }

  authorize(id: string, csrf: string, client?: GmailClient): string {
    this.prune();
    const session = this.sessions.get(id);
    if (!session || session.csrf !== csrf) throw new Error("invalid OAuth session");
    const values = this.values();
    const chosen = client ?? { clientId: values[CLIENT_ID_KEY] ?? "", clientSecret: values[CLIENT_SECRET_KEY] ?? "" };
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(chosen.clientId)
      || !chosen.clientSecret || chosen.clientSecret.length > 4096 || /\s/.test(chosen.clientSecret)) {
      throw new Error("invalid OAuth client");
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    session.pending = { state, verifier, client: chosen };
    session.result = undefined;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: chosen.clientId, redirect_uri: this.redirectUri, response_type: "code",
      scope: GMAIL_READ_SCOPE, access_type: "offline", prompt: "consent",
      state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async complete(id: string, state: string, code: string | undefined): Promise<void> {
    this.prune();
    const session = this.sessions.get(id);
    const pending = session?.pending;
    if (!session || !pending || !state || pending.state !== state) throw new Error("invalid OAuth callback");
    // Consume before awaiting Google, preventing replay and concurrent exchanges.
    delete session.pending;
    session.result = "failed";
    if (!code || code.length > 8192) return;
    try {
      const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: pending.client.clientId, client_secret: pending.client.clientSecret,
          code, code_verifier: pending.verifier, redirect_uri: this.redirectUri, grant_type: "authorization_code",
        }),
      });
      if (!response.ok) return;
      const token = await response.json() as Record<string, unknown>;
      if (typeof token.access_token !== "string" || !token.access_token
        || typeof token.refresh_token !== "string" || !token.refresh_token
        || typeof token.scope !== "string" || !token.scope.split(" ").includes(GMAIL_READ_SCOPE)) return;
      this.store.setMany({
        [CLIENT_ID_KEY]: pending.client.clientId, [CLIENT_SECRET_KEY]: pending.client.clientSecret,
        [REFRESH_TOKEN_KEY]: token.refresh_token,
      });
      this.cached = undefined;
      session.result = "saved";
    } catch {
      // Only an allowlisted result reaches the UI; OAuth responses may contain credentials.
      session.result = "failed";
    }
  }

  /** The existing mail source picks up the saved credentials without a restart. */
  async getAccessToken(): Promise<string> {
    const values = this.values();
    const clientId = values[CLIENT_ID_KEY];
    const clientSecret = values[CLIENT_SECRET_KEY];
    const refreshToken = values[REFRESH_TOKEN_KEY];
    if (!clientId || !clientSecret || !refreshToken) throw new Error("Gmail is not configured");
    const fingerprint = createHash("sha256").update(JSON.stringify([clientId, clientSecret, refreshToken])).digest("hex");
    if (!this.cached || this.cached.fingerprint !== fingerprint) {
      this.cached = { fingerprint, provider: createRefreshTokenProvider({ clientId, clientSecret, refreshToken }) };
    }
    return this.cached.provider.getAccessToken();
  }

  private values(): Record<string, string | undefined> {
    // A completed browser authorization supersedes the startup snapshot of env secrets.
    return { ...this.fallback, ...this.store.loadStrict() };
  }

  private prune(): void {
    for (const [id, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(id);
  }
}
