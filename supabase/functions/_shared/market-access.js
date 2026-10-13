export const PUBLIC_MARKET_SYMBOLS = Object.freeze(new Set([
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA',
  'AVGO', 'ORCL', 'CRM', 'AMD', 'QCOM', 'JPM', 'BRK.B', 'V', 'MA', 'GS', 'WFC', 'XOM', 'CVX',
  'LLY', 'JNJ', 'UNH', 'COST', 'WMT', 'HD', 'MCD', 'NFLX', 'DIS', 'UBER', 'CAT', 'GE', 'BA',
  'NKE', 'KO', 'PEP', 'ADBE', 'INTC', 'CSCO', 'PLTR', 'PANW', 'T', 'TLT', 'IEF', 'GLD', 'SLV',
  'USO', 'XLF', 'XLK', 'XLE', 'XLV', 'SMH', 'ARKK', 'EEM', 'GLDM',
]));

export const GUEST_MARKET_LIMITS = Object.freeze({
  snapshotSymbols: 12,
  chartBars: 10_000,
  requestsPerMinute: 30,
});

export const MARKET_RANGE_LOOKBACK_DAYS = Object.freeze({
  '1D': 3,
  '1W': 10,
  '2W': 20,
  '1M': 35,
  '3M': 100,
  '6M': 200,
  '1Y': 370,
  '2Y': 740,
  // Include about 200 prior trading sessions so SMA 200 covers the full view.
  '5Y': 2_200,
  ALL: 0,
});

export function marketRangeLookbackDays(range) {
  return Object.hasOwn(MARKET_RANGE_LOOKBACK_DAYS, range)
    ? MARKET_RANGE_LOOKBACK_DAYS[range]
    : null;
}

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

export function maximumMarketBars(range, timeframe, defaultLimit) {
  if (timeframe !== '1Day') return defaultLimit;
  // Five calendar years of display plus a 200-session SMA warm-up and margin.
  if (range === '5Y') return 1_700;
  // Four Alpaca pages cover about a century of daily sessions. Results stop
  // at the provider's earliest available bar if an instrument is newer.
  return range === 'ALL' ? 40_000 : defaultLimit;
}

export async function hashMarketClientKey(clientAddress) {
  const address = typeof clientAddress === 'string' && clientAddress.trim()
    ? clientAddress.trim().slice(0, 128)
    : 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
