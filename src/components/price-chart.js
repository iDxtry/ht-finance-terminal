import { CandlestickSeries, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';
import { formatMoney, formatTime } from '../lib/format.js';
import { shouldExpandMarketChartRange } from '../lib/market-ranges.js';

export function mountPriceChart(container, bars, options = {}) {
  if (!container) return () => {};
  container.replaceChildren();
  if (!bars?.length) {
    container.innerHTML = '<div class="chart-empty"><span class="chart-empty-mark">CHART</span><b>No bars available</b><small>Try another range or verify the market-data connection.</small></div>';
    return () => {};
  }

  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: '#101315' },
      textColor: '#8e979c',
      fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
      fontSize: 10,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: '#1d2428' },
      horzLines: { color: '#1d2428' },
    },
    crosshair: { mode: 1, vertLine: { color: '#8c9ba4', labelBackgroundColor: '#38434a' }, horzLine: { color: '#8c9ba4', labelBackgroundColor: '#38434a' } },
    rightPriceScale: { borderColor: '#273036', scaleMargins: { top: 0.08, bottom: 0.27 } },
    timeScale: {
      borderColor: '#273036',
      timeVisible: options.range === '1D' || options.range === '1W',
      secondsVisible: false,
      rightOffset: options.range === '5Y' ? 0 : 5,
      fixLeftEdge: options.range === '5Y',
      fixRightEdge: options.range === '5Y',
    },
    localization: { priceFormatter: (price) => formatMoney(price, { digits: price < 2 ? 4 : 2 }) },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  const candles = bars.map(normalizeBar).filter(Boolean);
  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#48c6a1',
    downColor: '#ef7568',
    borderUpColor: '#48c6a1',
    borderDownColor: '#ef7568',
    wickUpColor: '#48c6a1',
    wickDownColor: '#ef7568',
  });
  candleSeries.setData(candles);

  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    color: '#456373',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0.01 }, borderVisible: false });
  volumeSeries.setData(candles.filter((bar) => Number.isFinite(bar.volume) && bar.volume >= 0).map((bar) => ({
    time: bar.time,
    value: bar.volume,
    color: bar.close >= bar.open ? '#48c6a144' : '#ef756844',
  })));

  let movingAverage20 = null;
  let movingAverage50 = null;
  if (options.showSma20) {
    movingAverage20 = chart.addSeries(LineSeries, {
      color: '#e3b45c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    movingAverage20.setData(movingAverage(candles, 20));
  }
  if (options.showSma50) {
    movingAverage50 = chart.addSeries(LineSeries, {
      color: '#78a8d1', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    movingAverage50.setData(movingAverage(candles, 50));
  }

  const timeScale = chart.timeScale();
  timeScale.fitContent();
  let disposed = false;
  let rangeExpansionRequested = false;
  const onVisibleRangeChange = (logicalRange) => {
    if (rangeExpansionRequested || !shouldExpandMarketChartRange(logicalRange, candles.length, options.range)) return;
    if (typeof options.onRangeExpand !== 'function') {
      timeScale.fitContent();
      return;
    }

    rangeExpansionRequested = true;
    Promise.resolve(options.onRangeExpand()).then((expanded) => {
      if (disposed || expanded) return;
      rangeExpansionRequested = false;
      timeScale.fitContent();
    }).catch(() => {
      if (disposed) return;
      rangeExpansionRequested = false;
      timeScale.fitContent();
    });
  };
  timeScale.subscribeVisibleLogicalRangeChange(onVisibleRangeChange);
  const onCrosshairMove = (event) => {
    const point = event.seriesData.get(candleSeries);
    const target = options.readout;
    if (!target) return;
    if (!point || !event.time) {
      target.textContent = options.quote?.price != null ? formatMoney(options.quote.price) : '—';
      return;
    }
    const value = `${formatTime(chartDate(event.time), { dateOnly: true })}  O ${formatMoney(point.open)}  H ${formatMoney(point.high)}  L ${formatMoney(point.low)}  C ${formatMoney(point.close)}`;
    target.textContent = value;
  };
  chart.subscribeCrosshairMove(onCrosshairMove);

  const resizeObserver = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    if (width > 0 && height > 0) chart.resize(width, height);
  });
  resizeObserver.observe(container);

  return () => {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    timeScale.unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange);
    chart.unsubscribeCrosshairMove(onCrosshairMove);
    chart.remove();
  };
}

function chartDate(value) {
  if (typeof value === 'number') return new Date(value * 1000);
  if (typeof value === 'string') return new Date(value);
  if (value && typeof value === 'object' && 'year' in value) return new Date(Date.UTC(value.year, value.month - 1, value.day));
  return new Date(NaN);
}

function normalizeBar(bar) {
  const time = Number(bar.time ?? bar.t);
  const normalizedTime = time > 10_000_000_000 ? Math.floor(time / 1000) : Math.floor(time);
  const open = Number(bar.open ?? bar.o);
  const high = Number(bar.high ?? bar.h);
  const low = Number(bar.low ?? bar.l);
  const close = Number(bar.close ?? bar.c);
  if (![normalizedTime, open, high, low, close].every(Number.isFinite)) return null;
  const volumeValue = bar.volume ?? bar.v;
  const volume = volumeValue == null || volumeValue === '' ? null : Number(volumeValue);
  return { time: normalizedTime, open, high, low, close, volume: Number.isFinite(volume) && volume >= 0 ? volume : null };
}

function movingAverage(bars, period) {
  const points = [];
  let sum = 0;
  bars.forEach((bar, index) => {
    sum += bar.close;
    if (index >= period) sum -= bars[index - period].close;
    if (index >= period - 1) points.push({ time: bar.time, value: sum / period });
  });
  return points;
}

export function chartLegend(quote, bars) {
  const last = bars?.at(-1);
  return {
    // Historical closes must not be presented as the current quote when the
    // snapshot endpoint is unavailable.
    price: quote?.price ?? null,
    open: last?.open ?? null,
    high: last?.high ?? quote?.high ?? null,
    low: last?.low ?? quote?.low ?? null,
    volume: last?.volume ?? quote?.volume ?? null,
    asOf: quote?.timestamp || null,
    feed: quote?.feed || 'unavailable',
  };
}
