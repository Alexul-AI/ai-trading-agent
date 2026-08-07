// Generic time helpers used by backend routes and services.

export function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

/** True IFF `timeZone` is a name Intl.DateTimeFormat accepts (e.g. "Asia/Jerusalem"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats an ISO timestamp as a "YYYY-MM-DD" date key in the given IANA
 * timezone, not UTC. Uses the en-CA locale's YYYY-MM-DD output format
 * directly (a well-known trick) rather than assembling year/month/day parts
 * by hand - Intl.DateTimeFormat already handles DST transitions correctly.
 */
export function toLocalDateKey(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

/**
 * Resolves a raw env var value to a valid IANA timezone name, defaulting to
 * `defaultTimeZone` when unset. Unlike this project's other resolveXxx env
 * helpers (which fail loud on invalid input, since they gate trade-safety
 * behavior - see e.g. resolveRampMaxPositionEquityPercent), an invalid
 * timezone here fails soft to "UTC" instead of throwing: this only ever
 * feeds a cosmetic once-per-day reminder cadence, so a typo should degrade
 * the reminder's day boundary back to UTC, not take down the whole
 * autopilot worker.
 */
export function resolveTimeZone(raw: string | undefined, defaultTimeZone: string): string {
  const candidate = raw?.trim() || defaultTimeZone;

  if (isValidTimeZone(candidate)) {
    return candidate;
  }

  console.warn(`[TIME] Invalid IANA timezone "${candidate}" - falling back to UTC.`);
  return "UTC";
}
