import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

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
  /** Current pending entries, keyed "TICKER:ACTION" -> client_order_id - for persistence, not decision logic. */
  snapshot(): Record<string, string>;
}

// Factory, not a module-level singleton, so tests don't share state across
// cases. server.ts holds one instance for the process's lifetime.
//
// Keyed by ticker+action and held until a *definitive* outcome (success or
// definitive_rejection) - not regenerated per call. This is what makes a
// same-cycle-signal retry safe: a later attempt for the same logical trade
// reuses the earlier attempt's ID rather than minting a new one, so if the
// original actually landed at the broker, Alpaca's own dedup catches it.
//
// `initialState` hydrates the in-memory map from a previous run (see
// createPersistedClientOrderIdTracker below) - defaults to empty so every
// existing call site/test is unaffected.
export function createClientOrderIdTracker(
  initialState: Record<string, string> = {},
): ClientOrderIdTracker {
  const pendingByKey = new Map<string, string>(Object.entries(initialState));

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
    snapshot(): Record<string, string> {
      return Object.fromEntries(pendingByKey);
    },
  };
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "order-idempotency-state.json");

// Same fail-soft convention as portfolioCircuitBreaker.ts's readState - a
// missing or corrupt file just means "nothing pending," not an error.
async function readPersistedState(
  filePath: string = STATE_FILE,
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

async function writePersistedState(
  state: Record<string, string>,
  filePath: string = STATE_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export interface AsyncClientOrderIdTracker {
  getOrCreate(ticker: string, action: string): Promise<string>;
  clear(ticker: string, action: string): Promise<void>;
  snapshot(): Record<string, string>;
}

// Wraps the pure in-memory tracker with disk persistence, so a pending
// ambiguous-error client_order_id survives a process restart (the gap
// flagged in docs/ops/PAPER_INFRASTRUCTURE_GATE.md item 4 - a restart
// during that window used to wipe the in-memory record, letting a retry
// mint a fresh client_order_id that Alpaca's own dedup can't catch).
//
// getOrCreate/clear are async and *await* the disk write before returning -
// not fire-and-forget - because the durability guarantee only holds if the
// write has actually landed before the caller proceeds to submit the order.
//
// `filePath` defaults to the real state file; server.ts never overrides it.
// The override exists solely so tests can point this at a real temp file
// instead of mocking fs or mutating global process.cwd().
export async function createPersistedClientOrderIdTracker(
  filePath: string = STATE_FILE,
): Promise<AsyncClientOrderIdTracker> {
  const initialState = await readPersistedState(filePath);
  const tracker = createClientOrderIdTracker(initialState);

  return {
    async getOrCreate(ticker: string, action: string): Promise<string> {
      const id = tracker.getOrCreate(ticker, action);
      await writePersistedState(tracker.snapshot(), filePath);
      return id;
    },
    async clear(ticker: string, action: string): Promise<void> {
      tracker.clear(ticker, action);
      await writePersistedState(tracker.snapshot(), filePath);
    },
    snapshot(): Record<string, string> {
      return tracker.snapshot();
    },
  };
}
