import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestSmaCrossover, calculateRiskMetrics, simulateMonteCarloGBM } from '../src/quant/index.js';

test('GBM paths are reproducible from a seed and stay positive', () => {
  const options = { initialPrice: 100, drift: 0.08, volatility: 0.25, horizonYears: 2, steps: 20, pathCount: 8, seed: 'club-demo' };
  const first = simulateMonteCarloGBM(options);
  const second = simulateMonteCarloGBM(options);
  assert.deepEqual(first, second);
  assert.equal(first.paths.length, 8);
  assert.equal(first.paths[0].length, 21);
  assert.equal(first.paths[0][0], 100);
  assert.ok(first.paths.flat().every((price) => Number.isFinite(price) && price > 0));
  assert.notDeepEqual(first.paths[0], first.paths[1]);
});

test('zero-volatility GBM follows its closed-form deterministic path', () => {
  const { paths } = simulateMonteCarloGBM({ initialPrice: 100, drift: 0.1, volatility: 0, horizonYears: 1, steps: 2, pathCount: 2, seed: 7 });
  const expectedHalfway = 100 * Math.exp(0.05);
  const expectedEnd = 100 * Math.exp(0.1);
  assert.ok(Math.abs(paths[0][1] - expectedHalfway) < 1e-12);
  assert.ok(Math.abs(paths[0][2] - expectedEnd) < 1e-12);
  assert.deepEqual(paths[0], paths[1]);
});

test('GBM rejects invalid inputs and excessive allocations', () => {
  assert.throws(() => simulateMonteCarloGBM({ initialPrice: 0 }), /initialPrice/);
  assert.throws(() => simulateMonteCarloGBM({ initialPrice: 10, volatility: -1 }), /volatility/);
  assert.throws(() => simulateMonteCarloGBM({ initialPrice: 10, steps: 10_000, pathCount: 1_001 }), /may not exceed/);
});

test('risk metrics derive return, volatility, Sharpe, and drawdown from equity', () => {
  const metrics = calculateRiskMetrics([100, 110, 88], { periodsPerYear: 1, riskFreeRate: 0 });
  assert.equal(metrics.observations, 2);
  assert.ok(Math.abs(metrics.cumulativeReturn + 0.12) < 1e-12);
  assert.ok(Math.abs(metrics.maxDrawdown - 0.2) < 1e-12);
  const expectedVolatility = Math.sqrt(((0.1 - (-0.05)) ** 2 + (-0.2 - (-0.05)) ** 2) / 1);
  assert.ok(Math.abs(metrics.annualizedVolatility - expectedVolatility) < 1e-12);
  assert.ok(Number.isFinite(metrics.sharpeRatio));
});

test('Sharpe is null when there are too few observations or no return variance', () => {
  assert.equal(calculateRiskMetrics([100], { seriesType: 'equity' }).sharpeRatio, null);
  assert.equal(calculateRiskMetrics([0.01, 0.01], { seriesType: 'returns' }).sharpeRatio, null);
  assert.ok(Math.abs(calculateRiskMetrics([0.1, -0.1], { seriesType: 'returns', periodsPerYear: 1 }).maxDrawdown - 0.1) < 1e-12);
});

test('SMA crossover uses prior-close signals and returns benchmark-compatible metrics', () => {
  const closes = [10, 9, 8, 10, 12, 14];
  const bars = closes.map((close, index) => ({
    time: index + 1,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
  const result = backtestSmaCrossover(bars, { shortWindow: 1, longWindow: 2, initialCapital: 100, periodsPerYear: 5 });

  // At time 4's close, the fast average crosses above the slow average.
  // It fills at time 5's open, so it cannot earn the move into that open.
  assert.equal(result.equityCurve[3].exposure, 0);
  assert.equal(result.equityCurve[4].exposure, 1);
  assert.equal(result.equityCurve[4].strategyEquity, 100);
  assert.ok(Math.abs(result.strategy.finalEquity - 100 * (14 / 12)) < 1e-10);
  assert.equal(result.benchmark.finalEquity, 140);
  assert.equal(result.strategy.observations, result.benchmark.observations);
  assert.equal(result.trades[0].time, 5);
  assert.equal(result.trades[0].signalTime, 4);
  assert.equal(result.trades[0].executionPrice, 12);
});

test('SMA backtest validates chronology and benchmark alignment', () => {
  const bar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
  assert.throws(() => backtestSmaCrossover([bar(2, 10), bar(1, 11)], { shortWindow: 1, longWindow: 2 }), /chronological/);
  assert.throws(() => backtestSmaCrossover([bar(1, 10), bar(2, 11)], {
    shortWindow: 1,
    longWindow: 2,
    benchmarkBars: [bar(1, 10), bar(3, 11)],
  }), /aligned/);
});
