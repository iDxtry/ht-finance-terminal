import assert from 'node:assert/strict';
import test from 'node:test';
import { maximumMarketBars, selectMarketBars } from '../supabase/functions/_shared/market-access.js';

test('five-year daily charts load enough bars to cover five trading years for guests and members', () => {
  assert.equal(maximumMarketBars('5Y', '1Day', 1_000), 1_500);
  assert.equal(maximumMarketBars('1Y', '1Day', 260), 260);
  assert.equal(maximumMarketBars('5Y', '1Hour', 1_000), 1_000);
});

test('five-year market history keeps the newest capped bars in chronological order', () => {
  const newestFirst = [5, 4, 3, 2, 1].map((time) => ({ time }));

  assert.deepEqual(selectMarketBars(newestFirst, 3, true), [
    { time: 3 },
    { time: 4 },
    { time: 5 },
  ]);
});

test('five-year guest history can include more than one page of daily bars', () => {
  const providerPages = Array.from({ length: 1_500 }, (_, index) => ({ time: 1_500 - index }));
  const selected = selectMarketBars(providerPages, 1_500, true);

  assert.equal(selected.length, 1_500);
  assert.equal(selected[0].time, 1);
  assert.equal(selected.at(-1).time, 1_500);
});

test('ascending market history preserves the provider order when it fits the limit', () => {
  const chronological = [1, 2, 3].map((time) => ({ time }));

  assert.deepEqual(selectMarketBars(chronological, 10), chronological);
});

test('market history selection tolerates missing provider rows', () => {
  assert.deepEqual(selectMarketBars(undefined, 10, true), []);
});
