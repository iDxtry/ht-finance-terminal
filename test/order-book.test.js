import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrderBook } from '../src/components/order-book.js';
import { buildOrderBook } from '../src/lib/order-book.js';

test('builds a deterministic ladder with the requested depth', () => {
  const first = buildOrderBook('AAPL', 210.25, 8);
  const second = buildOrderBook('AAPL', 210.25, 8);
  assert.deepEqual(first, second);
  assert.equal(first.bids.length, 8);
  assert.equal(first.asks.length, 8);
});

test('orders bids downward and asks upward around a positive spread', () => {
  const book = buildOrderBook('SPY', 545.12, 10);
  assert.ok(book.bids[0].price < book.asks[0].price);
  assert.ok(book.spread > 0);
  for (let index = 1; index < book.bids.length; index += 1) {
    assert.ok(book.bids[index].price <= book.bids[index - 1].price);
    assert.ok(book.asks[index].price >= book.asks[index - 1].price);
  }
});

test('cumulative depth grows monotonically on each side', () => {
  const book = buildOrderBook('NVDA', 132.01, 12);
  for (const side of [book.bids, book.asks]) {
    for (let index = 1; index < side.length; index += 1) {
      assert.ok(side[index].total >= side[index - 1].total);
    }
  }
});

test('rejects marks that cannot represent a market price', () => {
  assert.throws(() => buildOrderBook('SPY', 0), /positive finite midpoint/);
  assert.throws(() => buildOrderBook('SPY', Number.NaN), /positive finite midpoint/);
});

test('labels synthetic depth against the actual IEX quote source', () => {
  const live = renderOrderBook('SPY', { price: 778.1, feed: 'iex' });
  assert.match(live, /Centered on IEX quote \$778\.10; illustrative only, not exchange liquidity/);
  assert.doesNotMatch(live, /training price/);

  const training = renderOrderBook('SPY', { price: 469.75, feed: 'training-sim' });
  assert.match(training, /Centered on training price \$469\.75/);
});
