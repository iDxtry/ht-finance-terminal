import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTrainingBars, trainingSnapshot, trainingSnapshots } from '../src/services/training-market.js';
import { cleanSymbol, findInstruments, INSTRUMENTS } from '../src/data/universe.js';
import {
  hashMarketClientKey,
  getSupabaseClientKeys,
  GUEST_MARKET_LIMITS,
  isPublicMarketSymbol,
  isPublicSupabaseToken,
  PUBLIC_MARKET_SYMBOLS,
} from '../supabase/functions/_shared/market-access.js';
import { marketBarsCacheKey, marketSnapshotCacheKey } from '../supabase/functions/_shared/market-cache.js';
import { clearMarketCache, loadBars, loadSnapshots, MarketDataError } from '../src/services/market-data.js';

function publicMarketClient(response, userId = null) {
  const calls = [];
  return {
    calls,
    supabaseKey: 'public-project-key',
    auth: {
      async getSession() {
        return {
          data: { session: userId ? { user: { id: userId }, access_token: `access-${userId}` } : null },
          error: null,
        };
      },
    },
    functions: {
      async invoke(name, options) {
        calls.push({ name, options });
        return typeof response === 'function' ? response(options) : response;
      },
    },
  };
}

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

test('guest limiter keys are fixed-length hashes and do not expose client addresses', async () => {
  const first = await hashMarketClientKey('203.0.113.42');
  const second = await hashMarketClientKey('203.0.113.42');
  const other = await hashMarketClientKey('203.0.113.43');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.doesNotMatch(first, /203\.0\.113/);
});

test('Edge Function snapshot cache isolates viewer access and caller-specific unavailable symbols', () => {
  const common = { symbols: ['SPY', 'AAPL'] };
  const memberKey = marketSnapshotCacheKey({ ...common, viewer: 'member' });
  const guestKey = marketSnapshotCacheKey({ ...common, viewer: 'guest' });
  const guestWithUnavailableSymbol = marketSnapshotCacheKey({
    ...common,
    unavailableSymbols: ['PRIVATE-TICKER'],
    viewer: 'guest',
  });
  const sameGuestQueryReordered = marketSnapshotCacheKey({
    symbols: ['AAPL', 'SPY'],
    viewer: 'guest',
  });

  assert.notEqual(memberKey, guestKey);
  assert.notEqual(guestKey, guestWithUnavailableSymbol);
  assert.equal(guestKey, sameGuestQueryReordered);
});

test('Edge Function chart cache isolates guest caps from member history', () => {
  const memberKey = marketBarsCacheKey({
    symbol: 'SPY', timeframe: '1Day', range: '5Y', limit: 1000,
    maximumBars: 1500, viewer: 'member',
  });
  const guestKey = marketBarsCacheKey({
    symbol: 'SPY', timeframe: '1Day', range: '5Y', limit: 1000,
    maximumBars: 1000, viewer: 'guest',
  });
  assert.notEqual(memberKey, guestKey);
});

test('signed-out clients can request shared IEX snapshots without a user session', async () => {
  clearMarketCache();
  const client = publicMarketClient({
    error: null,
    data: {
      ok: true,
      feed: 'iex',
      quotes: {
        SPY: {
          symbol: 'SPY', price: 592.25, change: 1.25, changePercent: 0.21,
          open: 591, high: 593, low: 590, previousClose: 591,
          volume: 100, bid: 592.2, ask: 592.3, timestamp: '2026-10-12T15:00:00Z', feed: 'iex',
        },
      },
      receivedAt: '2026-10-12T15:00:01Z',
    },
  });

  const result = await loadSnapshots(client, ['spy']);
  assert.equal(result.quotes.SPY.price, 592.25);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, 'market-data');
  assert.deepEqual(client.calls[0].options.body, { action: 'snapshots', symbols: ['SPY'] });
  assert.deepEqual(client.calls[0].options.headers, { Authorization: 'Bearer public-project-key' });
});

test('expired member sessions fall back to the rate-limited public market allow-list', async () => {
  clearMarketCache();
  const calls = [];
  const client = {
    supabaseKey: 'public-project-key',
    auth: {
      async getSession() {
        return { data: { session: { user: { id: 'member-a' }, access_token: 'expired-member-token' } }, error: null };
      },
    },
    functions: {
      async invoke(name, options) {
        calls.push({ name, options });
        if (calls.length === 1) {
          return {
            data: null,
            error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
              context: new Response(JSON.stringify({
                ok: false,
                error: 'Your session expired. Sign in again to load market data.',
              }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
            }),
          };
        }
        return {
          error: null,
          data: {
            ok: true,
            feed: 'iex',
            quotes: {
              SPY: {
                symbol: 'SPY', price: 592.25, change: 1.25, changePercent: 0.21,
                open: 591, high: 593, low: 590, previousClose: 591,
                volume: 100, bid: 592.2, ask: 592.3, timestamp: '2026-10-12T15:00:00Z', feed: 'iex',
              },
            },
            receivedAt: '2026-10-12T15:00:01Z',
          },
        };
      },
    },
  };

  const result = await loadSnapshots(client, ['SPY']);
  assert.equal(result.quotes.SPY.price, 592.25);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer expired-member-token' });
  assert.deepEqual(calls[1].options.headers, { Authorization: 'Bearer public-project-key' });
});

test('large guest watchlists are split into guest-safe requests and combined with timestamps', async () => {
  clearMarketCache();
  const timestamp = '2026-10-12T15:00:00Z';
  const receivedAt = '2026-10-12T15:00:01Z';
  const client = publicMarketClient(({ body }) => ({
    error: null,
    data: {
      ok: true,
      feed: 'iex',
      quotes: Object.fromEntries(body.symbols.map((symbol) => [symbol, {
        symbol,
        price: 100,
        change: 1,
        changePercent: 1,
        open: 99,
        high: 101,
        low: 98,
        previousClose: 99,
        volume: 1000,
        bid: 99.9,
        ask: 100.1,
        timestamp,
        feed: 'iex',
      }])),
      unavailableSymbols: [],
      marketClock: { isOpen: true, timestamp: receivedAt, timeZone: 'America/New_York' },
      receivedAt,
    },
  }));

  const symbols = INSTRUMENTS.map(([symbol]) => symbol).slice(0, 40);
  const result = await loadSnapshots(client, symbols);
  assert.equal(client.calls.length, Math.ceil(symbols.length / GUEST_MARKET_LIMITS.snapshotSymbols));
  assert.ok(client.calls.every(({ options }) => options.body.symbols.length <= GUEST_MARKET_LIMITS.snapshotSymbols));
  assert.equal(Object.keys(result.quotes).length, symbols.length);
  assert.equal(result.receivedAt, receivedAt);
  assert.equal(result.feed, 'iex');
});

test('member quote cache entries never leak into the signed-out guest cache', async () => {
  clearMarketCache();
  const quote = (price) => ({
    symbol: 'SPY', price, change: 0, changePercent: 0,
    open: price, high: price, low: price, previousClose: price,
    volume: 100, bid: price, ask: price, timestamp: '2026-10-12T15:00:00Z', feed: 'iex',
  });
  const member = publicMarketClient({
    error: null,
    data: { ok: true, feed: 'iex', quotes: { SPY: quote(600) }, receivedAt: '2026-10-12T15:00:01Z' },
  }, 'member-a');
  const guest = publicMarketClient({
    error: null,
    data: { ok: true, feed: 'iex', quotes: { SPY: quote(590) }, receivedAt: '2026-10-12T15:00:01Z' },
  });

  assert.equal((await loadSnapshots(member, ['SPY'])).quotes.SPY.price, 600);
  assert.equal((await loadSnapshots(guest, ['SPY'])).quotes.SPY.price, 590);
  assert.equal(member.calls.length, 1);
  assert.equal(guest.calls.length, 1);
  assert.deepEqual(member.calls[0].options.headers, { Authorization: 'Bearer access-member-a' });
  assert.deepEqual(guest.calls[0].options.headers, { Authorization: 'Bearer public-project-key' });
});

test('missing public client configuration does not incorrectly require login or per-user keys', async () => {
  clearMarketCache();
  await assert.rejects(loadSnapshots(null, ['SPY']), (error) => {
    assert.ok(error instanceof MarketDataError);
    assert.equal(error.code, 'CLIENT_NOT_CONFIGURED');
    assert.match(error.message, /public Supabase client is not configured/i);
    assert.doesNotMatch(error.message, /sign in|your Alpaca|personal.*key/i);
    return true;
  });
});

test('market service rejects synthetic or malformed responses instead of caching them as real', async () => {
  clearMarketCache();
  const syntheticClient = publicMarketClient({
    error: null,
    data: { ok: true, feed: 'training-sim', quotes: { SPY: { price: 999 } } },
  });
  await assert.rejects(loadSnapshots(syntheticClient, ['SPY']), { code: 'UNTRUSTED_MARKET_DATA' });

  clearMarketCache();
  const zeroQuoteClient = publicMarketClient({
    error: null,
    data: { ok: true, feed: 'iex', quotes: { SPY: { symbol: 'SPY', price: 0, feed: 'iex', timestamp: '2026-10-12T15:00:00Z' } }, receivedAt: '2026-10-12T15:00:01Z' },
  });
  await assert.rejects(loadSnapshots(zeroQuoteClient, ['SPY']), { code: 'INVALID_RESPONSE' });

  clearMarketCache();
  const malformedClient = publicMarketClient({
    error: null,
    data: {
      ok: true,
      feed: 'iex',
      bars: [{ time: 1_800_000_000, open: 10, high: 9, low: 8, close: 8.5, volume: 1 }],
      receivedAt: '2026-10-12T15:00:01Z',
    },
  });
  await assert.rejects(loadBars(malformedClient, 'SPY', '1M'), { code: 'INVALID_RESPONSE' });
});

test('rate-limit errors expose a retry delay without leaking provider setup details', async () => {
  clearMarketCache();
  const client = publicMarketClient({
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify({
        ok: false,
        code: 'RATE_LIMITED',
        error: 'Guest market-data limit reached.',
      }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }),
    }),
  });
  await assert.rejects(loadSnapshots(client, ['SPY']), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterSeconds, 60);
    assert.match(error.message, /wait a minute/i);
    return true;
  });
});

test('shared feed configuration errors are explained as an admin-side connection', async () => {
  clearMarketCache();
  const client = publicMarketClient({
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify({
        ok: false,
        code: 'FEED_NOT_CONFIGURED',
        error: 'Alpaca IEX keys are not connected. Open Setup for the free feed instructions.',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    }),
  });
  await assert.rejects(loadSnapshots(client, ['SPY']), (error) => {
    assert.equal(error.code, 'FEED_NOT_CONFIGURED');
    assert.match(error.message, /shared Alpaca IEX connection is not configured on the server/i);
    assert.doesNotMatch(error.message, /Open Setup|create.*key|sign in/i);
    return true;
  });
});

test('universe searches by ticker or company and symbol input is normalized', () => {
  assert.equal(findInstruments('nvda')[0].symbol, 'NVDA');
  assert.equal(findInstruments('apple')[0].symbol, 'AAPL');
  assert.equal(cleanSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => cleanSymbol(''), /valid ticker/i);
});
