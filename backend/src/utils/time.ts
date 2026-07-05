// Generic time helpers used by backend routes and services.

export function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}
