import test from 'node:test';
import assert from 'node:assert/strict';
import { renderApplication } from '../src/views/terminal-pages.js';

function baseState({ route = 'proposals', role = 'intern', permissions = ['proposals.create'], proposals = [] } = {}) {
  return {
    route,
    role,
    user: { id: 'u-1', email: 'student@example.edu', user_metadata: { full_name: 'Student Member' } },
    permissions,
    proposalFilter: 'all',
    proposals,
    proposalReviews: [],
    quantAnalyses: [],
    trades: [],
    members: [],
    portfolioMembers: [],
    adminMembers: [],
    adminTeams: [],
    auditLog: [],
    watchlist: [],
    symbol: 'SPY',
    chartRange: '1M',
    market: { source: 'unavailable', quotes: new Map(), bars: [], asOf: null },
    clock: '15:31',
  };
}

const proposal = (id, status) => ({
  id,
  status,
  symbol: 'SPY',
  side: 'buy',
  quantity: 2,
  thesis: 'The thesis includes a clear catalyst and expected market reaction.',
  risks: 'The thesis fails if earnings guidance weakens.',
  created_at: '2026-10-12T12:00:00Z',
  entry_price: 600,
  target_price: 630,
  stop_loss: 575,
  time_horizon: 'swing',
  author_id: 'u-1',
});

test('manager proposal queue consolidates review and fill actions without a separate desk', () => {
  const state = baseState({
    role: 'manager',
    permissions: ['proposals.read_all', 'proposals.review', 'paper_trades.execute'],
    proposals: [proposal('p-pending', 'pending'), proposal('p-approved', 'approved')],
  });
  const html = renderApplication(state);

  assert.match(html, /href="#proposals"[^>]*>[\s\S]*?Proposals/);
  assert.match(html, /Needs review/);
  assert.match(html, /Approved \/ unfilled/);
  assert.match(html, /data-form="proposal-review"/);
  assert.match(html, /data-form="execute"/);
  assert.doesNotMatch(html, /Manager desk|MEMBER PARTICIPATION \/ NOT RETURNS|NOTIONAL IS PAPER FILL SIZE/);
  assert.doesNotMatch(html, /href="#manager"/);
});

test('Owner sees one People & Teams destination for group and member administration', () => {
  const state = baseState({ route: 'admin', role: 'owner', permissions: ['members.manage'] });
  state.adminTeams = [{ team_code: 'GROUP-1', team_name: 'Group #1', description: '', active: true, member_count: 2, manager_ids: ['u-manager'] }];
  state.adminMembers = [
    { user_id: 'u-manager', email: 'manager@example.edu', full_name: 'Group Manager', active: true, role: 'manager', team: null },
    { user_id: 'u-intern', email: 'intern@example.edu', full_name: 'Group Intern', active: true, role: 'intern', team: 'GROUP-1' },
  ];
  const html = renderApplication(state);

  assert.match(html, /href="#admin"[^>]*>[\s\S]*?People & Teams/);
  assert.match(html, /People & Teams/);
  assert.match(html, /Group #1/);
  assert.match(html, /manager@example\.edu/);
  assert.match(html, /intern@example\.edu/);
  assert.match(html, /data-form="team-managers"/);
  assert.match(html, /data-form="member-team"/);
  assert.doesNotMatch(html, /Users & Permissions|Feed setup|href="#setup"|Manager desk/);
});

test('Intern navigation hides Owner and Quant administration', () => {
  const html = renderApplication(baseState());
  assert.doesNotMatch(html, /href="#admin"|People & Teams|href="#quant"/);
  assert.match(html, /href="#proposals"/);
});

test('signed-out market view renders received IEX quotes and keeps the feed label explicit', () => {
  const state = baseState({ route: 'overview', role: 'visitor', permissions: [] });
  state.user = null;
  state.watchlist = ['SPY'];
  state.market = {
    source: 'iex',
    quotes: new Map([['SPY', { price: 611.4, change: 1.2, changePercent: 0.197, volume: 1200000 }]]),
    bars: [],
    asOf: '2026-10-12T15:30:00Z',
  };
  const html = renderApplication(state);

  assert.match(html, /Shared Alpaca IEX/);
  assert.match(html, /ALPACA IEX/);
  assert.match(html, /\$611\.40/);
  assert.doesNotMatch(html, /Market data unavailable/);
});

test('signed-out market failures are visible and can be retried from the overview', () => {
  const state = baseState({ route: 'overview', role: 'visitor', permissions: [] });
  state.user = null;
  state.market.error = 'Shared IEX market data is unavailable. Guest limit reached.';
  state.market.loading = false;
  const html = renderApplication(state);

  assert.match(html, /class="notice notice-error market-data-notice" role="alert"/);
  assert.match(html, /Guest limit reached/);
  assert.match(html, /data-action="retry-data"[^>]*>Refresh prices/);
  assert.doesNotMatch(html, /TRAINING SIMULATION/);
});

test('quote panel shows quote observation time separately from response receipt time', () => {
  const state = baseState({ route: 'markets', role: 'visitor', permissions: [] });
  state.user = null;
  state.market = {
    source: 'iex',
    quotes: new Map([['SPY', { price: 611.4, change: 1.2, changePercent: 0.197, volume: 1200000, timestamp: '2026-10-12T23:30:00Z' }]]),
    bars: [],
    asOf: '2026-10-12T23:31:00Z',
    marketClock: { isOpen: false },
    loading: false,
  };
  const html = renderApplication(state);

  assert.match(html, /QUOTE Oct 12, 2026 07:30:00 PM ET · RECEIVED .* · MARKET CLOSED/);
});

test('Quant Lab does not substitute synthetic history after a provider failure', () => {
  const state = baseState({ route: 'quant', role: 'quant', permissions: ['quant.experiments.run', 'market_data.read'] });
  state.quantHistorySource = 'Unavailable';
  state.quantBars = [];
  state.quantHistoryError = 'Historical Alpaca IEX bars are unavailable for SPY. No substitute series is used.';
  state.quantHistoryLoading = false;
  const html = renderApplication(state);

  assert.match(html, /Unavailable/);
  assert.match(html, /Historical Alpaca IEX bars are unavailable for SPY/);
  assert.match(html, /data-action="retry-quant-history"[^>]*>Refresh history/);
  assert.doesNotMatch(html, /training series|synthetic daily|TRAINING DATA/i);
  assert.match(html, /<button class="button" type="submit" disabled>Run on SPY ↗<\/button>/);
});

test('Research is a distinct company workspace linked to Markets charts and club ideas', () => {
  const research = renderApplication(baseState({ route: 'research', role: 'visitor', permissions: [] }));
  const markets = renderApplication(baseState({ route: 'markets', role: 'visitor', permissions: [] }));

  assert.match(research, /<span>RESEARCH<\/span>/);
  assert.match(research, /INSTRUMENT PROFILE/);
  assert.match(research, /Proposal activity/);
  assert.match(research, /href="#markets\?symbol=SPY"/);
  assert.match(markets, /id="price-chart"/);
  assert.match(markets, /Largest moves/);
  assert.match(markets, /href="#research\?symbol=SPY"/);
  assert.doesNotMatch(markets, /SYNTHETIC DEPTH|Generated ask levels|Illustrative market depth/);
  assert.doesNotMatch(markets, /INSTRUMENT PROFILE/);
});

test('Portfolio displays unavailable marks and totals when an open position has no verified quote', () => {
  const state = baseState({ route: 'portfolio', role: 'intern', permissions: ['portfolios.read_own'] });
  state.trades = [{ author_id: 'u-1', symbol: 'AAPL', side: 'buy', quantity: 2, price: 100, created_at: '2026-10-12T12:00:00Z' }];
  state.portfolioHistoryUserId = 'u-1';
  state.portfolioHistorySource = 'iex';
  state.portfolioHistory = {
    points: [{ date: '2026-10-12', equity: null, benchmarkEquity: 100_000, unpricedSymbols: ['AAPL'] }],
    metrics: {},
  };
  const html = renderApplication(state);

  assert.match(html, /Current quote unavailable: AAPL/);
  assert.match(html, /VALUATION UNAVAILABLE FOR AAPL/);
  assert.match(html, /without a same-session close for: AAPL/);
  assert.match(html, /using same-session closes; missing marks remain unavailable, with no stale close substituted/);
  assert.doesNotMatch(html, /latest available close|prior close exists/);
  assert.match(html, /<td class="numeric">\$100\.00<\/td><td class="numeric">—<\/td><td class="numeric">—<\/td><td class="numeric is-flat">—<\/td>/);
  assert.doesNotMatch(html, /\$100\.00 · cost/);
});
