import { STARTING_CASH } from './portfolio.js';

const SHARE_EPSILON = 1e-8;
const TRADING_DAYS_PER_YEAR = 252;

function dayKey(value) {
  const validDay = (day) => {
    const milliseconds = Date.parse(`${day}T00:00:00.000Z`);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === day;
  };
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
    if (match) return validDay(match[1]) ? match[1] : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function dayEndTimestamp(day) {
  return Date.parse(`${day}T23:59:59.999Z`);
}

function normalizeBars(bars) {
  const normalized = (bars || [])
    .map((bar) => {
      const day = dayKey(bar?.date ?? bar?.day ?? bar?.timestamp ?? bar?.time);
      const close = Number(bar?.close);
      return day && Number.isFinite(close) && close > 0 ? { day, close } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.day.localeCompare(right.day));
  // A daily series must have at most one close per session. If a provider
  // returns duplicates, use the final value in its response deterministically.
  const byDay = new Map();
  for (const bar of normalized) byDay.set(bar.day, bar);
  return [...byDay.values()];
}

function entriesOfBarsBySymbol(priceBarsBySymbol) {
  if (priceBarsBySymbol instanceof Map) return [...priceBarsBySymbol.entries()];
  return Object.entries(priceBarsBySymbol || {});
}

function normalizeFill(fill, index) {
  const timestampValue = fill?.created_at ?? fill?.executed_at ?? fill?.timestamp;
  const timestamp = new Date(timestampValue).getTime();
  const side = String(fill?.side || '').toLowerCase();
  const symbol = String(fill?.symbol || '').trim().toUpperCase();
  const quantity = Number(fill?.quantity);
  const price = Number(fill?.price);
  if (!Number.isFinite(timestamp) || !symbol || !['buy', 'sell'].includes(side)) return null;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return null;
  return { timestamp, side, symbol, quantity, price, index };
}

function calculateRiskMetrics(points, equityKey, startingValue = STARTING_CASH) {
  const measured = points.map((point) => point[equityKey]);
  if (!measured.length || measured.some((value) => !Number.isFinite(value))) {
    return {
      cumulativeReturnPercent: null,
      maxDrawdownPercent: null,
      annualizedVolatilityPercent: null,
      sharpeRatio: null,
    };
  }
  const values = measured;

  let peak = startingValue;
  let maxDrawdown = 0;
  for (const equity of values) {
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const dailyReturns = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1][equityKey];
    const current = points[index][equityKey];
    if (Number.isFinite(previous) && previous > 0 && Number.isFinite(current)) {
      dailyReturns.push((current - previous) / previous);
    }
  }

  let annualizedVolatilityPercent = null;
  let sharpeRatio = null;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
    const sampleVariance = dailyReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (dailyReturns.length - 1);
    const dailyVolatility = Math.sqrt(sampleVariance);
    annualizedVolatilityPercent = dailyVolatility * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
    if (dailyVolatility > 0) sharpeRatio = (mean / dailyVolatility) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  return {
    cumulativeReturnPercent: ((values.at(-1) / startingValue) - 1) * 100,
    maxDrawdownPercent: maxDrawdown * 100,
    annualizedVolatilityPercent,
    sharpeRatio,
  };
}

/**
 * Build a daily marked-equity series for one paper-trading account.
 *
 * Dates are calendar days encoded by daily-bar `date`, `day`, or timestamp fields.
 * Each point is valued at 23:59:59.999 UTC for that date, so only fills at or
 * before that end-of-day cutoff are included. A position without a close for
 * that exact session makes that day's portfolio equity unavailable (`null`)
 * rather than carrying a stale close or using cost basis as a fabricated mark.
 * Fill-only dates are retained and remain unpriced when no same-session bar
 * exists. `startDate` filters output dates; fills before it are still replayed
 * to establish the account's positions and cash.
 */
export function buildPortfolioHistory({
  trades = [],
  userId,
  priceBarsBySymbol = {},
  benchmarkBars = [],
  startDate,
} = {}) {
  const fills = (trades || [])
    .filter((trade) => trade?.author_id === userId)
    .map(normalizeFill)
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);

  const fillSymbols = new Set(fills.map((fill) => fill.symbol));
  const barsBySymbol = new Map();
  for (const [rawSymbol, bars] of entriesOfBarsBySymbol(priceBarsBySymbol)) {
    const symbol = String(rawSymbol || '').trim().toUpperCase();
    if (symbol && fillSymbols.has(symbol)) barsBySymbol.set(symbol, normalizeBars(bars));
  }

  const spyBars = normalizeBars(benchmarkBars);
  const days = new Set(spyBars.map((bar) => bar.day));
  for (const bars of barsBySymbol.values()) for (const bar of bars) days.add(bar.day);
  for (const fill of fills) {
    const day = new Date(fill.timestamp).toISOString().slice(0, 10);
    days.add(day);
  }
  const firstOutputDay = startDate ? dayKey(startDate) : null;
  const outputDays = [...days]
    .filter((day) => !firstOutputDay || day >= firstOutputDay)
    .sort();

  const positions = new Map();
  const closesBySymbolAndDay = new Map([...barsBySymbol].map(([symbol, bars]) => [
    symbol,
    new Map(bars.map((bar) => [bar.day, bar.close])),
  ]));
  const spyCloseByDay = new Map(spyBars.map((bar) => [bar.day, bar.close]));
  const fillsByDayOrder = fills;
  let fillCursor = 0;
  let cash = STARTING_CASH;
  let realizedPnl = 0;
  let spyShares = null;
  let portfolioStartingValue = STARTING_CASH;
  let benchmarkStartingValue = STARTING_CASH;
  let metricStartIndex = 0;
  const points = [];

  for (const day of outputDays) {
    const cutoff = dayEndTimestamp(day);

    while (fillCursor < fillsByDayOrder.length && fillsByDayOrder[fillCursor].timestamp <= cutoff) {
      const fill = fillsByDayOrder[fillCursor++];
      const position = positions.get(fill.symbol) || { symbol: fill.symbol, shares: 0, costBasis: 0 };
      if (fill.side === 'buy') {
        cash -= fill.quantity * fill.price;
        position.shares += fill.quantity;
        position.costBasis += fill.quantity * fill.price;
      } else if (position.shares > SHARE_EPSILON) {
        const sold = Math.min(fill.quantity, position.shares);
        const averageCost = position.costBasis / position.shares;
        const removedBasis = sold * averageCost;
        cash += sold * fill.price;
        realizedPnl += sold * fill.price - removedBasis;
        position.shares -= sold;
        position.costBasis = Math.max(0, position.costBasis - removedBasis);
      }
      if (position.shares <= SHARE_EPSILON) {
        position.shares = 0;
        position.costBasis = 0;
      }
      positions.set(fill.symbol, position);
    }

    const spyClose = spyCloseByDay.get(day);
    const activePositions = [...positions.values()].filter((position) => position.shares > SHARE_EPSILON);
    let marketValue = 0;
    const unpricedSymbols = [];
    const markedPositions = activePositions.map((position) => {
      const close = closesBySymbolAndDay.get(position.symbol)?.get(day);
      if (!Number.isFinite(close)) {
        unpricedSymbols.push(position.symbol);
        return { ...position, close: null, marketValue: null };
      }
      const positionMarketValue = position.shares * close;
      marketValue += positionMarketValue;
      return { ...position, close, marketValue: positionMarketValue };
    });
    const fullyPriced = unpricedSymbols.length === 0;
    const equity = fullyPriced ? cash + marketValue : null;
    if (spyShares === null && Number.isFinite(spyClose) && Number.isFinite(equity)) {
      const baseline = equity;
      spyShares = baseline / spyClose;
      portfolioStartingValue = baseline;
      benchmarkStartingValue = baseline;
      metricStartIndex = points.length;
    }
    // Do not carry an old SPY close forward onto a session with no benchmark
    // bar. A missing date is unknown, not a zero-return observation.
    const benchmarkEquity = spyShares === null || !Number.isFinite(spyClose) ? null : spyShares * spyClose;

    points.push({
      date: day,
      timestamp: new Date(cutoff).toISOString(),
      cash,
      marketValue: fullyPriced ? marketValue : null,
      equity,
      returnPercent: null,
      realizedPnl,
      positions: markedPositions,
      unpricedSymbols,
      benchmarkEquity,
      benchmarkReturnPercent: null,
    });
  }

  for (const [index, point] of points.entries()) {
    point.returnPercent = index >= metricStartIndex && Number.isFinite(point.equity)
      ? ((point.equity / portfolioStartingValue) - 1) * 100
      : null;
    point.benchmarkReturnPercent = index >= metricStartIndex && Number.isFinite(point.benchmarkEquity)
      ? ((point.benchmarkEquity / benchmarkStartingValue) - 1) * 100
      : null;
  }

  const metricPoints = points.slice(metricStartIndex);

  return {
    userId,
    startingCash: STARTING_CASH,
    comparisonStartDate: points[metricStartIndex]?.date || null,
    periodStart: firstOutputDay,
    portfolioStartingValue,
    benchmarkStartingValue,
    points,
    metrics: calculateRiskMetrics(metricPoints, 'equity', portfolioStartingValue),
    benchmarkMetrics: calculateRiskMetrics(metricPoints, 'benchmarkEquity', benchmarkStartingValue),
  };
}
