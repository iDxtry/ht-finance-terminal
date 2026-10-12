const CACHE_MS = 45_000;
const SNAPSHOT_BATCH_SIZE = 12;
const cache = new Map();
const inFlight = new Map();

export class MarketDataError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MarketDataError';
    this.code = options.code || 'MARKET_DATA_ERROR';
    this.cause = options.cause;
    this.retryAfterSeconds = options.retryAfterSeconds || null;
  }
}

function readCache(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.savedAt < CACHE_MS) return item.value;
  cache.delete(key);
  return null;
}

function writeCache(key, value) {
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((left, right) => left[1].savedAt - right[1].savedAt);
    for (const [expiredKey] of oldest.slice(0, cache.size - 400)) cache.delete(expiredKey);
  }
  cache.set(key, { value, savedAt: Date.now() });
  return value;
}

async function cacheScope(supabase) {
  // Keep authenticated responses separate from the public guest cache. This
  // prevents a quote for a member-only symbol from surviving sign-out.
  const publicKey = typeof supabase?.supabaseKey === 'string' ? supabase.supabaseKey : '';
  if (typeof supabase?.auth?.getSession !== 'function') {
    return { key: null, authorizationToken: publicKey };
  }
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return { key: null, authorizationToken: publicKey };
    const session = data?.session;
    const userId = session?.user?.id;
    return {
      key: userId ? `member:${userId}` : 'public',
      authorizationToken: session?.access_token || publicKey,
    };
  } catch {
    return { key: null, authorizationToken: publicKey };
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSharedIexPayload(data, request) {
  if (!isRecord(data) || data.feed !== 'iex') {
    throw new MarketDataError('The market-data service did not return verified shared Alpaca IEX data.', {
      code: 'UNTRUSTED_MARKET_DATA',
    });
  }

  if (typeof data.receivedAt !== 'string' || !Number.isFinite(Date.parse(data.receivedAt))) {
    throw new MarketDataError('The shared IEX service did not return a valid data-received timestamp.', {
      code: 'INVALID_RESPONSE',
    });
  }

  if (request.action === 'snapshots') {
    if (!isRecord(data.quotes)) {
      throw new MarketDataError('The shared IEX service returned an invalid quote response.', {
        code: 'INVALID_RESPONSE',
      });
    }
    const requested = new Set(request.symbols || []);
    for (const [symbol, quote] of Object.entries(data.quotes)) {
      const price = Number(quote?.price);
      if (!requested.has(symbol) || !isRecord(quote) || quote.feed !== 'iex' || quote.symbol !== symbol || !Number.isFinite(price) || price <= 0 || typeof quote.timestamp !== 'string' || !Number.isFinite(Date.parse(quote.timestamp))) {
        throw new MarketDataError('The shared IEX service returned an invalid quote. No substitute price was used.', {
          code: 'INVALID_RESPONSE',
        });
      }
    }
    if (data.unavailableSymbols !== undefined
      && (!Array.isArray(data.unavailableSymbols)
        || data.unavailableSymbols.some((symbol) => typeof symbol !== 'string' || !requested.has(symbol)))) {
      throw new MarketDataError('The shared IEX service returned an invalid unavailable-symbol list.', {
        code: 'INVALID_RESPONSE',
      });
    }
  } else if (request.action === 'bars') {
    if (!Array.isArray(data.bars)) {
      throw new MarketDataError('The shared IEX service returned invalid chart history.', {
        code: 'INVALID_RESPONSE',
      });
    }
    for (const bar of data.bars) {
      const values = ['time', 'open', 'high', 'low', 'close', 'volume'].map((key) => Number(bar?.[key]));
      const [time, open, high, low, close, volume] = values;
      if (!values.every(Number.isFinite) || time <= 0 || open <= 0 || close <= 0 || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) {
        throw new MarketDataError('The shared IEX service returned invalid chart data. No substitute prices were used.', {
          code: 'INVALID_RESPONSE',
        });
      }
    }
    for (let index = 1; index < data.bars.length; index += 1) {
      if (Number(data.bars[index].time) <= Number(data.bars[index - 1].time)) {
        throw new MarketDataError('The shared IEX service returned chart bars out of order.', {
          code: 'INVALID_RESPONSE',
        });
      }
    }
  }
}

async function readFunctionErrorPayload(error) {
  const response = error?.context;
  if (!response || typeof response.json !== 'function') return null;
  try {
    const copy = typeof response.clone === 'function' ? response.clone() : response;
    const payload = await copy.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function describeFunctionFailure(error, payload) {
  const status = error?.context?.status;
  if (payload?.code === 'FEED_NOT_CONFIGURED') {
    return {
      message: 'The shared Alpaca IEX connection is not configured on the server. Contact a club administrator.',
      code: 'FEED_NOT_CONFIGURED',
    };
  }
  if (status === 429) {
    return {
      message: 'The shared market-data service is busy. Wait a minute and try again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: Number(error?.context?.headers?.get?.('Retry-After')) || 60,
    };
  }

  const serverMessage = typeof payload?.error === 'string' ? payload.error : '';
  const originalMessage = typeof error?.message === 'string' ? error.message : '';
  if (/Alpaca IEX returned HTTP|feed setup/i.test(serverMessage)) {
    return {
      message: 'The shared Alpaca IEX feed is temporarily unavailable. Try again shortly or contact a club administrator.',
      code: 'MARKET_PROVIDER_UNAVAILABLE',
    };
  }
  if (/function|404|not found/i.test(`${serverMessage} ${originalMessage}`)) {
    return {
      message: 'The shared market-data service is not deployed or reachable yet. Contact a club administrator.',
      code: 'EDGE_FUNCTION_UNAVAILABLE',
    };
  }
  return {
    message: serverMessage || originalMessage || 'The shared market-data service is not responding.',
    code: 'EDGE_FUNCTION_UNAVAILABLE',
  };
}

async function requestMarketData(supabase, body, cacheKey) {
  if (!supabase?.functions?.invoke) {
    throw new MarketDataError('Market data is unavailable because the public Supabase client is not configured in this build.', {
      code: 'CLIENT_NOT_CONFIGURED',
    });
  }
  const scope = await cacheScope(supabase);
  const scopedCacheKey = scope.key ? `${scope.key}:${cacheKey}` : null;
  const cached = scopedCacheKey ? readCache(scopedCacheKey) : null;
  if (cached) return cached;

  const requestKey = scopedCacheKey ? `${scopedCacheKey}:${cacheKey}` : null;
  if (requestKey && inFlight.has(requestKey)) return inFlight.get(requestKey);

  // Supabase's project URL and public anon/publishable key are shared app
  // configuration. The Alpaca key pair stays inside the Edge Function secrets.
  // Invoking this function does not require a member login for its public IEX
  // research symbols; the server applies guest limits and origin checks.
  const pending = (async () => {
    const invoke = (token) => supabase.functions.invoke('market-data', {
      body,
      // Supabase's function client does not attach the public key as a bearer
      // token for signed-out visitors. The Edge Function requires it even
      // though gateway JWT verification is disabled. Preserve a member's JWT
      // when present so server-side market permissions still apply.
      headers: token
        ? { Authorization: `Bearer ${token}` }
        : undefined,
    });
    let result = await invoke(scope.authorizationToken);
    if (result.error
      && result.error.context?.status === 401
      && scope.authorizationToken
      && scope.authorizationToken !== supabase.supabaseKey) {
      const payload = await readFunctionErrorPayload(result.error);
      if (/session expired/i.test(payload?.error || '')) {
        // An expired member session must not make public research disappear.
        // Retry only the same request with the public key; the Edge Function
        // then applies its guest symbol allow-list and rate limit.
        result = await invoke(supabase.supabaseKey);
      }
    }
    const { data, error } = result;
    if (error) {
      const payload = await readFunctionErrorPayload(error);
      const failure = describeFunctionFailure(error, payload);
      throw new MarketDataError(failure.message, {
        cause: error,
        code: failure.code,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    }
    if (!data?.ok) {
      const failure = describeFunctionFailure({ message: data?.error }, data);
      throw new MarketDataError(failure.message, {
        cause: data,
        code: data?.code || failure.code,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    }
    assertSharedIexPayload(data, body);
    return scopedCacheKey ? writeCache(scopedCacheKey, data) : data;
  })();
  if (!requestKey) return pending;
  inFlight.set(requestKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function loadSnapshots(supabase, symbols) {
  const list = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase()))].slice(0, 40).sort();
  if (!list.length) return { feed: 'iex', quotes: {}, receivedAt: new Date().toISOString() };
  const scope = await cacheScope(supabase);
  const batches = [];
  for (let index = 0; index < list.length; index += SNAPSHOT_BATCH_SIZE) {
    batches.push(list.slice(index, index + SNAPSHOT_BATCH_SIZE));
  }
  const results = await Promise.all(batches.map((batch) => requestMarketData(
    supabase,
    { action: 'snapshots', symbols: batch },
    `snapshots:${scope.key || 'session-unknown'}:${batch.join(',')}`,
  )));
  const quotes = Object.assign({}, ...results.map((result) => result.quotes || {}));
  const unavailableSymbols = results.flatMap((result) => result.unavailableSymbols || []);
  return {
    feed: 'iex',
    quotes,
    unavailableSymbols,
    marketClock: results.find((result) => result.marketClock)?.marketClock || null,
    receivedAt: results.map((result) => result.receivedAt).sort().at(-1),
  };
}

export async function loadBars(supabase, symbol, range = '1M') {
  const normalized = String(symbol).toUpperCase();
  const timeframeByRange = { '1D': '5Min', '1W': '15Min', '1M': '1Hour', '3M': '1Day', '1Y': '1Day', '5Y': '1Day' };
  const timeframe = timeframeByRange[range] || '1Day';
  const limitByRange = { '1D': 200, '1W': 200, '1M': 240, '3M': 100, '1Y': 260, '5Y': 1000 };
  return requestMarketData(
    supabase,
    { action: 'bars', symbol: normalized, timeframe, limit: limitByRange[range] || 240, range },
    `bars:${normalized}:${range}`,
  );
}

export function clearMarketCache() {
  cache.clear();
  inFlight.clear();
}
