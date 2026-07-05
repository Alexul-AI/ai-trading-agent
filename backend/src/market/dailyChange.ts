// Daily market change calculation helpers.

export function calculateDailyChangePercent(
  price: number,
  previousClose: number,
): number {
  if (price <= 0 || previousClose <= 0) return 0;
  return Number((((price - previousClose) / previousClose) * 100).toFixed(2));
}
