export const PUBLIC_MARKET_SYMBOLS = Object.freeze(new Set([
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA',
  'AVGO', 'ORCL', 'CRM', 'AMD', 'QCOM', 'JPM', 'BRK.B', 'V', 'MA', 'GS', 'WFC', 'XOM', 'CVX',
  'LLY', 'JNJ', 'UNH', 'COST', 'WMT', 'HD', 'MCD', 'NFLX', 'DIS', 'UBER', 'CAT', 'GE', 'BA',
  'NKE', 'KO', 'PEP', 'ADBE', 'INTC', 'CSCO', 'PLTR', 'PANW', 'T', 'TLT', 'IEF', 'GLD', 'SLV',
  'USO', 'XLF', 'XLK', 'XLE', 'XLV', 'SMH', 'ARKK', 'EEM', 'GLDM',
]));

export const GUEST_MARKET_LIMITS = Object.freeze({
  snapshotSymbols: 12,
  chartBars: 1_000,
  requestsPerMinute: 30,
});

export function isPublicMarketSymbol(value) {
  return typeof value === 'string' && PUBLIC_MARKET_SYMBOLS.has(value.toUpperCase());
}

export function isPublicSupabaseToken(token, acceptedKeys) {
  return typeof token === 'string' && acceptedKeys.has(token);
}

export function getSupabaseClientKeys(anonKey, publishableKeysValue = '') {
  const keys = new Set(typeof anonKey === 'string' && anonKey ? [anonKey] : []);
  try {
    const publishableKeys = typeof publishableKeysValue === 'string'
      ? JSON.parse(publishableKeysValue || '{}')
      : publishableKeysValue;
    if (typeof publishableKeys === 'object' && publishableKeys !== null && !Array.isArray(publishableKeys)) {
      for (const key of Object.values(publishableKeys)) {
        if (typeof key === 'string' && key) keys.add(key);
      }
    }
  } catch {
    // Keep the legacy anon key available if the newer key map is absent or malformed.
  }
  return keys;
}

export function selectMarketBars(rawBars, maximumBars, newestFirst = false) {
  const selected = Array.isArray(rawBars) ? rawBars.slice(0, maximumBars) : [];
  return newestFirst ? selected.reverse() : selected;
}

export function createGuestRateLimiter({ maxRequests = GUEST_MARKET_LIMITS.requestsPerMinute, windowMs = 60_000 } = {}) {
  const requests = new Map();
  return (key, now = Date.now()) => {
    const bucketKey = key || 'unknown';
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const current = requests.get(bucketKey);
    if (!current || current.windowStart !== windowStart) {
      requests.set(bucketKey, { windowStart, count: 1 });
      if (requests.size > 10_000) {
        for (const [entryKey, entry] of requests) {
          if (entry.windowStart + windowMs <= now) requests.delete(entryKey);
        }
      }
      return true;
    }
    if (current.count >= maxRequests) return false;
    current.count += 1;
    return true;
  };
}
