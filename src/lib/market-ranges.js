export const MARKET_CHART_RANGES = Object.freeze(['1D', '1W', '1M', '3M', '1Y', '5Y']);

export function isMarketChartRange(value) {
  return MARKET_CHART_RANGES.includes(value);
}
