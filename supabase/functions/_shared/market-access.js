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

export function maximumMarketBars(range, timeframe, defaultLimit) {
  return range === '5Y' && timeframe === '1Day' ? 1_500 : defaultLimit;
}

export async function hashMarketClientKey(clientAddress) {
  const address = typeof clientAddress === 'string' && clientAddress.trim()
    ? clientAddress.trim().slice(0, 128)
    : 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
