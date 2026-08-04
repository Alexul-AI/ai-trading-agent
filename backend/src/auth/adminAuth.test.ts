import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createAdminAuth, type AdminAuthConfig } from "./adminAuth.js";

// This project doesn't otherwise test Express middleware directly (server.ts
// itself is a documented, accepted gap - see CLAUDE.md's Testing section),
// but adminAuth.ts is security-critical enough (gates ~9 admin-only routes:
// /api/trade, /api/autopilot/run-once, etc.) to warrant a direct exception,
// especially after the timing-attack and fail-open findings below. Minimal
// hand-built Request/Response fakes - only the handful of properties/methods
// requireAdminToken actually touches, not the full Express surface.

interface FakeResponse {
  statusCode?: number;
  jsonBody?: unknown;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
}

function makeFakeResponse(): FakeResponse {
  const res: FakeResponse = {
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
  };
  return res;
}

function makeFakeRequest(
  options: { cookie?: string; origin?: string; adminToken?: string } = {},
): Request {
  const headers: Record<string, string | undefined> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.adminToken !== undefined) headers["x-admin-token"] = options.adminToken;

  return { headers } as unknown as Request;
}

function makeAuth(overrides: Partial<AdminAuthConfig> = {}) {
  return createAdminAuth({
    tradeMode: "paper",
    ...overrides,
  });
}

describe("timingSafeEqualString", () => {
  it("is true for identical strings", () => {
    const auth = makeAuth();
    expect(auth.timingSafeEqualString("secret123", "secret123")).toBe(true);
  });

  it("is false for a same-length, different-content string, without throwing", () => {
    const auth = makeAuth();
    expect(auth.timingSafeEqualString("secret123", "secret456")).toBe(false);
  });

  it("is false (not a thrown error) when lengths differ - crypto.timingSafeEqual would throw on mismatched buffer lengths otherwise", () => {
    const auth = makeAuth();
    expect(auth.timingSafeEqualString("short", "a-much-longer-string")).toBe(false);
    expect(auth.timingSafeEqualString("a-much-longer-string", "short")).toBe(false);
  });
});

describe("requireAdminToken", () => {
  it("blocks with 503 when no token is configured and nodeEnv is production, even in paper mode", () => {
    const auth = makeAuth({ tradeMode: "paper", nodeEnv: "production" });
    const req = makeFakeRequest();
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("blocks with 503 when no token is configured and tradeMode is live, regardless of nodeEnv", () => {
    const auth = makeAuth({ tradeMode: "live", nodeEnv: "development" });
    const req = makeFakeRequest();
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("allows through when no token is configured in local paper dev (nodeEnv not production, tradeMode not live)", () => {
    const auth = makeAuth({ tradeMode: "paper", nodeEnv: "development" });
    const req = makeFakeRequest();
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it("rejects an incorrect token with 401", () => {
    const auth = makeAuth({ adminApiToken: "secret123" });
    const req = makeFakeRequest({ adminToken: "wrong" });
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing token (no header at all) with 401 when a token is configured", () => {
    const auth = makeAuth({ adminApiToken: "secret123" });
    const req = makeFakeRequest();
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("does not throw on a length-mismatched wrong token (the classic constant-time-compare footgun)", () => {
    const auth = makeAuth({ adminApiToken: "secret123" });
    const req = makeFakeRequest({ adminToken: "x" });
    const res = makeFakeResponse();
    const next = vi.fn();

    expect(() =>
      auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction),
    ).not.toThrow();
    expect(res.statusCode).toBe(401);
  });

  it("allows through with the correct token", () => {
    const auth = makeAuth({ adminApiToken: "secret123" });
    const req = makeFakeRequest({ adminToken: "secret123" });
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it("a valid session cookie bypasses the token check entirely, even with no x-admin-token header and a token configured", () => {
    const auth = makeAuth({ adminApiToken: "secret123", adminSessionSecret: "session-secret" });

    // Mint a real session cookie the same way login does.
    const loginReq = makeFakeRequest();
    const loginRes = makeFakeResponse();
    auth.setAdminSessionCookie(loginReq, loginRes as unknown as Response);
    const setCookieHeader = loginRes.headers["Set-Cookie"]!;
    const cookiePair = setCookieHeader.split(";")[0]!; // "alexul_admin_session=<token>"

    const req = makeFakeRequest({ cookie: cookiePair });
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it("an expired/tampered session cookie does not bypass the token check", () => {
    const auth = makeAuth({ adminApiToken: "secret123", adminSessionSecret: "session-secret" });

    const req = makeFakeRequest({ cookie: "alexul_admin_session=9999999999999.tampered-signature" });
    const res = makeFakeResponse();
    const next = vi.fn();

    auth.requireAdminToken(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
