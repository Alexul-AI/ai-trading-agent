const MIN_STALE_SIGNAL_THRESHOLD_MS = 15 * 60 * 1000;

export function formatSignalTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "Invalid timestamp";
  }

  return date.toLocaleString();
}

export function getSignalTimestampMs(timestamp: string): number | null {
  const signalMs = new Date(timestamp).getTime();

  if (Number.isNaN(signalMs)) {
    return null;
  }

  return signalMs;
}

export function getSignalAgeMs(
  signalTimestampMs: number | null,
  nowMs: number | null,
): number | null {
  if (signalTimestampMs === null || nowMs === null) {
    return null;
  }

  return Math.max(0, nowMs - signalTimestampMs);
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "Unknown";

  const totalMinutes = Math.floor(ageMs / 60_000);

  if (totalMinutes < 1) return "< 1 min";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export function getStaleThresholdMs(intervalMs: number): number {
  return Math.max(MIN_STALE_SIGNAL_THRESHOLD_MS, intervalMs * 3);
}

export function isSignalStale(
  ageMs: number | null,
  thresholdMs: number,
): boolean {
  if (ageMs === null) return true;

  return ageMs > thresholdMs;
}
