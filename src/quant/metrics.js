function validateSeries(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError(`${label} must be a non-empty array.`);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new TypeError(`${label}[${index}] must be finite.`);
  });
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquared = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(sumSquared / (values.length - 1));
}

function drawdownForEquity(equity) {
  let peak = equity[0];
  let maxDrawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  return maxDrawdown;
}

/**
 * Calculate basic performance and risk metrics from either marked equity
 * values or period returns. Returns are decimals (0.02 means +2%); equity
 * values must be positive. `riskFreeRate` is an annual decimal rate.
 *
 * Sharpe is null unless at least two returns have non-zero sample deviation;
 * this avoids presenting a meaningless ratio for a one-observation or flat
 * series. Results from short samples remain statistically fragile.
 */
export function calculateRiskMetrics(series, {
  seriesType = 'equity',
  periodsPerYear = 252,
  riskFreeRate = 0,
} = {}) {
  validateSeries(series, 'series');
  if (!['equity', 'returns'].includes(seriesType)) throw new TypeError("seriesType must be 'equity' or 'returns'.");
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) throw new RangeError('periodsPerYear must be positive and finite.');
  if (!Number.isFinite(riskFreeRate)) throw new TypeError('riskFreeRate must be finite.');

  let equity;
  let returns;
  if (seriesType === 'equity') {
    if (series.some((value) => value <= 0)) throw new RangeError('Equity values must be positive to calculate returns.');
    equity = [...series];
    returns = series.slice(1).map((value, index) => value / series[index] - 1);
  } else {
    if (series.some((value) => value < -1)) throw new RangeError('A period return cannot be below -100%.');
    returns = [...series];
    equity = [1];
    for (const value of returns) equity.push(equity.at(-1) * (1 + value));
  }

  const deviation = sampleStandardDeviation(returns);
  const annualizedVolatility = deviation === null ? null : deviation * Math.sqrt(periodsPerYear);
  const periodicRiskFreeRate = riskFreeRate / periodsPerYear;
  const excessReturns = returns.map((value) => value - periodicRiskFreeRate);
  const excessDeviation = sampleStandardDeviation(excessReturns);
  const meanExcess = excessReturns.length
    ? excessReturns.reduce((sum, value) => sum + value, 0) / excessReturns.length
    : null;
  const sharpeRatio = excessDeviation === null || excessDeviation === 0
    ? null
    : (meanExcess / excessDeviation) * Math.sqrt(periodsPerYear);
  const cumulativeReturn = equity.length > 1 ? equity.at(-1) / equity[0] - 1 : 0;
  const annualizedReturn = returns.length === 0
    ? null
    : cumulativeReturn <= -1
      ? -1
      : (1 + cumulativeReturn) ** (periodsPerYear / returns.length) - 1;

  return {
    observations: returns.length,
    cumulativeReturn,
    annualizedReturn,
    annualizedVolatility,
    maxDrawdown: drawdownForEquity(equity),
    sharpeRatio,
    finalEquity: equity.at(-1),
  };
}
