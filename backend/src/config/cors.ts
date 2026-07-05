// CORS origin parsing and validation helpers.
// Extracted from server.ts to keep server bootstrap smaller.

export function normalizeCorsOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function parseCorsOrigins(value: string): string[] {
  return value.split(",").map(normalizeCorsOrigin).filter(Boolean);
}

export function resolveAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): string | null {
  if (!origin) return null;

  const normalizedOrigin = normalizeCorsOrigin(origin);

  return allowedOrigins.includes(normalizedOrigin) ? normalizedOrigin : null;
}
