import Alpaca from "@alpacahq/alpaca-trade-api";

export type HealthStatus = "ok" | "missing" | "warning" | "error";

export interface ServiceHealth {
  name: string;
  status: HealthStatus;
  message: string;
}

export interface HealthReport {
  ok: boolean;
  timestamp: string;
  tradeMode: string;
  services: ServiceHealth[];
}

interface BuildHealthOptions {
  checkAlpacaConnectivity?: boolean;
  checkOpenAIConnectivity?: boolean;
}

function maskConfigured(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function makeService(
  name: string,
  status: HealthStatus,
  message: string,
): ServiceHealth {
  return {
    name,
    status,
    message,
  };
}

export function getSafeErrorMessage(error: unknown): string {
  const maybeAxiosError = error as {
    response?: { status?: number; statusText?: string; data?: unknown };
    message?: string;
  };

  if (maybeAxiosError.response?.status) {
    const status = maybeAxiosError.response.status;
    const statusText = maybeAxiosError.response.statusText;

    if (status === 401) {
      return "Unauthorized: check API keys and paper/live mode.";
    }

    if (status === 403) {
      return "Forbidden: API key lacks permission for this operation.";
    }

    return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

function getTradeMode(): "paper" | "live" {
  return process.env.TRADE_MODE === "live" ? "live" : "paper";
}

function getAlpacaCredentials() {
  const tradeMode = getTradeMode();

  if (tradeMode === "live") {
    return {
      keyId: process.env.APCA_API_KEY_ID_LIVE,
      secretKey: process.env.APCA_API_SECRET_KEY_LIVE,
      baseUrl:
        process.env.APCA_API_BASE_URL_LIVE ?? "https://api.alpaca.markets",
      paper: false,
    };
  }

  return {
    keyId: process.env.APCA_API_KEY_ID,
    secretKey: process.env.APCA_API_SECRET_KEY,
    baseUrl:
      process.env.APCA_API_BASE_URL ?? "https://paper-api.alpaca.markets",
    paper: true,
  };
}

async function checkAlpaca(
  checkConnectivity: boolean,
): Promise<ServiceHealth> {
  const credentials = getAlpacaCredentials();

  if (!maskConfigured(credentials.keyId) || !maskConfigured(credentials.secretKey)) {
    return makeService(
      "alpaca",
      "missing",
      `Missing Alpaca ${getTradeMode()} API key or secret.`,
    );
  }

  if (!checkConnectivity) {
    return makeService(
      "alpaca",
      "ok",
      `Alpaca ${getTradeMode()} credentials are configured.`,
    );
  }

  try {
    const alpaca = new Alpaca({
      keyId: credentials.keyId!,
      secretKey: credentials.secretKey!,
      paper: credentials.paper,
      baseUrl: credentials.baseUrl,
    });

    await alpaca.getAccount();

    return makeService(
      "alpaca",
      "ok",
      `Alpaca ${getTradeMode()} account check passed.`,
    );
  } catch (error) {
    return makeService("alpaca", "error", getSafeErrorMessage(error));
  }
}

function checkOpenAI(): ServiceHealth {
  if (!maskConfigured(process.env.OPENAI_API_KEY)) {
    return makeService("openai", "missing", "OPENAI_API_KEY is missing.");
  }

  return makeService("openai", "ok", "OPENAI_API_KEY is configured.");
}

function checkTelegram(): ServiceHealth {
  const hasToken = maskConfigured(process.env.TELEGRAM_BOT_TOKEN);
  const hasChatId = maskConfigured(process.env.TELEGRAM_CHAT_ID);

  if (!hasToken && !hasChatId) {
    return makeService(
      "telegram",
      "warning",
      "Telegram is not configured. Alerts will be disabled.",
    );
  }

  if (!hasToken || !hasChatId) {
    return makeService(
      "telegram",
      "warning",
      "Telegram token or chat id is missing. Alerts may fail.",
    );
  }

  return makeService("telegram", "ok", "Telegram alert config is present.");
}

function checkStrategyVersion(): ServiceHealth {
  if (!maskConfigured(process.env.STRATEGY_VERSION)) {
    return makeService(
      "strategy",
      "warning",
      "STRATEGY_VERSION is not set. Default backend version will be used.",
    );
  }

  return makeService(
    "strategy",
    "ok",
    `STRATEGY_VERSION=${process.env.STRATEGY_VERSION}`,
  );
}

export async function buildHealthReport(
  options: BuildHealthOptions = {},
): Promise<HealthReport> {
  const services: ServiceHealth[] = [
    await checkAlpaca(Boolean(options.checkAlpacaConnectivity)),
    checkOpenAI(),
    checkTelegram(),
    checkStrategyVersion(),
  ];

  const ok = services.every(
    (service) => service.status === "ok" || service.status === "warning",
  );

  return {
    ok,
    timestamp: new Date().toISOString(),
    tradeMode: getTradeMode(),
    services,
  };
}
