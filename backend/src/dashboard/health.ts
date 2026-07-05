// Dashboard health helpers.
// Keeps health aggregation and safe dashboard fallbacks out of server.ts.

import {
  buildHealthReport,
  getSafeErrorMessage,
  type ServiceHealth,
} from "../../envHealth.js";

export interface DashboardHealthWarning {
  service: string;
  status: ServiceHealth["status"];
  message: string;
}

export interface DashboardHealthSummary {
  ok: boolean;
  warnings: DashboardHealthWarning[];
}

function toHealthWarning(
  service: ServiceHealth,
): DashboardHealthWarning | null {
  if (service.status === "ok") return null;

  return {
    service: service.name,
    status: service.status,
    message: service.message,
  };
}

export async function buildDashboardHealthSummary(): Promise<DashboardHealthSummary> {
  const report = await buildHealthReport({
    checkAlpacaConnectivity: false,
    checkOpenAIConnectivity: false,
  });

  const warnings = report.services
    .map(toHealthWarning)
    .filter((warning): warning is DashboardHealthWarning => warning !== null);

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

export async function safeCall<T>(
  label: string,
  operation: () => Promise<T>,
  fallback: T,
  warnings: DashboardHealthWarning[],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    warnings.push({
      service: label,
      status: "error",
      message: getSafeErrorMessage(error),
    });

    return fallback;
  }
}
