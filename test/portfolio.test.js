import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolio, calculateClubActivity, STARTING_CASH } from '../src/lib/portfolio.js';

test('starts a paper account with its full cash balance', () => {
  const book = calculatePortfolio([], 'intern-a');
  assert.equal(book.cash, STARTING_CASH);
  assert.equal(book.equity, STARTING_CASH);
  assert.equal(book.positions.length, 0);
});

test('marks average-cost positions and realized returns after a partial sale', () => {
  const trades = [
    { author_id: 'intern-a', symbol: 'AAPL', side: 'buy', quantity: 10, price: 100, created_at: '2026-01-01T12:00:00Z' },
    { author_id: 'intern-a', symbol: 'AAPL', side: 'buy', quantity: 10, price: 120, created_at: '2026-01-02T12:00:00Z' },
    { author_id: 'intern-a', symbol: 'AAPL', side: 'sell', quantity: 5, price: 130, created_at: '2026-01-03T12:00:00Z' },
  ];
  const book = calculatePortfolio(trades, 'intern-a', new Map([['AAPL', { price: 125 }]]));
  assert.equal(book.cash, 98_450);
  assert.equal(book.positions[0].shares, 15);
  assert.equal(book.positions[0].averageCost, 110);
  assert.equal(book.positions[0].marketValue, 1_875);
  assert.equal(book.realizedPnl, 100);
  assert.equal(book.unrealizedPnl, 225);
  assert.equal(book.equity, 100_325);
});

test('does not include another member’s fills in a personal account', () => {
  const trades = [
    { author_id: 'intern-a', symbol: 'AAPL', side: 'buy', quantity: 1, price: 100, created_at: '2026-01-01T12:00:00Z' },
    { author_id: 'intern-b', symbol: 'NVDA', side: 'buy', quantity: 1, price: 100, created_at: '2026-01-01T13:00:00Z' },
  ];
  const book = calculatePortfolio(trades, 'intern-a');
  assert.equal(book.ledgerCount, 1);
  assert.equal(book.positions[0].symbol, 'AAPL');
});

test('an absent or invalid quote never becomes a live mark or complete portfolio valuation', () => {
  const trades = [
    { author_id: 'intern-a', symbol: 'ABC', side: 'buy', quantity: 5, price: 20, created_at: '2026-01-01T12:00:00Z' },
  ];

  for (const quotes of [new Map(), { ABC: { price: 0, last: 'not-a-price' } }]) {
    const book = calculatePortfolio(trades, 'intern-a', quotes);
    assert.equal(book.cash, 99_900);
    assert.equal(book.costBasis, 100);
    assert.equal(book.positions[0].averageCost, 20);
    assert.equal(book.positions[0].mark, null);
    assert.equal(book.positions[0].marketValue, null);
    assert.equal(book.positions[0].unrealizedPnl, null);
    assert.equal(book.positions[0].quoteAvailable, false);
    assert.deepEqual(book.unpricedSymbols, ['ABC']);
    assert.equal(book.valuationComplete, false);
    assert.equal(book.marketValue, null);
    assert.equal(book.equity, null);
    assert.equal(book.unrealizedPnl, null);
    assert.equal(book.totalPnl, null);
    assert.equal(book.returnPercent, null);
  }
});

test('reports a cash-only portfolio as fully valued without requiring a quote', () => {
  const book = calculatePortfolio([], 'intern-a');
  assert.equal(book.valuationComplete, true);
  assert.deepEqual(book.unpricedSymbols, []);
  assert.equal(book.marketValue, 0);
  assert.equal(book.equity, STARTING_CASH);
});

test('club activity ranks fill size while keeping buy and sell counts separate', () => {
  const rows = calculateClubActivity([
    { author_id: 'intern-a', side: 'buy', quantity: 5, price: 10 },
    { author_id: 'intern-a', side: 'sell', quantity: 2, price: 12 },
    { author_id: 'intern-b', side: 'buy', quantity: 1, price: 15 },
  ], (id) => id);
  assert.equal(rows[0].userId, 'intern-a');
  assert.equal(rows[0].notional, 74);
  assert.equal(rows[0].buys, 1);
  assert.equal(rows[0].sells, 1);
});
