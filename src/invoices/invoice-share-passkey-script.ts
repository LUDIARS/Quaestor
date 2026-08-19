/**
 * 公開ページで動くパスキー用ブラウザスクリプト。 inline ではなく `/share/assets/passkey.js` として配信し、
 * CSP は `script-src 'self'` のまま保つ。 依存なし (WebAuthn API + fetch)。
 *
 * data-mode="enroll": OTP 通過後の登録 → そのまま署名して合意。
 * data-mode="accept": 登録済みパスキーで署名して合意。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-005 (spec/feature/invoice-public-magic-link.md)
 * @implements SPEC-INVOICE-ACCEPTANCE-006 (spec/feature/invoice-public-magic-link.md)
 */

export const INVOICE_SHARE_PASSKEY_SCRIPT = String.raw`(() => {
  "use strict";
  const root = document.querySelector("[data-passkey-root]");
  if (!root) return;
  const token = root.getAttribute("data-token") || "";
  const mode = root.getAttribute("data-mode") || "accept";
  const grantId = root.getAttribute("data-grant") || "";
  const base = "/v1/invoices/share/" + encodeURIComponent(token) + "/passkey";
  const button = root.querySelector("[data-passkey-button]");
  const checkbox = root.querySelector("[data-passkey-agree]");
  const status = root.querySelector("[data-passkey-status]");

  const b64uToBuf = (s) => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bufToB64u = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const say = (text, isError) => {
    if (!status) return;
    status.textContent = text;
    status.className = isError ? "status error" : "status";
  };
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || json.error || ("HTTP " + res.status));
    return json;
  };

  const toCreationOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    user: { ...o.user, id: b64uToBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });
  const toRequestOptions = (o) => ({
    ...o,
    challenge: b64uToBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  });

  const register = async () => {
    say("パスキーを作成しています…");
    const { challenge_id, options } = await post("/options", { purpose: "register", grant_id: grantId });
    const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
    if (!cred) throw new Error("パスキーの作成がキャンセルされました");
    const r = cred.response;
    await post("/register", {
      grant_id: grantId,
      challenge_id,
      response: {
        id: cred.id,
        rawId: bufToB64u(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: bufToB64u(r.clientDataJSON),
          attestationObject: bufToB64u(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : undefined,
        },
      },
    });
  };

  const accept = async () => {
    say("合意内容に署名しています…");
    const { challenge_id, options } = await post("/options", { purpose: "assert" });
    const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
    if (!cred) throw new Error("署名がキャンセルされました");
    const r = cred.response;
    await post("/accept", {
      challenge_id,
      response: {
        id: cred.id,
        rawId: bufToB64u(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: bufToB64u(r.clientDataJSON),
          authenticatorData: bufToB64u(r.authenticatorData),
          signature: bufToB64u(r.signature),
          userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
        },
      },
    });
  };

  if (!window.PublicKeyCredential || !navigator.credentials) {
    say("このブラウザはパスキーに対応していません。対応ブラウザ (最新の Chrome / Edge / Safari) で開き直してください。", true);
    if (button) button.disabled = true;
    return;
  }
  if (!button) return;
  button.addEventListener("click", async () => {
    if (checkbox && !checkbox.checked) { say("合意文言を確認し、チェックを入れてください。", true); return; }
    button.disabled = true;
    try {
      if (mode === "enroll") await register();
      await accept();
      say("合意を記録しました。画面を更新します…");
      window.location.replace("/v1/invoices/share/" + encodeURIComponent(token));
    } catch (error) {
      say("完了できませんでした: " + (error && error.message ? error.message : String(error)), true);
      button.disabled = false;
    }
  });
})();
`;
