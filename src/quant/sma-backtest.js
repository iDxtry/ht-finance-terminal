import { calculateRiskMetrics } from './metrics.js';

function timestampValue(time) {
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  const parsed = Date.parse(time);
  if (Number.isFinite(parsed)) return parsed;
  throw new TypeError('Each bar needs a finite numeric timestamp or parseable date string.');
}

function validateBars(bars, label) {
  if (!Array.isArray(bars) || bars.length < 2) throw new RangeError(`${label} must contain at least two chronological OHLCV bars.`);
  let priorTime = -Infinity;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const time = timestampValue(bar?.time);
    if (time <= priorTime) throw new RangeError(`${label} must be strictly chronological with no duplicate timestamps.`);
    priorTime = time;
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[field])) throw new TypeError(`${label}[${index}].${field} must be finite.`);
    }
    if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0) {
      throw new RangeError(`${label}[${index}] must have positive prices and non-negative volume.`);
    }
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
      throw new RangeError(`${label}[${index}] has inconsistent OHLC values.`);
    }
  }
}

function simpleMovingAverage(closes, endIndex, window) {
  if (endIndex + 1 < window) return null;
  let sum = 0;
  for (let index = endIndex - window + 1; index <= endIndex; index += 1) sum += closes[index];
  return sum / window;
}

function summarize(equity, periodsPerYear, riskFreeRate) {
  return calculateRiskMetrics(equity, { seriesType: 'equity', periodsPerYear, riskFreeRate });
}

/**
 * Backtest a long-or-cash SMA crossover using close prices.
 *
 * A signal is computed from a bar's close and is filled at the next bar's
 * open. The prior position earns the overnight close-to-open move, then the
 * new position earns the open-to-close move. Thus the close used to form a
 * signal is never also used to earn that signal's return. This is a deliberately
 * simple daily-bar model: it assumes frictionless execution at the next open,
 * fractional exposure, no dividends, fees, taxes, borrow, or slippage.
 * It does not imply that historical results predict future performance.
 *
 * `benchmarkBars`, when supplied, must be timestamp-aligned one-for-one with
 * the traded instrument. Otherwise the instrument's own buy-and-hold return
 * is used as the benchmark. Both summaries cover the same periods and share
 * the same output metric names.
 */
export function backtestSmaCrossover(bars, {
  shortWindow = 20,
  longWindow = 50,
  initialCapital = 100_000,
  benchmarkBars = null,
  periodsPerYear = 252,
  riskFreeRate = 0,
} = {}) {
  validateBars(bars, 'bars');
  if (!Number.isInteger(shortWindow) || shortWindow < 1) throw new RangeError('shortWindow must be a positive integer.');
  if (!Number.isInteger(longWindow) || longWindow < 2 || shortWindow >= longWindow) {
    throw new RangeError('longWindow must be an integer greater than shortWindow.');
  }
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError('initialCapital must be positive and finite.');
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) throw new RangeError('periodsPerYear must be positive and finite.');
  if (!Number.isFinite(riskFreeRate)) throw new TypeError('riskFreeRate must be finite.');

  if (benchmarkBars !== null) {
    validateBars(benchmarkBars, 'benchmarkBars');
    if (benchmarkBars.length !== bars.length || benchmarkBars.some((bar, index) => timestampValue(bar.time) !== timestampValue(bars[index].time))) {
      throw new RangeError('benchmarkBars must be aligned one-for-one by timestamp with bars.');
    }
  }

  const strategyEquity = [initialCapital];
  const benchmarkEquity = [initialCapital];
  const equityCurve = [{
    time: bars[0].time,
    strategyEquity: initialCapital,
    benchmarkEquity: initialCapital,
    exposure: 0,
    signal: 'cash',
  }];
  const closes = bars.map((bar) => bar.close);
  const benchmarkCloses = (benchmarkBars || bars).map((bar) => bar.close);
  const trades = [];
  let previousExposure = 0;

  for (let index = 1; index < bars.length; index += 1) {
    const signalIndex = index - 1;
    const fast = simpleMovingAverage(closes, signalIndex, shortWindow);
    const slow = simpleMovingAverage(closes, signalIndex, longWindow);
    const exposure = fast !== null && slow !== null && fast > slow ? 1 : 0;
    const signal = fast === null || slow === null ? 'warmup' : exposure ? 'long' : 'cash';
    const overnightReturn = bars[index].open / bars[index - 1].close - 1;
    const intradayReturn = bars[index].close / bars[index].open - 1;
    const benchmarkReturn = benchmarkCloses[index] / benchmarkCloses[index - 1] - 1;
    const priorExposure = previousExposure;
    const nextStrategyEquity = strategyEquity.at(-1)
      * (1 + priorExposure * overnightReturn)
      * (1 + exposure * intradayReturn);
    const nextBenchmarkEquity = benchmarkEquity.at(-1) * (1 + benchmarkReturn);
    strategyEquity.push(nextStrategyEquity);
    benchmarkEquity.push(nextBenchmarkEquity);

    if (exposure !== previousExposure) {
      trades.push({
        time: bars[index].time,
        side: exposure ? 'buy' : 'sell',
        executionPrice: bars[index].open,
        signalTime: bars[signalIndex].time,
        shortAverage: fast,
        longAverage: slow,
        exposure,
      });
    }
    previousExposure = exposure;
    equityCurve.push({
      time: bars[index].time,
      strategyEquity: nextStrategyEquity,
      benchmarkEquity: nextBenchmarkEquity,
      exposure,
      signal,
    });
  }

  return {
    settings: { shortWindow, longWindow, initialCapital, periodsPerYear, riskFreeRate },
    strategy: summarize(strategyEquity, periodsPerYear, riskFreeRate),
    benchmark: summarize(benchmarkEquity, periodsPerYear, riskFreeRate),
    equityCurve,
    trades,
  };
}
