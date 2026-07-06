import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const ADMIN_SESSION_COOKIE = "alexul_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface AdminAuthConfig {
  adminApiToken?: string;
  adminPassword?: string;
  adminSessionSecret?: string;
  tradeMode: "paper" | "live";
  nodeEnv?: string;
}

function getCookieValue(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  const cookies = header.split(";").map((part) => part.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) continue;

    const cookieName = cookie.slice(0, separatorIndex);
    const cookieValue = cookie.slice(separatorIndex + 1);

    if (cookieName === name) {
      try {
        return decodeURIComponent(cookieValue);
      } catch {
        return cookieValue;
      }
    }
  }

  return null;
}

export function createAdminAuth(config: AdminAuthConfig) {
  function getAdminSessionSecret(): string | null {
    return config.adminSessionSecret || config.adminApiToken || null;
  }

  function timingSafeEqualString(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) return false;

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  function signAdminSession(expiresAtMs: number): string {
    const secret = getAdminSessionSecret();

    if (!secret) {
      throw new Error("Missing admin session secret.");
    }

    return crypto
      .createHmac("sha256", secret)
      .update(String(expiresAtMs))
      .digest("hex");
  }

  function createAdminSessionToken(): string {
    const expiresAtMs = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
    const signature = signAdminSession(expiresAtMs);

    return `${expiresAtMs}.${signature}`;
  }

  function isAdminSessionValid(token: string | null): boolean {
    if (!token) return false;

    const [expiresAtText, signature] = token.split(".");
    if (!expiresAtText || !signature) return false;

    const expiresAtMs = Number.parseInt(expiresAtText, 10);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return false;
    }

    const expectedSignature = signAdminSession(expiresAtMs);

    return timingSafeEqualString(signature, expectedSignature);
  }

  function hasValidAdminSession(req: Request): boolean {
    return isAdminSessionValid(getCookieValue(req, ADMIN_SESSION_COOKIE));
  }

  function getAdminCookieAttributes(req: Request): string {
    const origin =
      typeof req.headers.origin === "string" ? req.headers.origin : "";

    const requiresCrossSiteCookie =
      origin.startsWith("https://") && !origin.includes("localhost");

    if (requiresCrossSiteCookie || config.nodeEnv === "production") {
      return "HttpOnly; Secure; SameSite=None; Path=/";
    }

    return "HttpOnly; SameSite=Lax; Path=/";
  }

  function setAdminSessionCookie(req: Request, res: Response) {
    const token = createAdminSessionToken();

    res.setHeader(
      "Set-Cookie",
      `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; ${getAdminCookieAttributes(req)}`,
    );
  }

  function clearAdminSessionCookie(req: Request, res: Response) {
    res.setHeader(
      "Set-Cookie",
      `${ADMIN_SESSION_COOKIE}=; Max-Age=0; ${getAdminCookieAttributes(req)}`,
    );
  }

  function requireAdminToken(req: Request, res: Response, next: NextFunction) {
    if (hasValidAdminSession(req)) {
      next();
      return;
    }

    if (!config.adminApiToken) {
      if (config.tradeMode === "live") {
        res.status(503).json({
          error: "Admin token is required in live mode.",
        });
        return;
      }

      next();
      return;
    }

    const providedToken =
      typeof req.headers["x-admin-token"] === "string"
        ? req.headers["x-admin-token"]
        : "";

    if (providedToken !== config.adminApiToken) {
      res.status(401).json({
        error: "Unauthorized",
      });
      return;
    }

    next();
  }

  return {
    getAdminSessionSecret,
    timingSafeEqualString,
    hasValidAdminSession,
    setAdminSessionCookie,
    clearAdminSessionCookie,
    requireAdminToken,
  };
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
