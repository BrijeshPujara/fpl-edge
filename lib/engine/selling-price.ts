/**
 * What FPL pays you for a player you sell.
 *
 * Not the current price. A rise since purchase is split with FPL — you keep
 * half, rounded DOWN to the nearest £0.1m — while a fall is borne in full. So a
 * player bought at £5.0m and now £5.3m sells for £5.1m, and one now £4.8m sells
 * for £4.8m.
 *
 * This matters wherever a squad is valued for a rebuild. Using current prices
 * overstates the budget of any squad that has risen, and the shadow manager
 * would then buy squads the real rules forbid — winning by an amount that is
 * pure accounting error.
 */
export function sellingPrice(purchasePrice: number, currentPrice: number): number {
  if (currentPrice <= purchasePrice) return currentPrice;
  return purchasePrice + Math.floor((currentPrice - purchasePrice) / 2);
}
