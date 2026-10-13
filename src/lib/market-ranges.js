export const MARKET_CHART_RANGES = Object.freeze(['1D', '1W', '1M', '3M', '1Y', '5Y']);

export function isMarketChartRange(value) {
  return MARKET_CHART_RANGES.includes(value);
}

export function nextMarketChartRange(range) {
  const index = MARKET_CHART_RANGES.indexOf(range);
  return index >= 0 && index < MARKET_CHART_RANGES.length - 1
    ? MARKET_CHART_RANGES[index + 1]
    : null;
}

export function shouldExpandMarketChartRange(logicalRange, barCount, range) {
  if (!nextMarketChartRange(range) || !logicalRange || !Number.isFinite(barCount) || barCount <= 0) return false;
  const from = Number(logicalRange.from);
  const to = Number(logicalRange.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;

  // fitContent() leaves a small right offset. Wait until the user actually
  // zooms or pans into missing history before requesting a broader interval.
  const edgeTolerance = Math.max(8, Math.ceil(barCount * 0.02));
  return from < -edgeTolerance || to > barCount - 1 + edgeTolerance;
}
