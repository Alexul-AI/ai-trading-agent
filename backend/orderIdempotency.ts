import { randomUUID } from "crypto";

export type OrderErrorClassification =
  | "duplicate_client_order_id"
  | "definitive_rejection"
  | "ambiguous_network_error";

export type AlpacaErrorResponseData =
  | { message?: string; code?: number }
  | string
  | undefined;

export interface AlpacaErrorLike {
  response?: {
    status?: number;
    data?: AlpacaErrorResponseData;
  };
}

function extractMessage(data: AlpacaErrorResponseData): string {
  if (typeof data === "string") return data;
  if (data && typeof data.message === "string") return data.message;
  return "";
}

// Pure - no I/O. `createOrder` is a raw axios POST with no built-in retry
// or idempotency (confirmed in node_modules/@alpacahq/alpaca-trade-api/dist/api.js -
// errors are unmodified axios errors): a non-2xx response from Alpaca has
// `error.response`, a network-level failure (timeout, DNS, connection
// reset) does not. Alpaca throws on a reused client_order_id (documented
// behavior: 422, message mentions client_order_id) - distinguishing that
// from a genuine rejection or an ambiguous network failure determines
// whether it's safe to reuse the same client_order_id on a future attempt.
export function classifyOrderError(
  error: AlpacaErrorLike,
): OrderErrorClassification {
  const response = error?.response;

  if (!response || typeof response.status !== "number") {
    return "ambiguous_network_error";
  }

  const message = extractMessage(response.data).toLowerCase();

  if (response.status === 422 && message.includes("client_order_id")) {
    return "duplicate_client_order_id";
  }

  return "definitive_rejection";
}

export interface ClientOrderIdTracker {
  getOrCreate(ticker: string, action: string): string;
  clear(ticker: string, action: string): void;
}

// Factory, not a module-level singleton, so tests don't share state across
// cases. server.ts holds one instance for the process's lifetime.
//
// Keyed by ticker+action and held until a *definitive* outcome (success or
// definitive_rejection) - not regenerated per call. This is what makes a
// same-cycle-signal retry safe: a later attempt for the same logical trade
// reuses the earlier attempt's ID rather than minting a new one, so if the
// original actually landed at the broker, Alpaca's own dedup catches it.
export function createClientOrderIdTracker(): ClientOrderIdTracker {
  const pendingByKey = new Map<string, string>();

  function key(ticker: string, action: string): string {
    return `${ticker.toUpperCase()}:${action.toUpperCase()}`;
  }

  return {
    getOrCreate(ticker: string, action: string): string {
      const mapKey = key(ticker, action);
      const existing = pendingByKey.get(mapKey);
      if (existing) return existing;

      const id =
        `autopilot-${ticker}-${action}-${randomUUID()}`.toLowerCase();
      pendingByKey.set(mapKey, id);
      return id;
    },
    clear(ticker: string, action: string): void {
      pendingByKey.delete(key(ticker, action));
    },
  };
}
