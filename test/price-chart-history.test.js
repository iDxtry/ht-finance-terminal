import assert from 'node:assert/strict';
import test from 'node:test';
import { chartHistoryForRange, movingAverage } from '../src/components/price-chart.js';

function weekdayBars(count, latestDate = new Date('2026-10-12T00:00:00Z')) {
  const bars = [];
  const date = new Date(latestDate);
  while (bars.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      const close = bars.length + 1;
      bars.push({
        time: Math.floor(date.getTime() / 1000),
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
      });
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return bars.reverse();
}

test('five-year chart uses warm-up history for SMA 200 without showing the warm-up bars', () => {
  const source = weekdayBars(1_700);
  const history = chartHistoryForRange(source, '5Y');
  const firstVisibleIndex = history.calculationBars.findIndex((bar) => bar.time >= history.visibleFrom);
  const movingAverage200 = movingAverage(history.calculationBars, 200)
    .filter((point) => point.time >= history.visibleFrom);

  assert.ok(history.calculationBars[0].time < history.visibleFrom);
  assert.ok(firstVisibleIndex >= 200);
  assert.equal(history.visibleBars[0].time, history.calculationBars[firstVisibleIndex].time);
  assert.equal(movingAverage200[0].time, history.visibleBars[0].time);
  assert.equal(movingAverage200[0].value,
    history.calculationBars.slice(firstVisibleIndex - 199, firstVisibleIndex + 1)
      .reduce((sum, bar) => sum + bar.close, 0) / 200);
  assert.equal(history.visibleBars.at(-1).time, source.at(-1).time);
});

test('shorter chart ranges retain their requested bars', () => {
  const source = weekdayBars(300);
  const history = chartHistoryForRange(source, '1Y');

  assert.equal(history.visibleFrom, null);
  assert.equal(history.visibleBars.length, source.length);
  assert.equal(history.calculationBars.length, source.length);
});
