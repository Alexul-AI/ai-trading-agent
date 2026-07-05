// Alpaca price parsing helpers.
// Kept separate from server.ts so market data normalization is testable.

import { asRecord, toNumber, toStringValue } from "../utils/values.js";

export function extractAlpacaPrice(value: unknown): number {
  const record = asRecord(value);

  const possibleFields = [
    record.Price,
    record.price,
    record.p,
    record.P,
    record.close,
    record.c,
  ];

  for (const field of possibleFields) {
    const parsed = toNumber(field, 0);
    if (parsed > 0) return parsed;
  }

  return 0;
}
