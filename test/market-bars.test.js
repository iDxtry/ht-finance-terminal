import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMarketBars } from '../supabase/functions/_shared/market-access.js';

test('five-year market history keeps the newest capped bars in chronological order', () => {
  const newestFirst = [5, 4, 3, 2, 1].map((time) => ({ time }));

  assert.deepEqual(selectMarketBars(newestFirst, 3, true), [
    { time: 3 },
    { time: 4 },
    { time: 5 },
  ]);
});

test('ascending market history preserves the provider order when it fits the limit', () => {
  const chronological = [1, 2, 3].map((time) => ({ time }));

  assert.deepEqual(selectMarketBars(chronological, 10), chronological);
});

test('market history selection tolerates missing provider rows', () => {
  assert.deepEqual(selectMarketBars(undefined, 10, true), []);
});
