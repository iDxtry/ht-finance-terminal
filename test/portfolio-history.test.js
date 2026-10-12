import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioHistory } from '../src/lib/portfolio-history.js';

const bar = (date, close) => ({ date, open: close, high: close, low: close, close, volume: 1_000 });
const fill = (author_id, symbol, side, quantity, price, created_at) => ({
  author_id, symbol, side, quantity, price, created_at,
});

test('starts from the shared paper-account cash and values a same-period $100k SPY hold', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [],
    priceBarsBySymbol: {},
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 440)],
  });

  assert.equal(history.startingCash, 100_000);
  assert.equal(history.benchmarkStartingValue, 100_000);
  assert.deepEqual(history.points.map(({ equity, benchmarkEquity }) => [equity, benchmarkEquity]), [
    [100_000, 100_000],
    [100_000, 110_000],
  ]);
  assert.equal(history.metrics.cumulativeReturnPercent, 0);
  assert.ok(Math.abs(history.benchmarkMetrics.cumulativeReturnPercent - 10) < 1e-10);
  assert.equal(history.metrics.annualizedVolatilityPercent, null);
  assert.equal(history.metrics.sharpeRatio, null);
});

test('accepts the Unix-second timestamps used by the market-data service', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [],
    benchmarkBars: [
      { time: Date.parse('2026-01-02T05:00:00.000Z') / 1000, close: 400 },
      { time: Date.parse('2026-01-05T05:00:00.000Z') / 1000, close: 404 },
    ],
  });

  assert.deepEqual(history.points.map((point) => point.date), ['2026-01-02', '2026-01-05']);
  assert.equal(history.points[0].benchmarkEquity, 100_000);
  assert.equal(history.points[1].benchmarkEquity, 101_000);
});

test('ignores malformed daily dates from a market-data response', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    benchmarkBars: [bar('2026-02-30', 400), bar('not-a-date', 405)],
  });

  assert.deepEqual(history.points, []);
  assert.equal(history.metrics.cumulativeReturnPercent, null);
});

test('includes only this account and fills through each daily end timestamp', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [
      fill('intern-a', 'ABC', 'buy', 10, 50, '2026-01-02T15:00:00.000Z'),
      fill('intern-a', 'ABC', 'buy', 2, 60, '2026-01-05T23:59:59.999Z'),
      fill('intern-a', 'ABC', 'buy', 100, 1, '2026-01-06T00:00:00.000Z'),
      fill('intern-b', 'ABC', 'buy', 500, 1, '2026-01-02T12:00:00.000Z'),
    ],
    priceBarsBySymbol: { ABC: [bar('2026-01-02', 55), bar('2026-01-05', 65)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 410)],
  });

  assert.equal(history.points.length, 3);
  assert.equal(history.points[0].positions[0].shares, 10);
  assert.equal(history.points[0].cash, 99_500);
  assert.equal(history.points[0].equity, 100_050);
  assert.equal(history.points[1].positions[0].shares, 12);
  assert.equal(history.points[1].cash, 99_380);
  assert.equal(history.points[1].equity, 100_160);
  assert.equal(history.points[1].positions[0].close, 65);
  assert.equal(history.points[2].date, '2026-01-06');
  assert.equal(history.points[2].positions[0].shares, 112);
  assert.equal(history.points[2].equity, null);
});

test('replays partial and excess sells with the app share-balance model after positions close', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [
      fill('intern-a', 'ABC', 'buy', 10, 100, '2026-01-02T12:00:00.000Z'),
      fill('intern-a', 'ABC', 'sell', 4, 120, '2026-01-05T12:00:00.000Z'),
      fill('intern-a', 'ABC', 'sell', 20, 130, '2026-01-06T12:00:00.000Z'),
    ],
    priceBarsBySymbol: { ABC: [bar('2026-01-02', 110), bar('2026-01-05', 115)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-06', 420)],
  });

  const [, saleDay, finalDay] = history.points;
  assert.equal(saleDay.positions[0].shares, 6);
  assert.equal(saleDay.positions[0].close, 115);
  assert.equal(saleDay.positions[0].marketValue, 690);
  assert.equal(saleDay.cash, 99_480);
  assert.equal(saleDay.realizedPnl, 80);
  assert.equal(finalDay.positions.length, 0);
  assert.equal(finalDay.cash, 100_260);
  assert.equal(finalDay.marketValue, 0);
  assert.equal(finalDay.equity, 100_260);
  assert.equal(finalDay.realizedPnl, 260);
});

test('does not invent a market value when a held symbol has no prior daily close', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [fill('intern-a', 'NEW', 'buy', 5, 20, '2026-01-02T12:00:00.000Z')],
    priceBarsBySymbol: { NEW: [bar('2026-01-05', 22)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 402)],
  });

  assert.equal(history.points[0].marketValue, null);
  assert.equal(history.points[0].equity, null);
  assert.deepEqual(history.points[0].unpricedSymbols, ['NEW']);
  assert.equal(history.points[1].positions[0].close, 22);
  assert.equal(history.points[1].equity, 100_010);
});

test('does not carry an old security close forward across a missing market session', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [fill('intern-a', 'ABC', 'buy', 10, 100, '2026-01-02T12:00:00.000Z')],
    priceBarsBySymbol: { ABC: [bar('2026-01-02', 100), bar('2026-01-06', 105)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 401), bar('2026-01-06', 402)],
  });

  const missingSession = history.points.find((point) => point.date === '2026-01-05');
  assert.equal(missingSession.equity, null);
  assert.equal(missingSession.marketValue, null);
  assert.deepEqual(missingSession.unpricedSymbols, ['ABC']);
  assert.equal(missingSession.benchmarkEquity, 100_250);
  assert.equal(history.points.find((point) => point.date === '2026-01-06').equity, 100_050);
});

test('includes fill-only dates and leaves portfolio and benchmark marks unavailable without same-day bars', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [fill('intern-a', 'ABC', 'buy', 2, 50, '2026-01-05T12:00:00.000Z')],
    priceBarsBySymbol: { ABC: [bar('2026-01-02', 50), bar('2026-01-06', 51)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-06', 404)],
  });

  const fillDay = history.points.find((point) => point.date === '2026-01-05');
  assert.ok(fillDay);
  assert.equal(fillDay.equity, null);
  assert.deepEqual(fillDay.unpricedSymbols, ['ABC']);
  assert.equal(fillDay.benchmarkEquity, null);
  assert.equal(history.points.at(-1).equity, 100_002);
});

test('deduplicates same-session bars so a duplicate cannot create a second return observation', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [],
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-02', 410), bar('2026-01-05', 410)],
  });

  assert.equal(history.points.length, 2);
  assert.equal(history.points[0].benchmarkEquity, 100_000);
  assert.equal(history.points[1].benchmarkEquity, 100_000);
});

test('calculates drawdown, annualized volatility, and Sharpe only when return samples support them', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    trades: [fill('intern-a', 'ABC', 'buy', 100, 100, '2026-01-02T12:00:00.000Z')],
    priceBarsBySymbol: {
      ABC: [bar('2026-01-02', 100), bar('2026-01-05', 110), bar('2026-01-06', 99), bar('2026-01-07', 105)],
    },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 400), bar('2026-01-06', 404), bar('2026-01-07', 402)],
  });

  assert.equal(history.points[0].equity, 100_000);
  assert.equal(history.points[1].equity, 101_000);
  assert.equal(history.points[2].equity, 99_900);
  assert.ok(Math.abs(history.metrics.cumulativeReturnPercent - 0.5) < 1e-10);
  assert.ok(history.metrics.maxDrawdownPercent > 1.08 && history.metrics.maxDrawdownPercent < 1.09);
  assert.ok(Number.isFinite(history.metrics.annualizedVolatilityPercent));
  assert.ok(Number.isFinite(history.metrics.sharpeRatio));
  assert.ok(Number.isFinite(history.benchmarkMetrics.annualizedVolatilityPercent));
});

test('startDate filters plotted dates, replays earlier trades, and begins benchmark at the requested period', () => {
  const history = buildPortfolioHistory({
    userId: 'intern-a',
    startDate: '2026-01-05',
    trades: [fill('intern-a', 'ABC', 'buy', 10, 100, '2026-01-02T12:00:00.000Z')],
    priceBarsBySymbol: { ABC: [bar('2026-01-02', 100), bar('2026-01-05', 120)] },
    benchmarkBars: [bar('2026-01-02', 400), bar('2026-01-05', 440)],
  });

  assert.deepEqual(history.points.map((point) => point.date), ['2026-01-05']);
  assert.equal(history.points[0].equity, 100_200);
  assert.equal(history.points[0].benchmarkEquity, 100_000);
});
