/**
 * Cloudflare の IP geolocation を、合意主体の補助的なリスク信号へ縮約する。
 * 受領者座標・基準座標・距離は監査ログへ保存しない。
 *
 * @implements SPEC-INVOICE-ACCEPTANCE-004 (spec/feature/invoice-public-magic-link.md)
 */

import { isIP } from "node:net";

export type IssuerReferenceProximity = "inside" | "outside" | "unavailable";

export interface InvoiceAcceptanceLocationReference {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

export interface CloudflareVisitorLocation {
  latitude?: string;
  longitude?: string;
  countryCode?: string;
  regionCode?: string;
}

export interface InvoiceAcceptanceLocationSignal {
  source: "cloudflare_ip_geolocation" | "unavailable";
  countryCode: string | null;
  regionCode: string | null;
  issuerReferenceProximity: IssuerReferenceProximity;
}

const UNAVAILABLE: InvoiceAcceptanceLocationSignal = {
  source: "unavailable",
  countryCode: null,
  regionCode: null,
  issuerReferenceProximity: "unavailable",
};

export function locationReferenceFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): InvoiceAcceptanceLocationReference | null {
  const latitude = coordinate(env.QUAESTOR_ACCEPTANCE_REFERENCE_LATITUDE, -90, 90);
  const longitude = coordinate(env.QUAESTOR_ACCEPTANCE_REFERENCE_LONGITUDE, -180, 180);
  const radiusKm = positiveNumber(env.QUAESTOR_ACCEPTANCE_REFERENCE_RADIUS_KM) ?? 20;
  return latitude === null || longitude === null
    ? null
    : { latitude, longitude, radiusKm };
}

export function evaluateAcceptanceLocation(
  location: CloudflareVisitorLocation | undefined,
  reference: InvoiceAcceptanceLocationReference | null,
  cfRay: string | null,
  cloudflareClientAddress: string | undefined,
): InvoiceAcceptanceLocationSignal {
  // Cloudflare 経由である証拠がないリクエストの自己申告ヘッダーは信頼しない。
  // CF-Connecting-IP は信頼判定だけに使い、値や hash を合意台帳へ保存しない。
  if (!cfRay || !validIpAddress(cloudflareClientAddress) || !location) return UNAVAILABLE;
  const countryCode = locationCode(location.countryCode, 2);
  const regionCode = locationCode(location.regionCode, 16);
  const latitude = coordinate(location.latitude, -90, 90);
  const longitude = coordinate(location.longitude, -180, 180);
  const hasCloudflareLocation = countryCode !== null
    || regionCode !== null
    || (latitude !== null && longitude !== null);
  if (!hasCloudflareLocation) return UNAVAILABLE;
  if (latitude === null || longitude === null || reference === null) {
    return {
      source: "cloudflare_ip_geolocation",
      countryCode,
      regionCode,
      issuerReferenceProximity: "unavailable",
    };
  }
  const distanceKm = haversineDistanceKm(
    latitude,
    longitude,
    reference.latitude,
    reference.longitude,
  );
  return {
    source: "cloudflare_ip_geolocation",
    countryCode,
    regionCode,
    issuerReferenceProximity: distanceKm <= reference.radiusKm ? "inside" : "outside",
  };
}

function validIpAddress(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !!candidate && candidate.length <= 45 && isIP(candidate) !== 0;
}

function coordinate(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^-?(?:\d+|\d+[.]\d+|[.]\d+)$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined || !/^(?:\d+|\d+[.]\d+|[.]\d+)$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000 ? parsed : null;
}

function locationCode(value: string | undefined, maxLength: number): string | null {
  const candidate = value?.trim().toUpperCase();
  return candidate && candidate.length <= maxLength && /^[A-Z0-9-]+$/.test(candidate)
    ? candidate
    : null;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
