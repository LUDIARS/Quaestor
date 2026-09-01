import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { InvoicesRepo } from "../src/db/invoices-repo.js";
import { InvoiceShareRepo } from "../src/db/invoice-share-repo.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n", "ascii");

describe("API: invoice magic-link access logs", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let pdfPath: string;
  let invoiceId: number;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "quaestor-share-access-")));
    pdfPath = join(root, "invoice.pdf");
    writeFileSync(pdfPath, PDF);
    db = new Database(":memory:");
    app = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs.example.com", roots: [root] },
      unsafeExposeInvoiceShareUrl: true,
    });
    invoiceId = new InvoicesRepo(db).insert({
      issued_at: "2026-08-01",
      due_date: "2026-08-31",
      client: "Example Customer",
      work_summary: "アクセスログ試験",
      amount: 1000,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createShare(): Promise<{ shareId: string; token: string }> {
    const response = await app.request(`/v1/invoices/${invoiceId}/share-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document_path: pdfPath }),
    });
    const body = await response.json() as { share_id: string; share_url: string };
    return {
      shareId: body.share_id,
      token: body.share_url.slice(body.share_url.lastIndexOf("/") + 1),
    };
  }

  it("ランディングとPDFの成功アクセスを個別に記録し、生の接続情報を保存しない", async () => {
    const created = await createShare();
    const accessHeaders = {
      "CF-Connecting-IP": "203.0.113.42",
      "CF-Ray": "abc123-NRT",
      "user-agent": "Access Test Browser/1.0",
      "cf-ipcountry": "JP",
      "cf-region-code": "13",
    };

    expect((await app.request(`/v1/invoices/share/${created.token}`, { headers: accessHeaders })).status).toBe(200);
    expect((await app.request(
      `/v1/invoices/share/${created.token}?view=document`,
      { headers: accessHeaders },
    )).status).toBe(200);

    const audit = await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs`,
    );
    expect(audit.status).toBe(200);
    const body = await audit.json() as { total: number; items: Array<Record<string, unknown>> };
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.event_type).sort()).toEqual(["document_view", "landing_view"]);
    for (const item of body.items) {
      expect(item).toMatchObject({
        share_id: created.shareId,
        invoice_id: invoiceId,
        cf_ray: "abc123-NRT",
        client_address_sha256: sha256("203.0.113.42"),
        location_source: "cloudflare_ip_geolocation",
        location_country_code: "JP",
        location_region_code: "13",
        issuer_reference_proximity: "unavailable",
      });
      expect(item.user_agent_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(item.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(body)).not.toContain("203.0.113.42");
    expect(JSON.stringify(body)).not.toContain("Access Test Browser/1.0");
    expect(new InvoiceShareRepo(db).findById(created.shareId)).toMatchObject({ view_count: 2 });
  });

  it("CF-Ray のない自己申告の位置ヘッダーはアクセス証跡に採用しない", async () => {
    const created = await createShare();
    expect((await app.request(`/v1/invoices/share/${created.token}`, {
      headers: {
        "CF-Connecting-IP": "203.0.113.42",
        "cf-ipcountry": "US",
        "cf-region-code": "CA",
      },
    })).status).toBe(200);

    const audit = await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs`,
    );
    const body = await audit.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      location_source: "unavailable",
      location_country_code: null,
      location_region_code: null,
      issuer_reference_proximity: "unavailable",
    });
  });

  it("発行者の基準地点を設定するとアクセス証跡へ inside/outside だけを残す", async () => {
    const created = await createShare();
    const located = buildApp({
      db,
      receiptsRoot: join(root, "receipts"),
      ocr: "disabled",
      invoiceShare: { publicUrl: "https://qs.example.com", roots: [root] },
      unsafeExposeInvoiceShareUrl: true,
      invoiceAcceptanceLocationReference: { latitude: 35.6812, longitude: 139.7671, radiusKm: 20 },
    });
    expect((await located.request(`/v1/invoices/share/${created.token}`, {
      headers: {
        "CF-Connecting-IP": "203.0.113.42",
        "CF-Ray": "abc123-NRT",
        "cf-ipcountry": "JP",
        "cf-region-code": "13",
        "cf-iplatitude": "35.6895",
        "cf-iplongitude": "139.6917",
      },
    })).status).toBe(200);

    const audit = await located.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs`,
    );
    const body = await audit.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      location_source: "cloudflare_ip_geolocation",
      location_country_code: "JP",
      location_region_code: "13",
      issuer_reference_proximity: "inside",
    });
    // 座標と距離は証跡へ残さない。
    expect(JSON.stringify(body)).not.toContain("35.6895");
    expect(JSON.stringify(body)).not.toContain("139.6917");
  });

  it("無効トークンと受領者未登録の合意開始を閲覧アクセスとして記録しない", async () => {
    const created = await createShare();
    expect((await app.request(`/v1/invoices/share/${"z".repeat(43)}`)).status).toBe(404);
    const accepted = await app.request(`/v1/invoices/share/${created.token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "confirm=accepted",
    });
    // C&R 導入後は登録メールのない共有では合意challengeを開始できない。
    expect(accepted.status).toBe(400);

    const audit = await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs`,
    );
    expect(await audit.json()).toEqual({ items: [], total: 0 });
    expect(new InvoiceShareRepo(db).findById(created.shareId)).toMatchObject({ view_count: 0 });
  });

  it("監査APIの取得上限を検証し、総件数とは分けて返す", async () => {
    const created = await createShare();
    await app.request(`/v1/invoices/share/${created.token}`);
    await app.request(`/v1/invoices/share/${created.token}`);

    const limited = await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs?limit=1`,
    );
    expect(await limited.json()).toMatchObject({ total: 2, items: [{ event_type: "landing_view" }] });
    expect((await app.request(
      `/v1/invoices/${invoiceId}/share-links/${created.shareId}/access-logs?limit=0`,
    )).status).toBe(400);
    expect((await app.request(
      `/v1/invoices/${invoiceId + 1}/share-links/${created.shareId}/access-logs`,
    )).status).toBe(404);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
