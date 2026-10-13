import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMarketChartRange,
  MARKET_CHART_RANGES,
  nextMarketChartRange,
  clampMarketChartLogicalRange,
  shouldExpandMarketChartRange,
} from '../src/lib/market-ranges.js';

test('chart ranges expand one step at a time and stop at all available history', () => {
  assert.deepEqual(MARKET_CHART_RANGES, ['1D', '1W', '2W', '1M', '3M', '6M', '1Y', '2Y', '5Y', 'ALL']);
  assert.deepEqual(MARKET_CHART_RANGES.slice(0, -1).map(nextMarketChartRange), MARKET_CHART_RANGES.slice(1));
  assert.equal(nextMarketChartRange('ALL'), null);
  assert.equal(nextMarketChartRange('unknown'), null);
  assert.equal(isMarketChartRange('5Y'), true);
  assert.equal(isMarketChartRange('ALL'), true);
});

test('all-history chart ranges clamp to available bars without changing an in-bounds zoom', () => {
  assert.equal(clampMarketChartLogicalRange({ from: 20, to: 80 }, 100), null);
  assert.deepEqual(clampMarketChartLogicalRange({ from: -10, to: 40 }, 100), { from: 0, to: 50 });
  assert.deepEqual(clampMarketChartLogicalRange({ from: 60, to: 110 }, 100), { from: 49, to: 99 });
  assert.deepEqual(clampMarketChartLogicalRange({ from: -20, to: 120 }, 100), { from: 0, to: 99 });
  assert.equal(clampMarketChartLogicalRange({ from: 0, to: 1 }, 1), null);
  assert.equal(clampMarketChartLogicalRange(null, 100), null);
});

test('chart requests a wider range only when zoom or pan reaches beyond loaded bars', () => {
  assert.equal(shouldExpandMarketChartRange({ from: 20, to: 180 }, 200, '1M'), false);
  assert.equal(shouldExpandMarketChartRange({ from: -9, to: 180 }, 200, '1M'), true);
  assert.equal(shouldExpandMarketChartRange({ from: 20, to: 209 }, 200, '1M'), true);
  assert.equal(shouldExpandMarketChartRange({ from: -100, to: 1400 }, 1264, '5Y'), true);
  assert.equal(shouldExpandMarketChartRange({ from: -10, to: 1264 }, 1264, 'ALL'), false);
  assert.equal(shouldExpandMarketChartRange(null, 200, '1M'), false);
  assert.equal(shouldExpandMarketChartRange({ from: 0, to: 100 }, 0, '1M'), false);
});
