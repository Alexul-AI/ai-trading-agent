// Generic value parsing helpers used by backend routes and services.

import type { UnknownRecord } from "../types/serverTypes.js";

export function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}
export function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function roundOrNull(
  value: number | null | undefined,
  digits = 2,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}
