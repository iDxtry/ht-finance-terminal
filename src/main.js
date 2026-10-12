import { mountPriceChart } from './components/price-chart.js';
import { DEFAULT_WATCHLIST, cleanSymbol, findInstruments, instrument } from './data/universe.js';
import { escapeHtml as h, formatMoney, formatTime } from './lib/format.js';
import { calculatePortfolio } from './lib/portfolio.js';
import { buildPortfolioHistory } from './lib/portfolio-history.js';
import { backendConfigured, supabase } from './lib/supabase.js';
import { loadBars, loadSnapshots, MarketDataError } from './services/market-data.js';
import { generateTrainingBars, trainingSnapshots } from './services/training-market.js';
import { renderApplication } from './views/terminal-pages.js';
import { backtestSmaCrossover, simulateMonteCarloGBM } from './quant/index.js';
import { isPublicMarketSymbol } from '../supabase/functions/_shared/market-access.js';

const app = document.querySelector('#app');
let watchlistSyncTimer = null;
const ROUTES = new Set(['overview', 'markets', 'proposals', 'portfolio', 'activity', 'manager', 'quant', 'admin']);
const STARTING_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'TLT', 'GLD', 'AAPL', 'NVDA'];
const RANGE_CONFIG = {
  '1D': { interval: '5Min', count: 78 },
  '1W': { interval: '15Min', count: 130 },
  '1M': { interval: '1Hour', count: 140 },
  '3M': { interval: '1Day', count: 65 },
  '1Y': { interval: '1Day', count: 260 },
  '5Y': { interval: '1Day', count: 1000 },
};

const state = {
  user: null,
  role: 'visitor',
  authDialogVisible: false,
  authMode: 'sign-in',
  authMessage: '',
  permissions: [],
  teamName: '',
  teamManagerNames: [],
  route: 'overview',
  symbol: 'SPY',
  chartRange: '1M',
  proposalFilter: 'all',
  tradeSearch: '',
  tradeFilterSide: 'all',
  tradeSort: 'newest',
  proposalSymbol: '',
  watchlist: loadWatchlist(null),
  proposals: [],
  proposalReviews: [],
  quantAnalyses: [],
  trades: [],
  members: [],
  portfolioMembers: [],
  selectedPortfolioUserId: '',
  portfolioHistory: null,
  portfolioHistoryUserId: '',
  portfolioHistorySource: 'training-sim',
  portfolioHistoryLoading: false,
  portfolioHistoryError: '',
  adminMembers: [],
  adminTeams: [],
  auditLog: [],
  quantResults: null,
  quantBacktest: null,
  quantBars: [],
  quantHistorySource: 'Training simulation',
  quantHistorySymbol: '',
  pendingCount: 0,
  searchOpen: false,
  searchQuery: '',
  notice: null,
  loadError: '',
  clock: '',
  showSma20: false,
  showSma50: false,
  market: {
    source: 'unavailable',
    chartSource: 'unavailable',
    quotes: new Map(),
    marketClock: null,
    bars: [],
    asOf: null,
    error: '',
    loading: false,
    loadingBars: false,
    lastRefreshAt: 0,
  },
};

let chartCleanup = () => {};
let marketRequestInFlight = false;
let chartRequestNumber = 0;
let portfolioHistoryRequestNumber = 0;
let noticeTimer = null;

function hasPermission(permission) {
  return state.permissions.includes(permission);
}

function hashState() {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const route = ROUTES.has(path) ? path : 'overview';
  try {
    if (params.has('symbol')) changeSelectedSymbol(cleanSymbol(params.get('symbol')));
  } catch {
    // An invalid link falls back to the last selected symbol.
  }
  if (params.has('range') && RANGE_CONFIG[params.get('range')]) state.chartRange = params.get('range');
  state.route = route;
}

function setHash(route, params = {}) {
  const query = new URLSearchParams();
  if (route === 'markets' && params.symbol) query.set('symbol', params.symbol);
  if (route === 'markets' && params.range && params.range !== '1M') query.set('range', params.range);
  const next = `#${route}${query.size ? `?${query}` : ''}`;
  if (location.hash === next) {
    hashState();
    render();
    return;
  }
  location.hash = next;
}

function changeSelectedSymbol(symbol) {
  if (state.symbol === symbol) return;
  state.symbol = symbol;
  state.quantResults = null;
  state.quantBacktest = null;
  state.quantBars = [];
  state.quantHistorySymbol = '';
  state.quantHistorySource = 'Training simulation';
}

function storageKey(userId) {
  return `ht-terminal-watchlist:${userId || 'device'}`;
}

function loadWatchlist(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) || 'null');
    if (Array.isArray(value)) return [...new Set(value.filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol)))].slice(0, 30);
  } catch {
    // Local preferences are optional; use the desk defaults if storage is unavailable.
  }
  return [...DEFAULT_WATCHLIST];
}

function saveWatchlist({ syncRemote = true } = {}) {
  try {
    localStorage.setItem(storageKey(state.user?.id || null), JSON.stringify(state.watchlist));
  } catch {
    setNotice('Watchlist changes are active for this session but browser storage is unavailable.', 'info');
  }
  if (syncRemote && supabase && state.user && hasPermission('market_data.read')) {
    clearTimeout(watchlistSyncTimer);
    const userId = state.user.id;
    const symbols = [...state.watchlist];
    watchlistSyncTimer = setTimeout(async () => {
      const { error } = await supabase.from('watchlists').upsert({
        user_id: userId,
        symbols,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) setNotice('Your watchlist is saved on this device but could not sync to your account.', 'error');
    }, 300);
  }
}

async function loadWatchlistPreferences() {
  if (!supabase || !state.user || !hasPermission('market_data.read')) return;
  const userId = state.user.id;
  const { data, error } = await supabase.from('watchlists').select('symbols').eq('user_id', userId).maybeSingle();
  if (error) {
    setNotice('The saved watchlist could not load; the device copy remains available.', 'error');
    return;
  }
  if (data) {
    state.watchlist = [...new Set((data.symbols || []).filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol)))].slice(0, 30);
    saveWatchlist({ syncRemote: false });
  } else {
    saveWatchlist();
  }
}

function render() {
  if (!app) return;
  const active = document.activeElement;
  const activeId = active?.id;
  const activeValue = active && 'value' in active ? active.value : null;
  let selection = null;
  try {
    if (active && typeof active.selectionStart === 'number') selection = [active.selectionStart, active.selectionEnd];
  } catch {
    // Some browser controls do not expose a text selection.
  }

  const disposeChart = chartCleanup;
  chartCleanup = () => {};
  disposeChart();
  app.innerHTML = renderApplication(state);

  if (activeId) {
    const next = document.getElementById(activeId);
    if (next) {
      if (activeValue !== null) next.value = activeValue;
      next.focus({ preventScroll: true });
      if (selection && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(...selection); } catch { /* no-op */ }
      }
    }
  }

  if (state.route === 'markets') {
    chartCleanup = mountPriceChart(document.querySelector('#price-chart'), state.market.bars, {
      quote: state.market.quotes.get(state.symbol),
      range: state.chartRange,
      showSma20: state.showSma20,
      showSma50: state.showSma50,
      readout: document.querySelector('#chart-crosshair-readout'),
    });
  }
  if (state.authDialogVisible) document.querySelector('#auth-dialog')?.showModal();
}

function setNotice(message, type = 'info') {
  clearTimeout(noticeTimer);
  state.notice = { message, type };
  render();
  noticeTimer = setTimeout(() => {
    state.notice = null;
    render();
  }, 5200);
}

function updateClock() {
  state.clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  const target = document.querySelector('.market-clock');
  if (target) target.innerHTML = `<i class="clock-dot"></i> NY ${h(state.clock)}`;
}

function openAuthDialog() {
  state.authDialogVisible = true;
  state.authMode = 'sign-in';
  state.authMessage = '';
  render();
}

async function signInWithGoogle() {
  if (!supabase) {
    state.authMessage = 'Authentication is not configured in this build. Add the public Supabase environment variables and rebuild.';
    render();
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });
  if (error) setNotice(error.message, 'error');
}

async function submitEmailAuth(form) {
  if (!supabase) {
    state.authMessage = 'Authentication is not configured in this build.';
    render();
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  const email = String(values.email || '').trim().toLowerCase();
  const password = String(values.password || '');
  state.authMessage = '';
  let error = null;

  if (state.authMode === 'reset') {
    ({ error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`,
    }));
    state.authMessage = error ? error.message : 'If that email can sign in here, a password-reset link is on its way.';
    render();
    return;
  }
  if (state.authMode === 'recovery') {
    ({ error } = await supabase.auth.updateUser({ password }));
    if (error) {
      state.authMessage = error.message;
      render();
      return;
    }
    state.authDialogVisible = false;
    state.authMode = 'sign-in';
    setNotice('Password updated. You are signed in.', 'success');
    return;
  }
  if (state.authMode === 'sign-up') {
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}${location.pathname}` },
    });
    error = signUpError;
    if (!error && !data.session) {
      state.authMessage = 'Check your email to confirm the account, then return here to sign in. An Owner still needs to assign your club role.';
      render();
      return;
    }
  } else {
    ({ error } = await supabase.auth.signInWithPassword({ email, password }));
  }

  if (error) {
    state.authMessage = error.message;
    render();
    return;
  }
  state.authDialogVisible = false;
  state.authMessage = '';
  render();
}

async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) setNotice(error.message, 'error');
}

async function loadClubData() {
  state.loadError = '';
  if (!supabase || !state.user) {
    state.role = 'visitor';
    state.permissions = [];
    state.teamName = '';
    state.teamManagerNames = [];
    state.proposals = [];
    state.proposalReviews = [];
    state.quantAnalyses = [];
    state.trades = [];
    state.members = [];
    state.portfolioMembers = [];
    state.adminMembers = [];
    state.adminTeams = [];
    state.auditLog = [];
    state.pendingCount = 0;
    render();
    return;
  }

  const memberResult = await supabase.from('members').select('role,active').eq('id', state.user.id).maybeSingle();
  if (memberResult.error) {
    state.role = 'pending';
    state.teamName = '';
    state.teamManagerNames = [];
    state.proposals = [];
    state.proposalReviews = [];
    state.quantAnalyses = [];
    state.trades = [];
    state.members = [];
    state.portfolioMembers = [];
    state.pendingCount = 0;
    state.loadError = `Could not verify club access: ${memberResult.error.message}`;
    render();
    return;
  }
  state.role = memberResult.data?.active ? memberResult.data.role : 'pending';
  if (state.role === 'pending') {
    state.proposals = [];
    state.proposalReviews = [];
    state.quantAnalyses = [];
    state.trades = [];
    state.members = [];
    state.portfolioMembers = [];
    state.adminMembers = [];
    state.adminTeams = [];
    state.auditLog = [];
    state.permissions = [];
    state.teamName = '';
    state.teamManagerNames = [];
    state.pendingCount = 0;
    render();
    return;
  }

  const permissionResult = await supabase.rpc('my_permissions');
  if (permissionResult.error) {
    state.permissions = [];
    state.teamName = '';
    state.teamManagerNames = [];
    state.loadError = `Your access permissions could not be verified: ${permissionResult.error.message}`;
    state.proposals = [];
    state.trades = [];
    state.members = [];
    state.portfolioMembers = [];
    state.adminMembers = [];
    state.adminTeams = [];
    state.auditLog = [];
    render();
    return;
  }
  state.permissions = permissionResult.data || [];
  const myTeamsResult = await supabase.rpc('my_team_details');
  if (!myTeamsResult.error) {
    const teams = myTeamsResult.data || [];
    state.teamName = [...new Set(teams.map((team) => team.team_name).filter(Boolean))].join(' · ');
    state.teamManagerNames = [...new Set(teams.flatMap((team) => team.manager_names || []).filter(Boolean))];
  } else {
    state.teamName = '';
    state.teamManagerNames = [];
  }
  await loadWatchlistPreferences();

  const [proposalResult, tradeResult, reviewResult, quantResult] = await Promise.all([
    supabase.from('proposals').select('*').order('created_at', { ascending: false }).limit(250),
    supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(1000),
    supabase.from('proposal_reviews').select('*').order('created_at', { ascending: true }).limit(1000),
    supabase.from('quant_analyses').select('*').order('created_at', { ascending: true }).limit(1000),
  ]);
  const readError = proposalResult.error || tradeResult.error || reviewResult.error || quantResult.error;
  if (readError) {
    state.loadError = `The club ledger could not load: ${readError.message}`;
    state.proposals = [];
    state.proposalReviews = [];
    state.quantAnalyses = [];
    state.trades = [];
    state.members = [];
    state.portfolioMembers = [];
    render();
    return;
  }
  state.proposals = proposalResult.data || [];
  state.proposalReviews = reviewResult.data || [];
  state.quantAnalyses = quantResult.data || [];
  state.trades = tradeResult.data || [];
  state.pendingCount = state.proposals.filter((proposal) => proposal.status === 'pending').length;

  if (hasPermission('members.read')) {
    const membersResult = await supabase.rpc('list_club_members');
    if (membersResult.error) {
      state.members = [];
      state.loadError = `The manager roster could not load: ${membersResult.error.message}`;
    } else {
      state.members = membersResult.data || [];
    }
  } else {
    state.members = [];
  }
  const [authorsResult, portfolioMembersResult] = await Promise.all([
    hasPermission('proposals.read_all') || hasPermission('proposals.read_own')
      ? supabase.rpc('list_proposal_authors')
      : Promise.resolve({ data: [], error: null }),
    hasPermission('portfolios.read_own') || hasPermission('portfolios.read_assigned') || hasPermission('portfolios.read_all')
      ? supabase.rpc('list_visible_portfolios')
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (authorsResult.error) {
    state.loadError = `Proposal participant names could not load: ${authorsResult.error.message}`;
  } else {
    const knownMembers = new Set(state.members.map((member) => member.user_id));
    state.members = [...state.members, ...(authorsResult.data || []).filter((member) => !knownMembers.has(member.user_id))];
  }
  if (portfolioMembersResult.error) {
    state.portfolioMembers = [];
    state.loadError = `Portfolio coverage could not load: ${portfolioMembersResult.error.message}`;
  } else {
    state.portfolioMembers = portfolioMembersResult.data || [];
  }
  if (hasPermission('members.manage')) {
    const [adminMembersResult, adminTeamsResult, auditResult] = await Promise.all([
      supabase.rpc('list_admin_members'),
      supabase.rpc('list_admin_teams'),
      supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100),
    ]);
    state.adminMembers = adminMembersResult.error ? [] : (adminMembersResult.data || []);
    state.adminTeams = adminTeamsResult.error ? [] : (adminTeamsResult.data || []);
    state.auditLog = auditResult.error ? [] : (auditResult.data || []);
    if (adminMembersResult.error) state.loadError = `Owner roster could not load: ${adminMembersResult.error.message}`;
    else if (adminTeamsResult.error) state.loadError = `Club groups could not load: ${adminTeamsResult.error.message}`;
    else if (auditResult.error) state.loadError = `Audit history could not load: ${auditResult.error.message}`;
  } else {
    state.adminMembers = [];
    state.adminTeams = [];
    state.auditLog = [];
  }
  if (state.route === 'manager' && !hasPermission('proposals.review')) setHash('overview');
  if (state.route === 'admin' && !hasPermission('members.manage')) setHash('overview');
  if (state.route === 'quant' && !hasPermission('quant.experiments.run')) setHash('overview');
  render();
  if (state.route === 'portfolio') {
    const visibleIds = new Set([state.user.id, ...state.portfolioMembers.map((member) => member.user_id)]);
    if (!visibleIds.has(state.selectedPortfolioUserId)) state.selectedPortfolioUserId = state.user.id;
    void loadPortfolioHistory(state.selectedPortfolioUserId, { force: true, silent: true });
  }
}

function allMarketSymbols() {
  if (!state.user || !hasPermission('market_data.read')) {
    return [...new Set([state.symbol, ...STARTING_SYMBOLS, ...state.watchlist])]
      .filter(isPublicMarketSymbol)
      .slice(0, 12);
  }
  const positions = state.user ? calculatePortfolio(state.trades, state.user.id).positions.map((position) => position.symbol) : [];
  return [...new Set([...STARTING_SYMBOLS, ...state.watchlist, state.symbol, ...positions])].slice(0, 40);
}

function setTrainingMarket(symbols = allMarketSymbols()) {
  state.market.source = 'training-sim';
  state.market.quotes = new Map(Object.entries(trainingSnapshots(symbols)));
  state.market.asOf = null;
  state.market.marketClock = null;
}

async function refreshMarketData(options = {}) {
  if (marketRequestInFlight) return;
  const previousSource = state.market.source;
  marketRequestInFlight = true;
  state.market.loading = true;
  const symbols = allMarketSymbols();
  if (!backendConfigured) {
    if (state.user) setTrainingMarket(symbols);
    else {
      state.market.source = 'unavailable';
      state.market.quotes = new Map();
      state.market.asOf = null;
    }
    state.market.error = state.user
      ? 'Supabase is not configured in this build.'
      : 'Shared IEX market data is unavailable; no simulated guest prices are shown.';
    state.market.loading = false;
    state.market.lastRefreshAt = Date.now();
    marketRequestInFlight = false;
    if (state.route === 'markets') await loadChartBars({ silent: true });
    else {
      render();
      if (state.route === 'portfolio' && previousSource !== state.market.source) {
        void loadPortfolioHistory(state.selectedPortfolioUserId || state.user?.id, { force: true, silent: true });
      }
    }
    return;
  }

  try {
    const result = await loadSnapshots(supabase, symbols);
    state.market.quotes = new Map(Object.entries(result.quotes || {}));
    state.market.marketClock = result.marketClock || null;
    state.market.source = 'iex';
    state.market.asOf = result.receivedAt || new Date().toISOString();
    state.market.error = '';
  } catch (error) {
    if (state.user) setTrainingMarket(symbols);
    else {
      state.market.source = 'unavailable';
      state.market.quotes = new Map();
      state.market.asOf = null;
      state.market.marketClock = null;
    }
    state.market.error = error instanceof MarketDataError ? error.message : String(error?.message || error);
    if (!state.user) state.market.error = `Shared IEX market data is unavailable. ${state.market.error}`;
  }
  state.market.loading = false;
  state.market.lastRefreshAt = Date.now();
  marketRequestInFlight = false;
  if (state.route === 'markets') await loadChartBars({ silent: true });
  else {
    render();
    if (state.route === 'portfolio' && previousSource !== state.market.source) {
      void loadPortfolioHistory(state.selectedPortfolioUserId || state.user?.id, { force: true, silent: true });
    }
  }
}

async function loadChartBars(options = {}) {
  const requestNumber = ++chartRequestNumber;
  const symbol = state.symbol;
  const range = state.chartRange;
  const config = RANGE_CONFIG[range] || RANGE_CONFIG['1M'];
  state.market.loadingBars = true;
  if (!options.silent && state.route === 'markets') render();

  if ((state.market.source === 'iex' || !state.user) && supabase) {
    try {
      const result = await loadBars(supabase, symbol, range);
      if (requestNumber !== chartRequestNumber || symbol !== state.symbol || range !== state.chartRange) return;
      state.market.bars = result.bars || [];
      state.market.chartSource = 'iex';
      if (!state.market.bars.length) state.market.error = `No ${range} history returned for ${symbol}.`;
    } catch (error) {
      if (requestNumber !== chartRequestNumber) return;
      if (state.user) {
        state.market.bars = generateTrainingBars(symbol, config.count, config.interval);
        state.market.chartSource = 'training-sim';
      } else {
        state.market.bars = [];
        state.market.chartSource = 'unavailable';
      }
      state.market.error = error instanceof Error ? error.message : String(error);
    }
  } else if (state.market.source === 'unavailable' && !state.user) {
    state.market.bars = [];
    state.market.chartSource = 'unavailable';
  } else {
    state.market.bars = generateTrainingBars(symbol, config.count, config.interval);
    state.market.chartSource = 'training-sim';
  }
  state.market.loadingBars = false;
  if (state.route === 'markets') render();
}

function dailyHistoryBars(bars) {
  return (bars || []).map((bar) => ({
    time: bar.time,
    date: Number.isFinite(Number(bar.time))
      ? new Date((Number(bar.time) < 10_000_000_000 ? Number(bar.time) * 1000 : Number(bar.time))).toISOString().slice(0, 10)
      : bar.date,
    close: Number(bar.close),
  }));
}

async function loadPortfolioHistory(userId = state.selectedPortfolioUserId || state.user?.id, options = {}) {
  if (!state.user || !userId) return;
  const visibleIds = new Set([state.user.id, ...state.portfolioMembers.map((member) => member.user_id)]);
  if (!visibleIds.has(userId)) return;
  if (!options.force && state.portfolioHistory && state.portfolioHistoryUserId === userId) return;

  const requestNumber = ++portfolioHistoryRequestNumber;
  state.selectedPortfolioUserId = userId;
  state.portfolioHistoryUserId = userId;
  state.portfolioHistoryLoading = true;
  state.portfolioHistoryError = '';
  if (!options.silent && state.route === 'portfolio') render();

  const accountTrades = state.trades.filter((trade) => trade.author_id === userId);
  const symbols = [...new Set(accountTrades.map((trade) => String(trade.symbol || '').trim().toUpperCase()).filter(Boolean))];
  const requestedSymbols = [...new Set([...symbols, 'SPY'])];
  const priceBarsBySymbol = {};
  const failures = [];
  const useExchangeHistory = state.market.source === 'iex' && Boolean(supabase) && hasPermission('market_data.read');

  if (useExchangeHistory) {
    state.portfolioHistorySource = 'iex';
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(6, requestedSymbols.length) }, async () => {
      while (nextIndex < requestedSymbols.length) {
        const symbol = requestedSymbols[nextIndex++];
        try {
          const result = await loadBars(supabase, symbol, '5Y');
          priceBarsBySymbol[symbol] = dailyHistoryBars(result.bars || []);
          if (!result.bars?.length) failures.push(`${symbol}: no daily bars returned`);
        } catch (error) {
          priceBarsBySymbol[symbol] = [];
          failures.push(`${symbol}: ${error?.message || 'history unavailable'}`);
        }
      }
    });
    await Promise.all(workers);
  } else {
    state.portfolioHistorySource = 'training-sim';
    for (const symbol of requestedSymbols) {
      priceBarsBySymbol[symbol] = generateTrainingBars(symbol, 1_000, '1Day');
    }
  }

  if (requestNumber !== portfolioHistoryRequestNumber) return;
  state.portfolioHistory = buildPortfolioHistory({
    trades: state.trades,
    userId,
    priceBarsBySymbol,
    benchmarkBars: priceBarsBySymbol.SPY || [],
  });
  state.portfolioHistoryError = failures.length
    ? `Historical feed is incomplete: ${failures.slice(0, 4).join(' · ')}${failures.length > 4 ? ` · +${failures.length - 4} more` : ''}`
    : '';
  state.portfolioHistoryLoading = false;
  if (state.route === 'portfolio') render();
}

async function loadQuantHistory() {
  const symbol = state.symbol;
  if (state.quantHistorySymbol === symbol && state.quantBars.length) return;
  state.quantHistorySymbol = symbol;
  state.quantHistorySource = 'Training simulation';
  state.quantBars = generateTrainingBars(symbol, 260, '1Day');
  if (supabase && state.user && hasPermission('market_data.read')) {
    try {
      const result = await loadBars(supabase, symbol, '1Y');
      if (!result.bars?.length) throw new Error('No historical bars returned.');
      if (state.symbol !== symbol || state.quantHistorySymbol !== symbol) return;
      state.quantBars = result.bars;
      state.quantHistorySource = 'Alpaca IEX';
    } catch {
      // Keep the clearly labeled deterministic training series available.
    }
  }
  if (state.route === 'quant') render();
}

function alignBenchmarkBars(bars, benchmarkBars) {
  const benchmarkByTime = new Map((benchmarkBars || []).map((bar) => [bar.time, bar]));
  const aligned = bars.filter((bar) => benchmarkByTime.has(bar.time));
  return {
    bars: aligned,
    benchmarkBars: aligned.map((bar) => benchmarkByTime.get(bar.time)),
  };
}

function runQuantSimulation(form) {
  if (!hasPermission('quant.experiments.run')) return setNotice('Quant experiment access required.', 'error');
  const fields = Object.fromEntries(new FormData(form));
  const model = {
    initialPrice: Number(fields.initialPrice),
    drift: Number(fields.drift) / 100,
    volatility: Number(fields.volatility) / 100,
    horizonYears: Number(fields.horizonYears),
    pathCount: Number(fields.pathCount),
    steps: Number(fields.steps),
    seed: `${state.symbol}:${fields.initialPrice}:${fields.drift}:${fields.volatility}:${fields.horizonYears}:${fields.pathCount}:${fields.steps}`,
  };
  try {
    state.quantResults = simulateMonteCarloGBM(model);
    render();
  } catch (error) {
    setNotice(error?.message || 'The simulation could not run with those inputs.', 'error');
  }
}

async function runQuantBacktest(form) {
  if (!hasPermission('quant.experiments.run')) return setNotice('Quant experiment access required.', 'error');
  const fields = Object.fromEntries(new FormData(form));
  const shortWindow = Number(fields.shortWindow);
  const longWindow = Number(fields.longWindow);
  if (!Number.isInteger(shortWindow) || !Number.isInteger(longWindow) || shortWindow <= 0 || longWindow <= shortWindow) {
    return setNotice('The slow moving average must be an integer greater than the fast average.', 'error');
  }
  const symbol = state.symbol;
  await loadQuantHistory();
  if (state.symbol !== symbol || state.quantHistorySymbol !== symbol) return;
  if (!state.quantBars.length) return setNotice('No bars are available for this backtest.', 'error');

  let bars = state.quantBars;
  let benchmarkBars = null;
  let benchmarkName = `${symbol} buy & hold`;
  if (state.quantHistorySource === 'Alpaca IEX' && symbol !== 'SPY' && supabase) {
    try {
      const result = await loadBars(supabase, 'SPY', '1Y');
      if (state.symbol !== symbol || state.quantHistorySymbol !== symbol) return;
      const aligned = alignBenchmarkBars(bars, result.bars || []);
      if (aligned.bars.length >= 2) {
        bars = aligned.bars;
        benchmarkBars = aligned.benchmarkBars;
        benchmarkName = 'SPY benchmark';
      }
    } catch {
      // Report the valid same-security buy-and-hold comparison if SPY is unavailable.
    }
  }
  try {
    const result = backtestSmaCrossover(bars, {
      shortWindow,
      longWindow,
      initialCapital: 100_000,
      benchmarkBars,
      periodsPerYear: 252,
    });
    state.quantBacktest = {
      ...result,
      symbol,
      benchmarkName,
      source: state.quantHistorySource,
    };
    render();
  } catch (error) {
    setNotice(error?.message || 'The backtest could not be completed.', 'error');
  }
}

function navigateToSymbol(value) {
  let symbol;
  try {
    symbol = cleanSymbol(value);
  } catch (error) {
    setNotice(error.message, 'error');
    return;
  }
  if ((!state.user || !hasPermission('market_data.read')) && !isPublicMarketSymbol(symbol)) {
    setNotice('The guest research preview covers the listed stocks and ETFs. Sign in for expanded ticker access.', 'error');
    return;
  }
  state.searchOpen = false;
  state.searchQuery = '';
  changeSelectedSymbol(symbol);
  setHash('markets', { symbol, range: state.chartRange });
  void refreshMarketData({ silent: true });
}

function toggleWatchlist(symbol) {
  if (state.watchlist.includes(symbol)) {
    state.watchlist = state.watchlist.filter((item) => item !== symbol);
    setNotice(`${symbol} removed from your watchlist.`, 'info');
  } else if (state.watchlist.length >= 30) {
    setNotice('A watchlist can hold up to 30 securities.', 'error');
    return;
  } else {
    state.watchlist = [...state.watchlist, symbol];
    setNotice(`${symbol} added to your watchlist.`, 'success');
  }
  saveWatchlist();
  void refreshMarketData({ silent: true });
}

function openProposal(symbol = '') {
  if (!state.user) {
    setNotice('Sign in before submitting a club proposal.', 'info');
    openAuthDialog();
    return;
  }
  if (state.role === 'pending') {
    setNotice('A manager must activate your club membership before you can submit a thesis.', 'error');
    return;
  }
  if (!hasPermission('proposals.create')) {
    setNotice('Your club role does not have proposal-submission permission.', 'error');
    return;
  }
  state.proposalSymbol = symbol || state.symbol;
  const dialog = document.querySelector('#proposal-dialog');
  const input = dialog?.querySelector('[name="symbol"]');
  if (input) input.value = state.proposalSymbol;
  dialog?.showModal();
  input?.focus();
}

async function submitProposal(form) {
  if (!supabase || !state.user || !hasPermission('proposals.create')) {
    setNotice('An active club role is required to submit a proposal.', 'error');
    return;
  }
  const fields = Object.fromEntries(new FormData(form));
  try {
    fields.symbol = cleanSymbol(fields.symbol);
  } catch (error) {
    setNotice(error.message, 'error');
    return;
  }
  fields.quantity = Number(fields.quantity);
  if (!Number.isFinite(fields.quantity) || fields.quantity <= 0) {
    setNotice('Enter a positive share quantity.', 'error');
    return;
  }
  for (const field of ['entry_price', 'target_price', 'stop_loss']) {
    fields[field] = Number(fields[field]);
    if (!Number.isFinite(fields[field]) || fields[field] <= 0 || fields[field] >= 100_000_000) {
      setNotice('Enter a valid entry price, target price, and stop-loss.', 'error');
      return;
    }
  }
  fields.allocation_pct = fields.allocation_pct ? Number(fields.allocation_pct) : null;
  if (fields.allocation_pct !== null && (!Number.isFinite(fields.allocation_pct) || fields.allocation_pct <= 0 || fields.allocation_pct > 100)) {
    setNotice('Allocation must be between 0 and 100 percent.', 'error');
    return;
  }
  if (fields.side === 'buy' && !(fields.stop_loss < fields.entry_price && fields.entry_price < fields.target_price)) {
    setNotice('For a buy thesis, stop-loss must be below entry and target above entry.', 'error');
    return;
  }
  if (fields.side === 'sell' && !(fields.target_price < fields.entry_price && fields.entry_price < fields.stop_loss)) {
    setNotice('For a sell thesis, target must be below entry and stop-loss above entry.', 'error');
    return;
  }
  const researchUrl = String(fields.research_url || '').trim();
  if (researchUrl) {
    try {
      const parsedUrl = new URL(researchUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('HTTPS is required.');
      fields.research_url = parsedUrl.toString();
    } catch {
      setNotice('Use a valid HTTPS link for supporting research.', 'error');
      return;
    }
  } else {
    fields.research_url = null;
  }
  if (String(fields.thesis || '').trim().length < 20 || !String(fields.risks || '').trim()) {
    setNotice('Write a thesis of at least 20 characters and name one material risk.', 'error');
    return;
  }
  const submit = form.querySelector('button[type="submit"], button:not([type])');
  if (submit) { submit.disabled = true; submit.textContent = 'Submitting…'; }
  const { error } = await supabase.from('proposals').insert({
    symbol: fields.symbol,
    side: fields.side,
    quantity: fields.quantity,
    entry_price: fields.entry_price,
    target_price: fields.target_price,
    stop_loss: fields.stop_loss,
    time_horizon: fields.time_horizon,
    allocation_pct: fields.allocation_pct,
    research_url: fields.research_url,
    thesis: String(fields.thesis).trim(),
    risks: String(fields.risks).trim(),
    author_id: state.user.id,
  });
  if (error) {
    if (submit) submit.disabled = false;
    setNotice(error.message, 'error');
    return;
  }
  document.querySelector('#proposal-dialog')?.close();
  form.reset();
  await loadClubData();
  setNotice('Thesis submitted to the manager review queue.', 'success');
}

async function reviewProposal(form, decision) {
  if (!supabase || !hasPermission('proposals.review')) return setNotice('Proposal-review permission required.', 'error');
  const values = Object.fromEntries(new FormData(form));
  const proposalId = form.dataset.proposal;
  const { error } = await supabase.rpc('review_proposal', {
    proposal_id: proposalId,
    decision,
    manager_comment: String(values.manager_comment || '').trim(),
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice(`Proposal ${decision}.`, 'success');
}

async function overrideProposal(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const values = Object.fromEntries(new FormData(form));
  const decision = String(values.decision || '');
  if (!['approved', 'rejected'].includes(decision)) return setNotice('Choose an Owner override decision.', 'error');
  const { error } = await supabase.rpc('override_proposal', {
    proposal_id: form.dataset.proposal,
    decision,
    manager_comment: String(values.manager_comment || '').trim(),
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice(`Owner override set the proposal to ${decision}.`, 'success');
}

async function addQuantAnalysis(form) {
  if (!supabase || !hasPermission('quant.research.write')) return setNotice('Quant research permission required.', 'error');
  const fields = Object.fromEntries(new FormData(form));
  const metrics = {};
  for (const [field, label] of [['annual_volatility_pct', 'annual volatility'], ['max_drawdown_pct', 'maximum drawdown'], ['var_95_pct', '95% VaR']]) {
    if (fields[field] === '') continue;
    const value = Number(fields[field]);
    if (!Number.isFinite(value) || value < 0 || value > 1000) return setNotice(`Enter a valid ${label} percentage.`, 'error');
    metrics[field] = value;
  }
  const { error } = await supabase.rpc('add_quant_analysis', {
    proposal_id: form.dataset.proposal,
    recommendation: fields.recommendation,
    summary: String(fields.summary || '').trim(),
    analysis_metrics: metrics,
  });
  if (error) return setNotice(error.message, 'error');
  form.reset();
  await loadClubData();
  setNotice('Quant finding added to the proposal history.', 'success');
}

async function executeProposal(form) {
  if (!supabase || !hasPermission('paper_trades.execute')) return setNotice('Paper-trade execution permission required.', 'error');
  const proposalId = form.dataset.proposal;
  const fillPrice = Number(new FormData(form).get('price'));
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return setNotice('Enter a valid simulated fill price.', 'error');
  const button = form.querySelector('button');
  if (button) { button.disabled = true; button.textContent = 'Recording…'; }
  const { error } = await supabase.rpc('execute_proposal', { proposal_id: proposalId, fill_price: fillPrice });
  if (error) {
    if (button) button.disabled = false;
    return setNotice(error.message, 'error');
  }
  await loadClubData();
  setNotice('Paper fill recorded in the club ledger.', 'success');
}

async function assignRole(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const assignedRole = new FormData(form).get('role');
  const targetUserId = form.dataset.userId;
  const { error } = await supabase.rpc('set_member_role', { target_user_id: targetUserId, assigned_role: assignedRole });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice(`Member role updated to ${assignedRole}.`, 'success');
}

async function assignPermission(form) {
  if (!supabase || !hasPermission('permissions.manage')) return setNotice('Owner access required.', 'error');
  const values = Object.fromEntries(new FormData(form));
  const { error } = await supabase.rpc('set_user_permission', {
    target_user_id: form.dataset.userId,
    permission_key: values.permission_key,
    effect: values.effect,
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice('Member permission updated and recorded in the audit log.', 'success');
}

async function assignPortfolioCoverage(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const values = new FormData(form);
  const { error } = await supabase.rpc('set_portfolio_coverage', {
    target_user_id: form.dataset.userId,
    team_code: values.get('team_code'),
    manager_user_ids: values.getAll('manager_user_ids'),
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice('Team and portfolio coverage saved.', 'success');
}

async function saveClubTeam(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const values = Object.fromEntries(new FormData(form));
  const teamCode = String(values.team_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(teamCode)) {
    return setNotice('Use a group code with 1–32 letters, numbers, hyphens, or underscores.', 'error');
  }
  const teamName = String(values.name || '').trim();
  if (!teamName || teamName.length > 80) return setNotice('Enter a group name up to 80 characters.', 'error');
  const description = String(values.description || '').trim();
  if (description.length > 500) return setNotice('Keep the group description under 500 characters.', 'error');
  const { error } = await supabase.rpc('save_club_team', {
    p_team_code: teamCode,
    p_team_name: teamName,
    p_description: description,
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice(`Group ${teamName} saved.`, 'success');
}

async function assignMemberTeam(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const teamCode = String(new FormData(form).get('team_code') || '').trim().toUpperCase() || null;
  const { error } = await supabase.rpc('set_member_team', {
    p_target_user_id: form.dataset.userId,
    p_team_code: teamCode,
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice(teamCode ? 'Member group assignment saved.' : 'Member removed from their group.', 'success');
}

async function assignTeamManagers(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const managerIds = new FormData(form).getAll('manager_user_ids');
  const { error } = await supabase.rpc('set_team_managers', {
    p_team_code: form.dataset.teamCode,
    p_manager_user_ids: managerIds,
  });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice('Group Managers and portfolio coverage saved.', 'success');
}

async function inviteMember(form) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const values = Object.fromEntries(new FormData(form));
  const email = String(values.email || '').trim().toLowerCase();
  const role = String(values.role || '');
  const submit = form.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Sending…'; }
  const { data, error } = await supabase.functions.invoke('owner-admin', {
    body: { action: 'invite', email, role },
  });
  if (submit) { submit.disabled = false; submit.textContent = 'Invite member'; }
  if (error || !data?.ok) return setNotice(error?.message || data?.error || 'Invitation could not be sent.', 'error');
  form.reset();
  await loadClubData();
  setNotice(`Invitation sent to ${email} with ${role} access.`, 'success');
}

async function bootstrapOwner() {
  if (!supabase || !state.user) return setNotice('Sign in first to initialize Owner access.', 'error');
  const accepted = window.confirm('Set your signed-in account as the initial Owner? The server checks the configured INITIAL_OWNER_EMAIL and allows this only before any Owner exists.');
  if (!accepted) return;
  const { data, error } = await supabase.functions.invoke('owner-admin', { body: { action: 'bootstrap' } });
  if (error || !data?.ok) return setNotice(error?.message || data?.error || 'Initial Owner setup is not available.', 'error');
  await loadClubData();
  setNotice('This account is now the initial Owner.', 'success');
}

async function removeMember(userId) {
  if (!supabase || !hasPermission('members.manage')) return setNotice('Owner access required.', 'error');
  const member = state.adminMembers.find((item) => item.user_id === userId);
  if (!member) return;
  if (!window.confirm(`Remove club access for ${member.email}? Existing research and paper-trade records will remain in the ledger.`)) return;
  const { error } = await supabase.rpc('remove_member', { target_user_id: userId });
  if (error) return setNotice(error.message, 'error');
  await loadClubData();
  setNotice('Club access removed; historical records were preserved.', 'success');
}

function exportTrades() {
  const rows = [['created_at', 'symbol', 'side', 'quantity', 'price', 'notional', 'member', 'executed_by', 'proposal_id']];
  for (const trade of state.trades) {
    rows.push([trade.created_at, trade.symbol, trade.side, trade.quantity, trade.price, Number(trade.quantity) * Number(trade.price), memberLabel(trade.author_id), memberLabel(trade.executed_by), trade.proposal_id]);
  }
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `htic-paper-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function memberLabel(userId) {
  if (userId === state.user?.id) return 'You';
  const member = state.members.find((item) => item.user_id === userId);
  return member?.full_name || member?.email || String(userId || '');
}

function onAppClick(event) {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const { action, symbol, range, indicator, proposal, decision, status } = control.dataset;
  switch (action) {
    case 'signin': openAuthDialog(); break;
    case 'google-signin': void signInWithGoogle(); break;
    case 'close-auth': state.authDialogVisible = false; state.authMessage = ''; render(); break;
    case 'auth-mode': state.authMode = control.dataset.mode; state.authMessage = ''; render(); break;
    case 'signout': void signOut(); break;
    case 'dismiss-notice': state.notice = null; render(); break;
    case 'select-symbol':
    case 'open-symbol': navigateToSymbol(symbol); break;
    case 'toggle-watch': toggleWatchlist(symbol); break;
    case 'remove-watch': toggleWatchlist(symbol); break;
    case 'open-proposal': openProposal(symbol || ''); break;
    case 'close-dialog': document.querySelector('#proposal-dialog')?.close(); break;
    case 'proposal-filter': state.proposalFilter = status; render(); break;
    case 'chart-range':
      state.chartRange = range;
      setHash('markets', { symbol: state.symbol, range });
      void loadChartBars();
      break;
    case 'toggle-indicator': state[indicator] = !state[indicator]; render(); break;
    case 'retry-data': void refreshMarketData(); break;
    case 'export-trades': exportTrades(); break;
    case 'clear-trade-filters': state.tradeSearch = ''; state.tradeFilterSide = 'all'; state.tradeSort = 'newest'; render(); break;
    case 'bootstrap-owner': void bootstrapOwner(); break;
    case 'remove-member': void removeMember(control.dataset.userId); break;
    default: break;
  }
}

function onAppInput(event) {
  if (event.target.id === 'trade-filter-symbol') {
    state.tradeSearch = event.target.value;
    render();
    return;
  }
  if (event.target.id === 'command-input') {
    state.searchQuery = event.target.value;
    state.searchOpen = true;
    render();
  }
}

function onAppChange(event) {
  if (event.target.id === 'portfolio-history-account') {
    const userId = event.target.value;
    const visibleIds = new Set([state.user?.id, ...state.portfolioMembers.map((member) => member.user_id)]);
    if (!visibleIds.has(userId)) return;
    state.selectedPortfolioUserId = userId;
    void loadPortfolioHistory(userId, { force: true });
    return;
  }
  if (event.target.id === 'trade-filter-side') state.tradeFilterSide = event.target.value;
  else if (event.target.id === 'trade-sort') state.tradeSort = event.target.value;
  else return;
  render();
}

function onAppSubmit(event) {
  const form = event.target;
  if (form.id === 'command-search') {
    event.preventDefault();
    const query = new FormData(form).get('query')?.trim() || '';
    if (!query) return;
    const match = findInstruments(query)[0];
    try {
      const symbol = match ? match.symbol : cleanSymbol(query);
      navigateToSymbol(symbol);
    } catch {
      setNotice(`No covered ticker matches “${query}”. Choose a result or use a valid US ticker.`, 'error');
    }
    return;
  }
  if (form.id === 'market-search') {
    event.preventDefault();
    navigateToSymbol(new FormData(form).get('symbol'));
    return;
  }
  if (form.dataset.form === 'proposal') {
    event.preventDefault();
    void submitProposal(form);
    return;
  }
  if (form.dataset.form === 'email-auth') {
    event.preventDefault();
    void submitEmailAuth(form);
    return;
  }
  if (form.dataset.form === 'execute') {
    event.preventDefault();
    void executeProposal(form);
    return;
  }
  if (form.dataset.form === 'proposal-review') {
    event.preventDefault();
    const decision = event.submitter?.value;
    if (!['approved', 'rejected'].includes(decision)) return setNotice('Choose approve or reject.', 'error');
    void reviewProposal(form, decision);
    return;
  }
  if (form.dataset.form === 'proposal-override') {
    event.preventDefault();
    void overrideProposal(form);
    return;
  }
  if (form.dataset.form === 'quant-analysis') {
    event.preventDefault();
    void addQuantAnalysis(form);
    return;
  }
  if (form.dataset.form === 'member-role') {
    event.preventDefault();
    void assignRole(form);
    return;
  }
  if (form.dataset.form === 'member-permission') {
    event.preventDefault();
    void assignPermission(form);
    return;
  }
  if (form.dataset.form === 'portfolio-coverage') {
    event.preventDefault();
    void assignPortfolioCoverage(form);
    return;
  }
  if (form.dataset.form === 'club-team') {
    event.preventDefault();
    void saveClubTeam(form);
    return;
  }
  if (form.dataset.form === 'member-team') {
    event.preventDefault();
    void assignMemberTeam(form);
    return;
  }
  if (form.dataset.form === 'team-managers') {
    event.preventDefault();
    void assignTeamManagers(form);
    return;
  }
  if (form.dataset.form === 'owner-invite') {
    event.preventDefault();
    void inviteMember(form);
    return;
  }
  if (form.dataset.form === 'quant-simulation') {
    event.preventDefault();
    runQuantSimulation(form);
    return;
  }
  if (form.dataset.form === 'quant-backtest') {
    event.preventDefault();
    void runQuantBacktest(form);
  }
}

function onHashChange() {
  const oldRoute = state.route;
  const oldSymbol = state.symbol;
  const oldRange = state.chartRange;
  hashState();
  state.searchOpen = false;
  state.searchQuery = '';
  render();
  if (state.route === 'markets' && (oldRoute !== 'markets' || oldSymbol !== state.symbol || oldRange !== state.chartRange)) {
    void loadChartBars();
  }
  if (state.route === 'quant' && (oldRoute !== 'quant' || oldSymbol !== state.symbol)) {
    void loadQuantHistory();
  }
  if (state.route === 'portfolio' && oldRoute !== 'portfolio') {
    void loadPortfolioHistory(state.selectedPortfolioUserId || state.user?.id, { force: true, silent: true });
  }
}

function onGlobalKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    state.searchOpen = true;
    render();
    document.querySelector('#command-input')?.focus();
  }
  if (event.key === 'Escape' && state.searchOpen) {
    state.searchOpen = false;
    render();
  }
}

async function initialize() {
  hashState();
  state.market.quotes = new Map();
  state.clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  render();
  app.addEventListener('click', onAppClick);
  app.addEventListener('input', onAppInput);
  app.addEventListener('change', onAppChange);
  app.addEventListener('submit', onAppSubmit);
  app.addEventListener('cancel', (event) => {
    if (event.target?.id === 'auth-dialog') {
      state.authDialogVisible = false;
      state.authMessage = '';
    }
  }, true);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onGlobalKeydown);
  updateClock();
  setInterval(updateClock, 15_000);

  if (!supabase) {
    state.market.error = 'Supabase is not configured in this build.';
    if (state.route === 'markets') await loadChartBars({ silent: true });
    render();
    return;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    state.loadError = `Sign-in session could not be read: ${error.message}`;
    render();
  }
  state.user = data?.session?.user || null;
  if (state.user) state.watchlist = loadWatchlist(state.user.id);
  await loadClubData();
  await refreshMarketData();
  if (state.route === 'markets') await loadChartBars({ silent: true });
  if (state.route === 'quant') await loadQuantHistory();

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      state.authDialogVisible = true;
      state.authMode = 'recovery';
      state.authMessage = '';
    }
    const nextUser = session?.user || null;
    const changed = state.user?.id !== nextUser?.id;
    state.user = nextUser;
    if (changed) {
      clearTimeout(watchlistSyncTimer);
      watchlistSyncTimer = null;
      state.permissions = [];
      state.teamName = '';
      state.teamManagerNames = [];
      state.watchlist = loadWatchlist(state.user?.id || null);
      state.market.error = '';
      state.market.source = 'unavailable';
      state.market.chartSource = 'unavailable';
      state.market.quotes = new Map();
      state.market.bars = [];
      state.market.asOf = null;
      state.market.marketClock = null;
      state.market.loading = false;
      state.market.loadingBars = false;
      chartRequestNumber += 1;
      state.selectedPortfolioUserId = state.user?.id || '';
      state.portfolioHistory = null;
      state.portfolioHistoryUserId = '';
      state.portfolioHistoryLoading = false;
      state.portfolioHistoryError = '';
      portfolioHistoryRequestNumber += 1;
      render();
      void (async () => {
        await loadClubData();
        await refreshMarketData();
      })();
    }
    if (event === 'PASSWORD_RECOVERY') render();
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - state.market.lastRefreshAt > 75_000) {
      void refreshMarketData({ silent: true });
    }
  }, 25_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.market.lastRefreshAt > 60_000) {
      void refreshMarketData({ silent: true });
    }
  });
}

void initialize();
