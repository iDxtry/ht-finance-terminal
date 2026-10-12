function sortedSymbols(symbols) {
  return [...symbols].sort().join(',');
}

/** @param {{ symbols: string[], unavailableSymbols?: string[], viewer: string }} options */
export function marketSnapshotCacheKey({ symbols, unavailableSymbols = [], viewer }) {
  return [
    'snapshots',
    viewer,
    sortedSymbols(symbols),
    sortedSymbols(unavailableSymbols),
  ].join(':');
}

export function marketBarsCacheKey({ symbol, timeframe, range, limit, maximumBars, viewer }) {
  return [
    'bars',
    viewer,
    symbol,
    timeframe,
    range,
    limit,
    maximumBars,
  ].join(':');
}
