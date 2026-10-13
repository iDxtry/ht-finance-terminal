import { CandlestickSeries, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';
import { formatMoney, formatTime } from '../lib/format.js';
import { clampMarketChartLogicalRange, shouldExpandMarketChartRange } from '../lib/market-ranges.js';

export function mountPriceChart(container, bars, options = {}) {
  if (!container) return () => {};
  container.replaceChildren();
  if (!bars?.length) {
    container.innerHTML = options.loading
      ? '<div class="chart-loading" role="status" aria-live="polite"><span>Loading verified IEX history</span><div class="chart-loading-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>'
      : '<div class="chart-empty"><span class="chart-empty-mark">CHART</span><b>No bars available</b><small>Try another range or verify the market-data connection.</small></div>';
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
      timeVisible: ['1D', '1W', '2W'].includes(options.range),
      secondsVisible: false,
      rightOffset: ['5Y', 'ALL'].includes(options.range) ? 0 : 5,
      fixLeftEdge: options.range === 'ALL',
      fixRightEdge: options.range === 'ALL',
    },
    localization: { priceFormatter: (price) => formatMoney(price, { digits: price < 2 ? 4 : 2 }) },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  const history = chartHistoryForRange(bars, options.range);
  const candles = history.visibleBars;
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
  let movingAverage200 = null;
  if (options.showSma20) {
    movingAverage20 = chart.addSeries(LineSeries, {
      color: '#e3b45c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    movingAverage20.setData(chartMovingAverage(history, 20));
  }
  if (options.showSma50) {
    movingAverage50 = chart.addSeries(LineSeries, {
      color: '#78a8d1', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    movingAverage50.setData(chartMovingAverage(history, 50));
  }
  if (options.showSma200) {
    movingAverage200 = chart.addSeries(LineSeries, {
      color: '#bd8bd3', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    movingAverage200.setData(chartMovingAverage(history, 200));
  }

  const timeScale = chart.timeScale();
  timeScale.fitContent();
  let disposed = false;
  let rangeExpansionRequested = false;
  let rangeClampRequested = false;
  const onVisibleRangeChange = (logicalRange) => {
    if (rangeClampRequested) return;
    if (options.range === 'ALL') {
      const boundedRange = clampMarketChartLogicalRange(logicalRange, candles.length);
      if (boundedRange) {
        rangeClampRequested = true;
        try {
          timeScale.setVisibleLogicalRange(boundedRange);
        } finally {
          rangeClampRequested = false;
        }
        return;
      }
    }
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

export function chartHistoryForRange(bars, range) {
  const calculationBars = bars.map(normalizeBar).filter(Boolean).sort((left, right) => left.time - right.time);
  if (range !== '5Y' || calculationBars.length === 0) {
    return { calculationBars, visibleBars: calculationBars, visibleFrom: null };
  }

  const latest = chartDate(calculationBars.at(-1).time);
  const month = latest.getUTCMonth();
  const day = latest.getUTCDate();
  const year = latest.getUTCFullYear() - 5;
  const visibleFromDate = new Date(latest);
  visibleFromDate.setUTCDate(1);
  visibleFromDate.setUTCFullYear(year);
  visibleFromDate.setUTCMonth(month);
  visibleFromDate.setUTCDate(Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
  const visibleFrom = Math.floor(visibleFromDate.getTime() / 1000);

  return {
    calculationBars,
    visibleBars: calculationBars.filter((bar) => bar.time >= visibleFrom),
    visibleFrom,
  };
}

function chartMovingAverage(history, period) {
  return movingAverage(history.calculationBars, period)
    .filter((point) => history.visibleFrom === null || point.time >= history.visibleFrom);
}

export function movingAverage(bars, period) {
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
