/** @implements SPEC-RUNTIME-VERSION-001 (spec/feature/runtime-version.md) */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const UNAVAILABLE_VERSION = "unavailable";

/** Returns only deployment-version identifiers that are safe to expose operationally. */
export function runtimeVersionFrom(value: string | undefined): string {
  const version = value?.trim();
  return version && VERSION_PATTERN.test(version) ? version : UNAVAILABLE_VERSION;
}

export function runtimeVersionFromEnvironment(): string {
  return runtimeVersionFrom(process.env.EXCUBITOR_SERVICE_VERSION);
}
