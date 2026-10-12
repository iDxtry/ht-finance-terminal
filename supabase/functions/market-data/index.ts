import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createGuestRateLimiter,
  getSupabaseClientKeys,
  GUEST_MARKET_LIMITS,
  isPublicMarketSymbol,
  isPublicSupabaseToken,
} from '../_shared/market-access.js';

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json',
  'Vary': 'Origin',
};

const allowedOrigins = new Set([
  'https://ht-finance-terminal.vercel.app',
  'https://idxtry.github.io',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);
const maxBodyBytes = 8 * 1024;
const allowGuestRequest = createGuestRateLimiter();

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:'
      && /^ht-finance-terminal-[a-z0-9-]+-anish-batra-s-projects\.vercel\.app$/.test(url.hostname);
  } catch {
    return false;
  }
}

// Edge isolates are short-lived, but even a small cache absorbs duplicate chart
// and watchlist refreshes while users move between terminal workspaces.
const responseCache = new Map<string, { expiresAt: number; body: unknown }>();

function cachedResponse(key: string, ttlMs: number, origin: string) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return response(entry.body, 200, origin);
}

function cacheResponse(key: string, ttlMs: number, body: unknown, origin: string) {
  if (responseCache.size > 200) {
    for (const [cacheKey, entry] of responseCache) {
      if (entry.expiresAt <= Date.now() || responseCache.size > 150) responseCache.delete(cacheKey);
    }
  }
  responseCache.set(key, { expiresAt: Date.now() + ttlMs, body });
  return response(body, 200, origin);
}

function response(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Access-Control-Allow-Origin': origin },
  });
}

function validSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,11}$/.test(value);
}

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Allow-Origin': origin } });
  }
  if (request.method !== 'POST') {
    return response({ ok: false, error: 'Use a POST request.' }, 405, origin);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const authorization = request.headers.get('Authorization');
  const apiKey = request.headers.get('apikey');
  if (!supabaseUrl || !anonKey || !authorization) {
    return response({ ok: false, error: 'The public market-data client is not configured.' }, 401, origin);
  }

  const acceptedClientKeys = getSupabaseClientKeys(anonKey, Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '');
  const authorizationToken = authorization.replace(/^Bearer\s+/i, '');
  if (!acceptedClientKeys.has(apiKey || '')) {
    return response({ ok: false, error: 'The market-data API key is not valid for this project.' }, 401, origin);
  }

  let hasMemberMarketAccess = false;
  if (!isPublicSupabaseToken(authorizationToken, acceptedClientKeys)) {
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return response({ ok: false, error: 'Your session expired. Sign in again to load market data.' }, 401, origin);
    }
    const { data: mayReadMarket, error: permissionError } = await supabase.rpc('has_permission', {
      permission_key: 'market_data.read',
    });
    hasMemberMarketAccess = !permissionError && mayReadMarket === true;
  }
  const isPublicViewer = !hasMemberMarketAccess;
  if (isPublicViewer) {
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
    if (!allowGuestRequest(clientIp)) {
      return response({ ok: false, error: 'Guest market-data limit reached. Wait a minute and try again.' }, 429, origin);
    }
  }

  const keyId = Deno.env.get('ALPACA_API_KEY_ID');
  const keySecret = Deno.env.get('ALPACA_API_SECRET_KEY');
  if (!keyId || !keySecret) {
    return response({ ok: false, code: 'FEED_NOT_CONFIGURED', error: 'The shared Alpaca IEX connection is not configured. Contact a club administrator.' }, 503, origin);
  }

  let input: Record<string, unknown>;
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > maxBodyBytes) {
      return response({ ok: false, error: 'Request body is too large.' }, 413, origin);
    }
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return response({ ok: false, error: 'Request body must be a JSON object.' }, 400, origin);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return response({ ok: false, error: 'Request body must be valid JSON.' }, 400, origin);
  }

  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': keySecret };
  try {
    if (input.action === 'snapshots') {
      const rawSymbols = Array.isArray(input.symbols) ? input.symbols : [];
      const symbols = [...new Set(rawSymbols.map((symbol) => String(symbol).toUpperCase()))];
      const maxSymbols = isPublicViewer ? GUEST_MARKET_LIMITS.snapshotSymbols : 40;
      if (!symbols.length || symbols.length > maxSymbols || !symbols.every(validSymbol)) {
        return response({ ok: false, error: `Choose between 1 and ${maxSymbols} valid US stock or ETF symbols.` }, 400, origin);
      }
      if (isPublicViewer && !symbols.every(isPublicMarketSymbol)) {
        return response({ ok: false, error: 'Guest market access covers the listed stocks and ETFs in the research preview.' }, 403, origin);
      }
      const cacheKey = `snapshots:${symbols.sort().join(',')}`;
      const cached = cachedResponse(cacheKey, 15_000, origin);
      if (cached) return cached;
      const url = new URL('https://data.alpaca.markets/v2/stocks/snapshots');
      url.searchParams.set('symbols', symbols.join(','));
      url.searchParams.set('feed', 'iex');
      const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (!upstream.ok) return providerError(upstream, origin);
      const payload = await upstream.json();
      const quotes = Object.fromEntries(Object.entries(payload).flatMap(([symbol, snapshot]: [string, any]) => {
        const trade = snapshot.latestTrade || {};
        const daily = snapshot.dailyBar || {};
        const previous = snapshot.prevDailyBar || {};
        const quote = snapshot.latestQuote || {};
        const price = Number(trade.p || daily.c || 0);
        const previousClose = Number(previous.c || 0);
        const change = previousClose ? price - previousClose : 0;
        const timestamp = trade.t || daily.t || null;
        if (!Number.isFinite(price) || price <= 0 || !timestamp) return [];
        return [[symbol, {
          symbol,
          price,
          change,
          changePercent: previousClose ? (change / previousClose) * 100 : 0,
          open: Number(daily.o || 0),
          high: Number(daily.h || 0),
          low: Number(daily.l || 0),
          previousClose,
          volume: Number(daily.v || 0),
          bid: Number(quote.bp || 0),
          ask: Number(quote.ap || 0),
          timestamp,
          feed: 'iex',
        }]];
      }));
      let marketClock = null;
      try {
        const clockResponse = await fetch('https://paper-api.alpaca.markets/v2/clock', {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        if (clockResponse.ok) {
          const clock = await clockResponse.json();
          marketClock = {
            isOpen: Boolean(clock.is_open),
            timestamp: clock.timestamp || null,
            nextOpen: clock.next_open || null,
            nextClose: clock.next_close || null,
            timeZone: 'America/New_York',
          };
        }
      } catch {
        // Quote data remains useful when the optional market clock is unavailable.
      }
      return cacheResponse(cacheKey, 15_000, {
        ok: true,
        feed: 'iex',
        quotes,
        marketClock,
        receivedAt: new Date().toISOString(),
      }, origin);
    }

    if (input.action === 'bars') {
      const symbol = String(input.symbol || '').toUpperCase();
      const timeframe = String(input.timeframe || '1Day');
      const range = String(input.range || '1M');
      const requestedLimit = Math.min(Math.max(Number(input.limit) || 240, 10), 1000);
      const limit = isPublicViewer ? Math.min(requestedLimit, GUEST_MARKET_LIMITS.chartBars) : requestedLimit;
      if (!validSymbol(symbol)) return response({ ok: false, error: 'Choose a valid ticker symbol.' }, 400, origin);
      if (isPublicViewer && !isPublicMarketSymbol(symbol)) {
        return response({ ok: false, error: 'Guest market access covers the listed stocks and ETFs in the research preview.' }, 403, origin);
      }
      if (!['1Min', '5Min', '15Min', '1Hour', '1Day'].includes(timeframe)) {
        return response({ ok: false, error: 'Choose a supported chart interval.' }, 400, origin);
      }
      const lookbackDays: Record<string, number> = { '1D': 3, '1W': 10, '1M': 35, '3M': 100, '1Y': 370, '5Y': 1840 };
      if (!(range in lookbackDays)) return response({ ok: false, error: 'Choose a supported chart range.' }, 400, origin);
      const cacheKey = `bars:${symbol}:${timeframe}:${range}:${limit}`;
      const cached = cachedResponse(cacheKey, 60_000, origin);
      if (cached) return cached;
      const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set('timeframe', timeframe);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('feed', 'iex');
      // Guests are capped to one page of bars; descending upstream order ensures
      // that a long-range chart receives the most recent bars within that cap.
      url.searchParams.set('sort', isPublicViewer ? 'desc' : 'asc');
      const start = new Date(Date.now() - (lookbackDays[range] || 35) * 86_400_000);
      url.searchParams.set('start', start.toISOString());
      const maximumBars = range === '5Y' && timeframe === '1Day' && !isPublicViewer ? 1500 : limit;
      const rawBars: any[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < 3 && rawBars.length < maximumBars; page += 1) {
        const pageUrl = new URL(url);
        if (pageToken) pageUrl.searchParams.set('page_token', pageToken);
        const upstream = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(12_000) });
        if (!upstream.ok) return providerError(upstream, origin);
        const payload = await upstream.json();
        const pageBars = Array.isArray(payload.bars) ? payload.bars : [];
        rawBars.push(...pageBars);
        pageToken = typeof payload.next_page_token === 'string' && payload.next_page_token
          ? payload.next_page_token
          : null;
        if (!pageToken || !pageBars.length) break;
      }
      const selectedBars = rawBars.slice(0, maximumBars);
      if (isPublicViewer) selectedBars.reverse();
      const bars = selectedBars.map((bar: any) => ({
        time: Math.floor(new Date(bar.t).getTime() / 1000),
        open: Number(bar.o),
        high: Number(bar.h),
        low: Number(bar.l),
        close: Number(bar.c),
        volume: Number(bar.v),
      })).filter((bar: any) => Number.isFinite(bar.time) && Number.isFinite(bar.close));
      return cacheResponse(cacheKey, 60_000, {
        ok: true,
        symbol,
        timeframe,
        feed: 'iex',
        bars,
        receivedAt: new Date().toISOString(),
      }, origin);
    }

    return response({ ok: false, error: 'Unknown market-data action.' }, 400, origin);
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : 'Market data request failed.' }, 502, origin);
  }
});

async function providerError(upstream: Response, origin: string) {
  const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
  return response({ ok: false, error: `Alpaca IEX returned HTTP ${upstream.status}. Try again shortly or check feed setup.` }, status, origin);
}
