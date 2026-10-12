export const STARTING_CASH = 100_000;

/** Derive cash, average-cost basis and marked value from the immutable paper-trade ledger. */
export function calculatePortfolio(trades, userId, quotes = new Map()) {
  const ledger = (trades || [])
    .filter((trade) => trade.author_id === userId)
    .slice()
    .sort((left, right) => new Date(left.created_at) - new Date(right.created_at));
  let cash = STARTING_CASH;
  let realizedPnl = 0;
  const positions = new Map();

  for (const trade of ledger) {
    const quantity = Number(trade.quantity);
    const price = Number(trade.price);
    if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity <= 0 || price <= 0) continue;
    const symbol = String(trade.symbol).toUpperCase();
    const position = positions.get(symbol) || { symbol, shares: 0, costBasis: 0, realizedPnl: 0 };

    if (trade.side === 'buy') {
      cash -= quantity * price;
      position.shares += quantity;
      position.costBasis += quantity * price;
    } else if (trade.side === 'sell' && position.shares > 0) {
      const sold = Math.min(quantity, position.shares);
      const averageCost = position.costBasis / position.shares;
      const removedBasis = sold * averageCost;
      const profit = sold * price - removedBasis;
      cash += sold * price;
      position.shares -= sold;
      position.costBasis = Math.max(0, position.costBasis - removedBasis);
      position.realizedPnl += profit;
      realizedPnl += profit;
    }
    positions.set(symbol, position);
  }

  const rows = [...positions.values()]
    .filter((position) => position.shares > 1e-8)
    .map((position) => {
      const quote = quotes instanceof Map ? quotes.get(position.symbol) : quotes?.[position.symbol];
      const mark = [quote?.price, quote?.last]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value) && value > 0) ?? null;
      const quoteAvailable = mark !== null;
      const marketValue = quoteAvailable ? position.shares * mark : null;
      return {
        ...position,
        averageCost: position.costBasis / position.shares,
        mark,
        markSource: quoteAvailable ? 'quote' : null,
        marketValue,
        unrealizedPnl: quoteAvailable ? marketValue - position.costBasis : null,
        changePercent: quoteAvailable && position.costBasis ? ((marketValue - position.costBasis) / position.costBasis) * 100 : null,
        quoteAvailable,
      };
    })
    .sort((left, right) => {
      if (left.marketValue === null) return right.marketValue === null ? 0 : 1;
      if (right.marketValue === null) return -1;
      return right.marketValue - left.marketValue;
    });

  const costBasis = rows.reduce((sum, position) => sum + position.costBasis, 0);
  const unpricedSymbols = rows.filter((position) => !position.quoteAvailable).map((position) => position.symbol);
  const valuationComplete = unpricedSymbols.length === 0;
  const marketValue = valuationComplete ? rows.reduce((sum, position) => sum + position.marketValue, 0) : null;
  const unrealizedPnl = valuationComplete ? marketValue - costBasis : null;
  const equity = valuationComplete ? cash + marketValue : null;
  return {
    cash,
    positions: rows,
    costBasis,
    marketValue,
    equity,
    realizedPnl,
    unrealizedPnl,
    totalPnl: valuationComplete ? realizedPnl + unrealizedPnl : null,
    returnPercent: valuationComplete ? ((equity - STARTING_CASH) / STARTING_CASH) * 100 : null,
    valuationComplete,
    unpricedSymbols,
    ledgerCount: ledger.length,
  };
}

export function calculateClubActivity(trades, getMemberName) {
  const members = new Map();
  for (const trade of trades || []) {
    const value = Number(trade.quantity) * Number(trade.price);
    const activity = members.get(trade.author_id) || { userId: trade.author_id, count: 0, notional: 0, buys: 0, sells: 0 };
    activity.count += 1;
    activity.notional += Number.isFinite(value) ? value : 0;
    activity[trade.side === 'buy' ? 'buys' : 'sells'] += 1;
    members.set(trade.author_id, activity);
  }
  return [...members.values()]
    .map((member) => ({ ...member, name: getMemberName(member.userId) }))
    .sort((left, right) => right.notional - left.notional);
}
