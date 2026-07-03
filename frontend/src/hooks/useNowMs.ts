import { useEffect, useState } from "react";

export function useNowMs(enabled: boolean, refreshMs = 30_000): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const updateNow = () => {
      setNowMs(Date.now());
    };

    const timeoutId = window.setTimeout(updateNow, 0);
    const intervalId = window.setInterval(updateNow, refreshMs);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [enabled, refreshMs]);

  return enabled ? nowMs : null;
}
