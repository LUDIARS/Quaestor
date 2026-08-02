import { describe, expect, it } from "vitest";
import {
  evaluateAcceptanceLocation,
  locationReferenceFromEnvironment,
} from "../src/services/invoice-acceptance-location-signal.js";

describe("invoice acceptance location signal", () => {
  const reference = { latitude: 35.6812, longitude: 139.7671, radiusKm: 20 };

  it("Cloudflare 推定地点が基準半径外なら outside のみを返す", () => {
    expect(evaluateAcceptanceLocation({
      latitude: "34.6937",
      longitude: "135.5023",
      countryCode: "jp",
      regionCode: "27",
    }, reference, "abc123-NRT", "203.0.113.10")).toEqual({
      source: "cloudflare_ip_geolocation",
      countryCode: "JP",
      regionCode: "27",
      issuerReferenceProximity: "outside",
    });
  });

  it("基準地点近辺は inside とし、距離や座標は結果へ含めない", () => {
    const signal = evaluateAcceptanceLocation({
      latitude: "35.6895",
      longitude: "139.6917",
      countryCode: "JP",
      regionCode: "13",
    }, reference, "abc123-NRT", "2001:db8::10");

    expect(signal.issuerReferenceProximity).toBe("inside");
    expect(JSON.stringify(signal)).not.toContain("35.6895");
    expect(JSON.stringify(signal)).not.toContain("139.6917");
  });

  it("CF-Ray がない自己申告ヘッダーは信頼しない", () => {
    expect(evaluateAcceptanceLocation({
      latitude: "34.6937",
      longitude: "135.5023",
      countryCode: "JP",
    }, reference, null, "203.0.113.10")).toEqual({
      source: "unavailable",
      countryCode: null,
      regionCode: null,
      issuerReferenceProximity: "unavailable",
    });
  });

  it("CF-Connecting-IP がない、または不正なら位置ヘッダーを信頼しない", () => {
    const location = { latitude: "34.6937", longitude: "135.5023", countryCode: "JP" };
    expect(evaluateAcceptanceLocation(location, reference, "abc123-NRT", undefined).source)
      .toBe("unavailable");
    expect(evaluateAcceptanceLocation(location, reference, "abc123-NRT", "999.1.1.1").source)
      .toBe("unavailable");
  });

  it("暗号化ストアから注入される env を基準地点として解決する", () => {
    expect(locationReferenceFromEnvironment({
      QUAESTOR_ACCEPTANCE_REFERENCE_LATITUDE: "35.6812",
      QUAESTOR_ACCEPTANCE_REFERENCE_LONGITUDE: "139.7671",
    })).toEqual({ latitude: 35.6812, longitude: 139.7671, radiusKm: 20 });
    expect(locationReferenceFromEnvironment({
      QUAESTOR_ACCEPTANCE_REFERENCE_LATITUDE: "35.6812",
    })).toBeNull();
  });
});
