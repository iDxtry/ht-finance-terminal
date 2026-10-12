import { formatMoney, formatNumber, escapeHtml as h } from '../lib/format.js';
import { buildOrderBook } from '../lib/order-book.js';

const VISIBLE_LEVELS = 8;

export function renderOrderBook(symbol, quote) {
  if (!quote || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) {
    return `<section class="panel orderbook-panel"><div class="panel-heading"><div><div class="eyebrow">MARKET DEPTH</div><h2>Depth ladder</h2></div></div><div class="table-empty"><b>No mark to anchor the model.</b><span>Load a quote before viewing the illustrative ladder.</span></div></section>`;
  }

  const book = buildOrderBook(symbol, quote.price, 12);
  const asks = book.asks.slice(0, VISIBLE_LEVELS).reverse();
  const bids = book.bids.slice(0, VISIBLE_LEVELS);
  const usesIexQuote = quote.feed === 'iex' || quote.source === 'iex';
  const maxTotal = Math.max(book.asks.at(-1)?.total || 1, book.bids.at(-1)?.total || 1);
  const rows = (levels, side) => levels.map((level) => {
    const width = Math.min(100, (level.total / maxTotal) * 100).toFixed(1);
    return `<div class="depth-row ${side}" style="--depth-width:${width}%" role="row" aria-label="${side === 'ask' ? 'Ask' : 'Bid'} ${formatMoney(level.price)}, size ${formatNumber(level.size, 0)}, cumulative ${formatNumber(level.total, 0)}">
      <span class="depth-price">${formatMoney(level.price)}</span><span>${formatNumber(level.size, 0)}</span><span class="depth-total">${formatNumber(level.total, 0)}</span>
    </div>`;
  }).join('');

  return `<section class="panel orderbook-panel" aria-label="Illustrative market depth for ${h(symbol)}">
    <div class="panel-heading"><div><div class="eyebrow">${h(symbol)} / MARKET DEPTH</div><h2>Depth ladder</h2></div><span class="source-label source-neutral">MODEL</span></div>
    <div class="depth-warning"><b>SYNTHETIC DEPTH</b><span>Generated levels and sizes · not exchange bids or offers.</span></div>
    <div class="depth-columns" role="row"><span>Price</span><span>Size</span><span>Total</span></div>
    <div class="depth-levels" role="table" aria-label="Generated ask levels">${rows(asks, 'ask')}</div>
    <div class="depth-mid"><span>MODEL MID</span><b>${formatMoney(book.midPrice)}</b><span>SPREAD ${formatMoney(book.spread)}</span></div>
    <div class="depth-levels" role="table" aria-label="Generated bid levels">${rows(bids, 'bid')}</div>
    <div class="depth-caption">Centered on ${usesIexQuote ? 'IEX quote' : 'training price'} ${formatMoney(quote.price)}; illustrative only, not exchange liquidity.</div>
  </section>`;
}
