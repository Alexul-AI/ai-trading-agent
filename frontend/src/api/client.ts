export const API_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://ai-trading-agent-i4nr.onrender.com";

export const MANUAL_TRADING_ENABLED =
  import.meta.env.VITE_ALLOW_MANUAL_TRADES === "true";

export async function loginAdmin(password: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    throw new Error(`Admin login failed: ${response.status}`);
  }
}

export function fetchWithAdminCredentials(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
  });
}
