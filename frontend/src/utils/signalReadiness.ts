export interface SignalReadinessDecision {
  action: string;
  confidence: number;
  suggestedShares: number;
  skippedReason?: string;
  signalStatus?: string;
  isSignalReady?: boolean;
  /**
   * Legacy field kept only for old journal rows created before the strict
   * signal schema migration. New API responses should not emit this field.
   */
  isActionable?: boolean;
}

export function isBuySellSignal(action: string): boolean {
  return action === "BUY" || action === "SELL";
}

export function isExecutionOnlySkippedReason(
  skippedReason: string | undefined,
): boolean {
  if (!skippedReason) return false;

  const reason = skippedReason.toLowerCase();

  return (
    reason.includes("dry-run") ||
    reason.includes("dry run") ||
    reason.includes("execution blocked") ||
    reason.includes("allow_autopilot") ||
    reason.includes("allow_buy") ||
    reason.includes("allow_sell") ||
    reason.includes("outside paper mode")
  );
}

export function isSignalReadyDecision<
  TDecision extends SignalReadinessDecision,
>(decision: TDecision, minConfidence: number): boolean {
  if (
    decision.signalStatus === "ready" ||
    decision.isSignalReady === true ||
    decision.isActionable === true
  ) {
    return true;
  }

  if (
    decision.signalStatus === "blocked" ||
    decision.isSignalReady === false ||
    decision.isActionable === false
  ) {
    return false;
  }

  return (
    isBuySellSignal(decision.action) &&
    decision.suggestedShares > 0 &&
    decision.confidence >= minConfidence &&
    (!decision.skippedReason ||
      isExecutionOnlySkippedReason(decision.skippedReason))
  );
}

export function getSignalReadyDecisions<
  TDecision extends SignalReadinessDecision,
>(decisions: TDecision[], minConfidence: number): TDecision[] {
  return decisions.filter((decision) =>
    isSignalReadyDecision(decision, minConfidence),
  );
}

export function getLatestSignalReadyDecision<
  TDecision extends SignalReadinessDecision,
>(decisions: TDecision[], minConfidence: number): TDecision | null {
  const candidates = getSignalReadyDecisions(decisions, minConfidence);

  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
}

export function countSignalReadyDecisions<
  TDecision extends SignalReadinessDecision,
>(decisions: TDecision[], minConfidence: number): number {
  return getSignalReadyDecisions(decisions, minConfidence).length;
}

export function countSignalBlockedDecisions<
  TDecision extends SignalReadinessDecision,
>(decisions: TDecision[], minConfidence: number): number {
  return decisions.filter(
    (decision) =>
      isBuySellSignal(decision.action) &&
      !isSignalReadyDecision(decision, minConfidence),
  ).length;
}
