import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMarketChartRange,
  nextMarketChartRange,
  shouldExpandMarketChartRange,
} from '../src/lib/market-ranges.js';

test('chart ranges expand one step at a time and stop at five years', () => {
  assert.deepEqual(['1D', '1W', '1M', '3M', '1Y'].map(nextMarketChartRange), ['1W', '1M', '3M', '1Y', '5Y']);
  assert.equal(nextMarketChartRange('5Y'), null);
  assert.equal(nextMarketChartRange('unknown'), null);
  assert.equal(isMarketChartRange('5Y'), true);
  assert.equal(isMarketChartRange('all'), false);
});

test('chart requests a wider range only when zoom or pan reaches beyond loaded bars', () => {
  assert.equal(shouldExpandMarketChartRange({ from: 20, to: 180 }, 200, '1M'), false);
  assert.equal(shouldExpandMarketChartRange({ from: -9, to: 180 }, 200, '1M'), true);
  assert.equal(shouldExpandMarketChartRange({ from: 20, to: 209 }, 200, '1M'), true);
  assert.equal(shouldExpandMarketChartRange({ from: -100, to: 1400 }, 1264, '5Y'), false);
  assert.equal(shouldExpandMarketChartRange(null, 200, '1M'), false);
  assert.equal(shouldExpandMarketChartRange({ from: 0, to: 100 }, 0, '1M'), false);
});
