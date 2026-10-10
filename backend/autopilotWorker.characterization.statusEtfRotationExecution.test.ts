import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makePortfolioSnapshot,
  makeThrowingExecuteSafeTrade,
  makeThrowingGetOrderStatus,
} from "./autopilotWorker.characterization.helpers.js";

// autopilotWorker.ts transitively imports agent.ts, whose dotenv.config()
// would load the developer's real local .env into process.env for any
// variable a test leaves unset - making an "unset" case pass in CI (no .env)
// but fail locally (.env sets AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT).
// Mocked out so every value below comes only from this file's stubs.
vi.mock("dotenv", () => ({
  default: { config: () => ({}) },
  config: () => ({}),
}));

// getStatus() reads module-level constants resolved from process.env at
// import time (autopilotConfig.ts), so each case stubs env first and then
// re-imports a fresh copy of the module graph. Nothing here runs a cycle -
// the worker is only constructed and its status read - so no data files are
// touched (the autopilotWorkerLock/journal/state paths are only used by
// runOnce()).
async function statusWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
  vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");
  // agent.ts constructs an OpenAI client at import time; CI supplies a
  // placeholder the same way (.github/workflows/ci.yml).
  vi.stubEnv("OPENAI_API_KEY", "test-placeholder-key");
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }

  const { createAutopilotWorker } = await import("./autopilotWorker.js");
  const worker = createAutopilotWorker({
    tradeMode: "paper",
    getPortfolioSnapshot: async () => makePortfolioSnapshot(),
    getEquityHistorySince: async () => [],
    executeSafeTrade: makeThrowingExecuteSafeTrade(),
    getOrderStatus: makeThrowingGetOrderStatus(),
    broadcastSSE: () => {},
  });

  return worker.getStatus();
}

describe("autopilotWorker getStatus: etfRotationExecution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the ramp cap, fill timeout and poll interval actually in effect when the active strategy is etf_rotation", async () => {
    const status = await statusWithEnv({
      AUTOPILOT_STRATEGY: "etf_rotation",
      AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT: "5",
      AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS: "45000",
      AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS: "1500",
    });

    expect(status.etfRotationExecution).toEqual({
      rampMaxPositionEquityPercent: 5,
      sellFillTimeoutMs: 45000,
      sellFillPollIntervalMs: 1500,
    });
  });

  it("reports the code defaults for the fill timing and null (uncapped) for an unset ramp cap", async () => {
    const status = await statusWithEnv({
      AUTOPILOT_STRATEGY: "etf_rotation",
      AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT: undefined,
      AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS: undefined,
      AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS: undefined,
    });

    expect(status.etfRotationExecution).toEqual({
      rampMaxPositionEquityPercent: null,
      sellFillTimeoutMs: 10000,
      sellFillPollIntervalMs: 500,
    });
  });

  it("is null for the baseline strategy, which has no ramp cap or paired-SELL wait", async () => {
    const status = await statusWithEnv({
      AUTOPILOT_STRATEGY: "baseline",
      AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT: "5",
    });

    expect(status.etfRotationExecution).toBeNull();
  });
});
