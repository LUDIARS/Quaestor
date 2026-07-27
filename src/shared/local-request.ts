import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/** 機微な会計データを返す API を、直接の loopback リクエストだけに限定する。 */
export function isDirectLoopbackRequest(c: Context): boolean {
  let remoteAddress: string | undefined;
  try {
    remoteAddress = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  if (!isLoopbackAddress(remoteAddress)) return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) return false;

  const origin = c.req.header("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === requestUrl.origin;
  } catch {
    return false;
  }
}
