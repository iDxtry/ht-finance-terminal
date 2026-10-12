import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTrainingBars, trainingSnapshot, trainingSnapshots } from '../src/services/training-market.js';
import { cleanSymbol, findInstruments, INSTRUMENTS } from '../src/data/universe.js';
import {
  createGuestRateLimiter,
  getSupabaseClientKeys,
  GUEST_MARKET_LIMITS,
  isPublicMarketSymbol,
  isPublicSupabaseToken,
  PUBLIC_MARKET_SYMBOLS,
} from '../supabase/functions/_shared/market-access.js';

test('training candles are deterministic and internally valid', () => {
  const first = generateTrainingBars('AAPL', 35);
  const second = generateTrainingBars('AAPL', 35);
  assert.deepEqual(first, second);
  assert.equal(first.length, 35);
  for (const bar of first) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close));
    assert.ok(bar.low <= Math.min(bar.open, bar.close));
    assert.ok(bar.volume > 0);
  }
});

test('intraday training ranges produce intraday timestamps', () => {
  const daily = generateTrainingBars('SPY', 78, '5Min');
  assert.equal(daily.length, 78);
  assert.ok(daily.at(-1).time - daily[0].time < 86_400);
});

test('training snapshots identify themselves as synthetic', () => {
  const quote = trainingSnapshot('NVDA');
  assert.equal(quote.feed, 'training-sim');
  assert.ok(quote.price > 0);
  assert.equal(trainingSnapshots(['SPY', 'QQQ']).SPY.feed, 'training-sim');
});

test('guest market coverage matches the app instrument universe', () => {
  const appSymbols = INSTRUMENTS.map(([symbol]) => symbol);
  assert.deepEqual(new Set(appSymbols), PUBLIC_MARKET_SYMBOLS);
  assert.equal(isPublicMarketSymbol('spy'), true);
  assert.equal(isPublicMarketSymbol('UNLISTED'), false);
  assert.equal(GUEST_MARKET_LIMITS.snapshotSymbols, 12);
  const publishableKeys = getSupabaseClientKeys('legacy-anon-key', '{"default":"sb_publishable_project-key"}');
  assert.equal(isPublicSupabaseToken('sb_publishable_project-key', publishableKeys), true);
  assert.equal(isPublicSupabaseToken('legacy-anon-key', publishableKeys), true);
  assert.equal(isPublicSupabaseToken('user-access-token', publishableKeys), false);
});

test('guest market requests are rate limited per client and reset each minute', () => {
  const allow = createGuestRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  assert.equal(allow('client-a', 1_000), true);
  assert.equal(allow('client-a', 2_000), true);
  assert.equal(allow('client-a', 3_000), false);
  assert.equal(allow('client-b', 3_000), true);
  assert.equal(allow('client-a', 60_000), true);
});

test('universe searches by ticker or company and symbol input is normalized', () => {
  assert.equal(findInstruments('nvda')[0].symbol, 'NVDA');
  assert.equal(findInstruments('apple')[0].symbol, 'AAPL');
  assert.equal(cleanSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => cleanSymbol(''), /valid ticker/i);
});
