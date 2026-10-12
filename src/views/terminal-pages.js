import { calculateClubActivity, calculatePortfolio } from '../lib/portfolio.js';
import { classForChange, escapeHtml as h, formatCompact, formatMoney, formatNumber, formatPercent, formatSignedMoney, formatTime, relativeTime } from '../lib/format.js';
import { DEFAULT_WATCHLIST, findInstruments, instrument, INSTRUMENTS } from '../data/universe.js';
import { chartLegend } from '../components/price-chart.js';
import { renderOrderBook } from '../components/order-book.js';

const PERMISSION_LABELS = {
  'members.read': 'Read assigned roster',
  'members.manage': 'Manage members (Owner only)',
  'proposals.read_own': 'View own proposals',
  'proposals.create': 'Submit proposals',
  'proposals.read_all': 'View all proposals',
  'proposals.review': 'Review proposals',
  'paper_trades.read_own': 'View own paper trades',
  'paper_trades.read_all': 'View all paper trades',
  'paper_trades.execute': 'Execute paper trades',
  'portfolios.read_own': 'View own portfolio',
  'portfolios.read_assigned': 'View assigned portfolios',
  'portfolios.read_all': 'View all portfolios',
  'market_data.read': 'Read market data',
  'research.read': 'Read research',
  'quant.research.write': 'Write Quant research',
  'quant.experiments.run': 'Run Quant experiments',
  'quant.experiments.read': 'Read Quant experiments',
};

const OWNER_ASSIGNABLE_PERMISSIONS = Object.keys(PERMISSION_LABELS);

function can(state, permission) {
  return (state.permissions || []).includes(permission);
}

const NAV = [
  ['overview', 'Overview', 'OV'],
  ['markets', 'Markets', 'MK'],
  ['proposals', 'Proposals', 'PR'],
  ['portfolio', 'Portfolio', 'PF'],
  ['activity', 'Activity', 'AC'],
];

export function renderApplication(state) {
  const content = renderPage(state);
  const userName = state.user?.user_metadata?.full_name
    || state.user?.user_metadata?.name
    || state.user?.email?.split('@')[0]
    || 'Guest session';
  const initials = userName.split(/[\s._-]/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'G';
  const roleName = state.role === 'visitor' ? 'Research preview' : state.role === 'pending' ? 'Pending activation' : state.role;
  const marketLabel = state.market.source === 'iex' ? 'Alpaca IEX' : 'Training tape';
  const marketClass = state.market.source === 'iex' ? 'feed-live' : 'feed-demo';

  return `
    <a class="skip-link" href="#main-content">Skip to terminal</a>
    <div class="terminal-shell">
      <aside class="sidebar" aria-label="Primary navigation">
        <a class="brand" href="#overview" aria-label="HT Investment Club terminal home">
          <span class="brand-mark">HT</span>
          <span class="brand-copy"><b>HT / FINANCE CLUB</b><small>INVESTMENT DESK</small></span>
        </a>
        <div class="sidebar-section-title">DESK</div>
        <nav class="nav-list">
          ${[...NAV, ...(can(state, 'proposals.review') ? [['manager', 'Manager desk', 'MD']] : []), ...(can(state, 'members.read') ? [['members', 'Members', 'MB']] : []), ...(can(state, 'quant.experiments.run') ? [['quant', 'Quant Lab', 'QL']] : []), ...(can(state, 'members.manage') ? [['admin', 'Users & Permissions', 'AD']] : []), ['setup', 'Feed setup', 'ST']].map(([route, label, glyph]) => `
            <a class="nav-link ${state.route === route ? 'is-active' : ''}" href="#${route}" aria-current="${state.route === route ? 'page' : 'false'}">
              <span class="nav-code">${glyph}</span><span>${label}</span>${route === 'proposals' && state.pendingCount ? `<i class="nav-count">${state.pendingCount}</i>` : ''}
            </a>`).join('')}
        </nav>
        <div class="sidebar-bottom">
          <div class="connection-card">
            <div class="connection-title"><span class="feed-dot ${marketClass}"></span><b>${marketLabel}</b></div>
            <p>${state.market.source === 'iex' ? 'Exchange feed connected' : 'Synthetic values · training only'}</p>
            <a href="#setup">Configure connection <span>↗</span></a>
          </div>
          <div class="user-card">
            <span class="avatar">${h(initials)}</span>
            <span class="user-info"><b>${h(userName)}</b><small>${h(roleName)}</small></span>
            ${state.user ? '<button class="signout-button" type="button" data-action="signout" aria-label="Sign out">↗</button>' : '<button class="signout-button" type="button" data-action="signin" aria-label="Sign in">↗</button>'}
          </div>
        </div>
      </aside>

      <main class="terminal-main" id="main-content">
        <header class="terminal-topbar">
          <div class="crumb"><span>HTFC</span><b>/</b><span>${h(pageTitle(state.route).toUpperCase())}</span></div>
          <form class="command-search" id="command-search" autocomplete="off" role="search">
            <span class="command-prefix">⌕</span>
            <input id="command-input" name="query" type="search" placeholder="Find a company or ticker" aria-label="Find a company or ticker" aria-controls="search-results" aria-expanded="${state.searchOpen}">
            <kbd>⌘ K</kbd>
            ${state.searchOpen ? renderSearchResults(state.searchQuery) : ''}
          </form>
          <div class="topbar-actions">
            <span class="market-clock"><i class="clock-dot"></i> NY ${h(state.clock || '—')}</span>
            ${state.user ? `<span class="top-role role-${h(state.role)}">${h(roleName)}</span>` : '<button class="button compact" type="button" data-action="signin">Sign in</button>'}
          </div>
        </header>
        <div class="page-area">
          ${state.notice ? `<div class="notice notice-${h(state.notice.type || 'info')}" role="status"><span>${h(state.notice.message)}</span><button data-action="dismiss-notice" aria-label="Dismiss message">×</button></div>` : ''}
          ${state.loadError ? `<div class="notice notice-error" role="alert"><span>${h(state.loadError)}</span><button data-action="retry-data">Retry</button></div>` : ''}
          ${state.role === 'pending' && state.user ? '<div class="membership-banner"><b>Account awaiting activation</b><span>You can explore the training tape. A club manager must assign your role before shared proposals and paper ledgers unlock.</span></div>' : ''}
          ${content}
        </div>
        <footer class="terminal-footer">
          <span>HTIG · HTQF / EDUCATIONAL PAPER PORTFOLIO</span>
          <span>NO BROKER CONNECTION · NO LIVE ORDERS</span>
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView Lightweight Charts™ · Copyright (c) 2025 TradingView, Inc. ↗</a>
        </footer>
      </main>
    </div>
    ${renderProposalDialog(state)}
    ${renderAuthDialog(state)}
  `;
}

function renderPage(state) {
  switch (state.route) {
    case 'markets': return marketsPage(state);
    case 'proposals': return proposalsPage(state);
    case 'portfolio': return portfolioPage(state);
    case 'activity': return activityPage(state);
    case 'manager': return managerPage(state);
    case 'members': return membersPage(state);
    case 'quant': return quantPage(state);
    case 'admin': return adminPage(state);
    case 'setup': return setupPage(state);
    default: return overviewPage(state);
  }
}

function pageTitle(route) {
  return ({ overview: 'Overview', markets: 'Markets', proposals: 'Proposals', portfolio: 'Portfolio', activity: 'Activity', manager: 'Manager desk', members: 'Members', quant: 'Quant Lab', admin: 'Users & Permissions', setup: 'Feed setup' })[route] || 'Overview';
}

function renderSearchResults(query) {
  const matches = findInstruments(query || '');
  return `<div class="search-results" id="search-results" role="listbox" aria-label="Ticker results">
    ${matches.length ? matches.map((item) => `<button class="search-result" role="option" type="button" data-action="select-symbol" data-symbol="${h(item.symbol)}"><b>${h(item.symbol)}</b><span>${h(item.name)}</span><small>${h(item.exchange)}</small></button>`).join('') : '<div class="search-empty">No matches in the covered universe.</div>'}
  </div>`;
}

function heading(kicker, title, description, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${h(kicker)}</div><h1>${title}</h1><p>${h(description)}</p></div><div class="heading-action">${action}</div></div>`;
}

function marketStatus(state) {
  const connected = state.market.source === 'iex';
  return `<span class="source-label ${connected ? 'source-connected' : 'source-simulated'}"><i></i>${connected ? 'IEX EXCHANGE FEED' : 'TRAINING SIMULATION'}</span>`;
}

function quoteFor(state, symbol) {
  return state.market.quotes.get(symbol) || null;
}

function watchlistTable(state, options = {}) {
  const symbols = state.watchlist.length ? state.watchlist : DEFAULT_WATCHLIST;
  if (!symbols.length) return `<div class="table-empty"><b>Your watchlist is empty.</b><span>Search for a company above and add it to follow the tape.</span></div>`;
  return `<div class="table-frame"><table class="data-table watch-table">
    <thead><tr><th>Instrument</th><th>Last</th><th>Change</th><th>Volume</th><th></th></tr></thead>
    <tbody>${symbols.map((symbol) => {
      const item = instrument(symbol);
      const quote = quoteFor(state, symbol);
      const change = quote?.change ?? 0;
      return `<tr>
        <td><button class="instrument-select" type="button" data-action="open-symbol" data-symbol="${h(symbol)}"><b>${h(symbol)}</b><span>${h(item.name)}</span></button></td>
        <td class="numeric">${quote ? formatMoney(quote.price) : '—'}</td>
        <td class="numeric ${classForChange(change)}">${quote ? `${formatSignedMoney(change)} <small>${formatPercent(quote.changePercent)}</small>` : '—'}</td>
        <td class="numeric volume-cell">${quote ? formatCompact(quote.volume) : '—'}</td>
        <td class="row-actions"><button class="mini-icon" type="button" data-action="open-symbol" data-symbol="${h(symbol)}" title="Open ${h(symbol)} workspace">↗</button>${options.manage ? `<button class="mini-icon remove-icon" type="button" data-action="remove-watch" data-symbol="${h(symbol)}" title="Remove ${h(symbol)} from watchlist">×</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function overviewPage(state) {
  const watchQuotes = state.watchlist.map((symbol) => quoteFor(state, symbol)).filter(Boolean);
  const advancing = watchQuotes.filter((quote) => quote.change > 0).length;
  const declining = watchQuotes.filter((quote) => quote.change < 0).length;
  const own = calculatePortfolio(state.trades, state.user?.id, state.market.quotes);
  const pending = state.proposals.filter((proposal) => proposal.status === 'pending').length;
  const portfolioLabel = state.user && state.role !== 'pending' ? formatMoney(own.equity) : '—';
  const activity = state.trades.slice(0, 5);
  return `
    ${heading('MARKET INTELLIGENCE / CLUB WORKSPACE', 'Investment desk<span class="heading-period">.</span>', 'A shared research book for intern theses, manager decisions, quantitative findings, and simulated execution.', can(state, 'proposals.create') ? `<button class="button button-accent" type="button" data-action="open-proposal">New thesis <span>＋</span></button>` : '')}
    <section class="index-strip" aria-label="Market indices">
      ${['SPY', 'QQQ', 'DIA', 'IWM', 'TLT', 'GLD'].map((symbol) => indexTile(state, symbol)).join('')}
      <div class="strip-source">${marketStatus(state)}</div>
    </section>
    <div class="overview-grid">
      <section class="panel watch-panel">
        <div class="panel-heading"><div><div class="eyebrow">COVERAGE / ${state.watchlist.length.toString().padStart(2, '0')} NAMES</div><h2>Watchlist</h2></div><a class="inline-link" href="#markets">Open markets ↗</a></div>
        ${watchlistTable(state)}
      </section>
      <section class="panel pulse-panel">
        <div class="panel-heading"><div><div class="eyebrow">DESK PULSE / ${formatTime(new Date())}</div><h2>What needs attention</h2></div></div>
        <div class="pulse-metric"><span>Watchlist breadth</span><b class="${advancing >= declining ? 'is-up' : 'is-down'}">${advancing} advancing <i>·</i> ${declining} declining</b></div>
        <div class="pulse-metric"><span>Manager review queue</span><b>${can(state, 'proposals.review') ? `${pending} pending` : state.role === 'pending' || !state.user ? 'Member access required' : '—'}</b></div>
        <div class="pulse-metric"><span>My paper equity</span><b>${portfolioLabel}</b></div>
        <div class="pulse-rule"></div>
        ${state.user && state.role === 'pending' ? `<div class="inline-callout"><b>Owner activation needed</b><span>Your account is signed in. Ask the club Owner to assign your role.</span></div>` : `<div class="workflow-steps"><div><i>01</i><span>Submit a written thesis</span></div><div><i>02</i><span>Manager reviews the risk</span></div><div><i>03</i><span>Manager records a paper fill</span></div></div>`}
      </section>
      <section class="panel recent-panel">
        <div class="panel-heading"><div><div class="eyebrow">LATEST RESEARCH / ${state.proposals.length}</div><h2>Proposal flow</h2></div><a class="inline-link" href="#proposals">Review all ↗</a></div>
        ${state.proposals.length ? `<div class="proposal-list">${state.proposals.slice(0, 5).map((proposal) => compactProposal(proposal)).join('')}</div>` : `<div class="table-empty"><b>No shared proposals yet.</b><span>Write a thesis with a clear catalyst and the risks that would invalidate it.</span>${can(state, 'proposals.create') ? '<button class="text-action" type="button" data-action="open-proposal">Draft first thesis ↗</button>' : ''}</div>`}
      </section>
      <section class="panel ledger-panel">
        <div class="panel-heading"><div><div class="eyebrow">EXECUTION JOURNAL / ${state.trades.length}</div><h2>Recent paper fills</h2></div><a class="inline-link" href="#activity">Open ledger ↗</a></div>
        ${activity.length ? `<div class="ledger-list">${activity.map((trade) => compactTrade(state, trade)).join('')}</div>` : `<div class="table-empty"><b>The execution journal is clear.</b><span>Paper fills appear after a manager approves and records a proposal.</span></div>`}
      </section>
    </div>
    <div class="data-footnote">${state.market.source === 'iex' ? `ALPACA IEX SNAPSHOT · RECEIVED ${state.market.asOf ? relativeTime(state.market.asOf).toUpperCase() : '—'}` : 'TRAINING TAPE · SYNTHETIC PRICES · NOT MARKET DATA'} <span>Paper equity is marked against the selected price feed. No orders are sent to a broker.</span></div>
  `;
}

function indexTile(state, symbol) {
  const item = instrument(symbol);
  const quote = quoteFor(state, symbol);
  return `<button type="button" class="index-tile" data-action="open-symbol" data-symbol="${h(symbol)}"><span>${h(symbol)} <small>${h(item.name.replace(/ (ETF|Trust|Shares)$/i, ''))}</small></span><b>${quote ? formatMoney(quote.price) : '—'}</b><i class="${classForChange(quote?.change || 0)}">${quote ? formatPercent(quote.changePercent) : '—'}</i></button>`;
}

function marketsPage(state) {
  const item = instrument(state.symbol);
  const quote = quoteFor(state, state.symbol);
  const legend = chartLegend(quote, state.market.bars);
  const change = quote?.change ?? 0;
  const isWatched = state.watchlist.includes(state.symbol);
  const movers = [...INSTRUMENTS]
    .map(([symbol]) => ({ symbol, quote: quoteFor(state, symbol) }))
    .filter((item) => item.quote)
    .sort((a, b) => Math.abs(b.quote.changePercent) - Math.abs(a.quote.changePercent))
    .slice(0, 7);

  return `
    ${heading('MARKET MONITOR / UNITED STATES', 'Markets<span class="heading-period">.</span>', 'Search the covered universe, compare the tape, and study price history.', `<form class="symbol-entry" id="market-search"><span>LOOKUP</span><input name="symbol" value="${h(state.symbol)}" maxlength="12" aria-label="Ticker symbol" autocomplete="off"><button class="button button-accent">Go <span>↵</span></button></form>`)}
    <section class="quote-header">
      <div class="quote-identity"><span class="exchange-code">${h(item.exchange)}</span><h2>${h(state.symbol)}</h2><p>${h(item.name)} <i>·</i> ${h(item.sector)}</p></div>
      <div class="quote-price-block"><strong>${quote ? formatMoney(quote.price, { digits: quote.price < 2 ? 4 : 2 }) : '—'}</strong><span class="${classForChange(change)}">${quote ? `${formatSignedMoney(change)} (${formatPercent(quote.changePercent)})` : 'Awaiting feed'}</span><small>${state.market.asOf ? `AS OF ${formatTime(state.market.asOf)} · ${state.market.marketClock ? `MARKET ${state.market.marketClock.isOpen ? 'OPEN' : 'CLOSED'}` : 'SESSION UNKNOWN'}` : 'NO EXCHANGE SNAPSHOT'}</small></div>
      <div class="quote-actions">${marketStatus(state)}<button class="button ${isWatched ? 'button-muted' : 'button-accent'}" type="button" data-action="toggle-watch" data-symbol="${h(state.symbol)}">${isWatched ? 'Following ✓' : '＋ Follow'}</button>${can(state, 'proposals.create') ? `<button class="button" type="button" data-action="open-proposal" data-symbol="${h(state.symbol)}">Pitch trade</button>` : ''}</div>
    </section>
    <div class="market-layout">
      <section class="panel chart-panel">
        <div class="chart-panel-head"><div><div class="eyebrow">PRICE HISTORY / ${h(state.symbol)} / ${h(state.chartRange)}</div><h2>${legend.price ? formatMoney(legend.price) : 'Price chart'} <small id="chart-crosshair-readout">Move crosshair for OHLC</small></h2></div><div class="chart-controls">
          <div class="segmented" aria-label="Chart range">${['1D', '1W', '1M', '3M', '1Y', '5Y'].map((range) => `<button type="button" data-action="chart-range" data-range="${range}" class="${state.chartRange === range ? 'selected' : ''}" aria-pressed="${state.chartRange === range}">${range}</button>`).join('')}</div>
        </div></div>
        <div class="chart-indicators"><button class="indicator-toggle ${state.showSma20 ? 'active' : ''}" type="button" data-action="toggle-indicator" data-indicator="showSma20" aria-pressed="${state.showSma20}"><i class="indicator-dot sma20"></i>SMA 20</button><button class="indicator-toggle ${state.showSma50 ? 'active' : ''}" type="button" data-action="toggle-indicator" data-indicator="showSma50" aria-pressed="${state.showSma50}"><i class="indicator-dot sma50"></i>SMA 50</button><span>${state.market.loadingBars ? 'LOADING BARS…' : `${state.market.bars.length} BARS`} · ${h(state.market.chartSource === 'iex' ? 'IEX' : 'TRAINING SIM')}</span></div>
        <div id="price-chart" class="price-chart" aria-label="Interactive candlestick price chart"></div>
        <div class="chart-credit"><span>${state.market.chartSource === 'iex' ? 'Source: Alpaca IEX · Exchange coverage is limited to IEX.' : 'Illustrative generated candles · no current market data.'}</span><a href="https://www.tradingview.com/" rel="noopener" target="_blank">TradingView Lightweight Charts™ ↗</a></div>
      </section>
      <aside class="panel quote-details">
        <div class="panel-heading"><div><div class="eyebrow">SESSION SNAPSHOT</div><h2>Trading range</h2><small class="session-state">${state.market.source === 'iex' && state.market.marketClock ? `US MARKET ${state.market.marketClock.isOpen ? 'OPEN' : 'CLOSED'} · NEW YORK` : state.market.source === 'iex' ? 'US MARKET STATUS UNAVAILABLE' : 'NO EXCHANGE SESSION DATA'}</small></div><span class="detail-feed-dot ${state.market.source === 'iex' ? 'feed-live' : 'feed-demo'}"></span></div>
        ${detailRow('Open', quote?.open)}${detailRow('Day high', quote?.high)}${detailRow('Day low', quote?.low)}${detailRow('Prev. close', quote?.previousClose)}${detailRow('Volume', quote?.volume, true)}${detailRow('Bid', quote?.bid)}${detailRow('Ask', quote?.ask)}
        <div class="range-meter"><div class="range-track"><i style="--range-position:${quote && quote.high > quote.low ? `${Math.min(100, Math.max(0, ((quote.price - quote.low) / (quote.high - quote.low)) * 100))}%` : '50%'}"></i></div><div><span>LOW ${quote ? formatMoney(quote.low) : '—'}</span><span>HIGH ${quote ? formatMoney(quote.high) : '—'}</span></div></div>
      </aside>
    </div>
    <div class="market-bottom-grid">
      ${renderOrderBook(state.symbol, quote)}
      <section class="panel movers-panel"><div class="panel-heading"><div><div class="eyebrow">COVERED UNIVERSE</div><h2>Largest moves</h2></div><span class="quiet-count">${movers.length} symbols</span></div>
        ${movers.length ? `<div class="table-frame"><table class="data-table"><thead><tr><th>Ticker</th><th>Last</th><th>Day change</th></tr></thead><tbody>${movers.map(({symbol,quote:row}) => `<tr><td><button type="button" class="instrument-select" data-action="open-symbol" data-symbol="${h(symbol)}"><b>${h(symbol)}</b><span>${h(instrument(symbol).name)}</span></button></td><td class="numeric">${formatMoney(row.price)}</td><td class="numeric ${classForChange(row.change)}">${formatPercent(row.changePercent)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="table-empty"><b>Waiting on a snapshot.</b><span>Market changes will populate after the feed connects.</span></div>`}
      </section>
      <section class="panel market-watch-panel"><div class="panel-heading"><div><div class="eyebrow">PERSONAL COVERAGE / ${state.watchlist.length}</div><h2>Watchlist</h2></div><a href="#setup" class="inline-link">Feed setup ↗</a></div>${watchlistTable(state, {manage:true})}</section>
    </div>
  `;
}

function detailRow(label, value, compact = false) {
  const display = value == null || !Number.isFinite(Number(value)) ? '—' : compact ? formatCompact(value) : formatMoney(value);
  return `<div class="detail-row"><span>${h(label)}</span><b>${display}</b></div>`;
}

function proposalsPage(state) {
  if (!state.user) return authGate('Proposals are shared with signed-in club members.', 'Sign in with email and password or Google to draft a thesis and review club research.');
  if (state.role === 'pending') return memberGate();
  const active = state.proposalFilter || 'all';
  const proposals = active === 'all' ? state.proposals : state.proposals.filter((proposal) => proposal.status === active);
  const tabs = ['all', 'pending', 'approved', 'executed', 'rejected'];
  return `
    ${heading('RESEARCH QUEUE / THESIS BEFORE TRADE', 'Proposals<span class="heading-period">.</span>', 'Interns submit the reasoning and risk. Managers approve or reject before paper execution.', can(state, 'proposals.create') ? `<button type="button" class="button button-accent" data-action="open-proposal">＋ Write a thesis</button>` : '')}
    <div class="filter-tabs" role="tablist" aria-label="Filter proposals">${tabs.map((status) => `<button role="tab" type="button" data-action="proposal-filter" data-status="${status}" class="${active === status ? 'selected' : ''}" aria-selected="${active === status}">${status === 'all' ? 'All research' : titleCase(status)} <i>${status === 'all' ? state.proposals.length : state.proposals.filter((proposal) => proposal.status === status).length}</i></button>`).join('')}</div>
    ${proposals.length ? `<div class="proposal-grid">${proposals.map((proposal) => proposalCard(state, proposal)).join('')}</div>` : `<section class="panel empty-panel"><span class="empty-code">${active === 'all' ? 'NO IDEAS' : `NO ${active.toUpperCase()}`}</span><h2>Nothing in this view yet.</h2><p>${active === 'all' ? 'Start with a security, a time horizon, a catalyst, and one way your thesis could fail.' : `No ${active} proposals are in the ledger.`}</p>${active === 'all' && can(state, 'proposals.create') ? '<button class="button button-accent" type="button" data-action="open-proposal">Draft first thesis</button>' : ''}</section>`}
  `;
}

function proposalCard(state, proposal) {
  const author = memberName(state, proposal.author_id);
  const canReview = can(state, 'proposals.review') && proposal.status === 'pending';
  const canOverride = can(state, 'members.manage') && ['approved', 'rejected'].includes(proposal.status);
  const canExecute = can(state, 'paper_trades.execute') && proposal.status === 'approved';
  return `<article class="proposal-card">
    <div class="proposal-card-top"><span class="proposal-symbol">${h(proposal.symbol)}</span><span class="status-tag status-${h(proposal.status)}">${h(proposal.status)}</span></div>
    <div class="proposal-line">${h(proposal.side.toUpperCase())} <i>·</i> ${formatNumber(proposal.quantity, 4)} SHARES <i>·</i> ${h(formatTime(proposal.created_at, { dateOnly: true }))}</div>
    <div class="proposal-author">SUBMITTED BY <b>${h(author)}</b></div>
    <div class="proposal-levels"><span><small>ENTRY</small><b>${proposal.entry_price ? formatMoney(proposal.entry_price) : '—'}</b></span><span><small>TARGET</small><b>${proposal.target_price ? formatMoney(proposal.target_price) : '—'}</b></span><span><small>STOP</small><b>${proposal.stop_loss ? formatMoney(proposal.stop_loss) : '—'}</b></span><span><small>HORIZON</small><b>${h(titleCase(proposal.time_horizon || 'unspecified'))}</b></span>${proposal.allocation_pct ? `<span><small>ALLOCATION</small><b>${formatPercent(proposal.allocation_pct)}</b></span>` : ''}</div>
    <div class="thesis-block"><small>INVESTMENT THESIS</small><p>${h(proposal.thesis)}</p></div>
    <div class="risk-block"><small>RISK / INVALIDATION</small><p>${h(proposal.risks)}</p></div>
    ${proposal.research_url ? `<a class="inline-link proposal-research-link" href="${h(proposal.research_url)}" target="_blank" rel="noopener noreferrer">Supporting research ↗</a>` : ''}
    ${proposal.reviewed_at ? `<div class="review-meta">${proposal.status === 'executed' ? 'EXECUTED' : 'REVIEWED'} ${h(relativeTime(proposal.reviewed_at))} BY ${h(memberName(state, proposal.reviewed_by))}</div>` : ''}
    ${canReview ? `<form class="review-controls" data-form="proposal-review" data-proposal="${h(proposal.id)}"><label>MANAGER REVIEW COMMENT<textarea name="manager_comment" maxlength="2000" rows="2" placeholder="Key reason, condition, or follow-up for the intern"></textarea></label><div><button class="button approve-button" type="submit" value="approved">Approve thesis</button><button class="button reject-button" type="submit" value="rejected">Reject</button></div></form>` : proposal.manager_comment ? `<div class="review-comment"><small>MANAGER COMMENT</small><p>${h(proposal.manager_comment)}</p></div>` : ''}
    ${(state.proposalReviews || []).filter((review) => review.proposal_id === proposal.id).map((review) => `<div class="review-history"><small>${review.is_override ? 'OWNER OVERRIDE · ' : ''}${h(titleCase(review.decision))} · ${h(memberName(state, review.reviewer_id))} · ${h(formatTime(review.created_at))}</small>${review.comment ? `<p>${h(review.comment)}</p>` : ''}</div>`).join('')}
    ${(state.quantAnalyses || []).filter((analysis) => analysis.proposal_id === proposal.id).map((analysis) => `<div class="quant-review quant-${h(analysis.recommendation)}"><small>HTQF / ${h(analysis.recommendation)} · ${h(memberName(state, analysis.analyst_id))} · ${h(formatTime(analysis.created_at))}</small><p>${h(analysis.summary)}</p><div>${Object.entries(analysis.metrics || {}).map(([key, value]) => `<span>${h(key.replaceAll('_', ' '))} <b>${h(value)}%</b></span>`).join('')}</div></div>`).join('')}
    ${can(state, 'quant.research.write') ? `<form class="quant-analysis-form" data-form="quant-analysis" data-proposal="${h(proposal.id)}"><label>HTQF ANALYSIS<select name="recommendation"><option value="support">Support thesis</option><option value="caution">Flag risk</option><option value="oppose">Oppose thesis</option></select></label><label>SUMMARY<textarea name="summary" minlength="20" maxlength="2000" rows="2" placeholder="State the result, assumptions, and limitations" required></textarea></label><div><label>VOLATILITY / %<input name="annual_volatility_pct" type="number" min="0" max="1000" step="0.01"></label><label>MAX DRAWDOWN / %<input name="max_drawdown_pct" type="number" min="0" max="1000" step="0.01"></label><label>95% VaR / %<input name="var_95_pct" type="number" min="0" max="1000" step="0.01"></label></div><button class="button compact" type="submit">Add quantitative finding</button></form>` : ''}
    ${canOverride ? `<form class="review-controls owner-override" data-form="proposal-override" data-proposal="${h(proposal.id)}"><label>OWNER OVERRIDE / REPLACE ${h(proposal.status.toUpperCase())} DECISION<textarea name="manager_comment" maxlength="2000" rows="2" placeholder="Explain the reason for changing the prior decision"></textarea></label><div><select name="decision" aria-label="Owner override decision"><option value="approved" ${proposal.status === 'approved' ? 'selected' : ''}>Set approved</option><option value="rejected" ${proposal.status === 'rejected' ? 'selected' : ''}>Set rejected</option></select><button class="button button-accent" type="submit">Override decision</button></div></form>` : ''}
    ${canExecute ? `<form class="fill-entry" data-form="execute" data-proposal="${h(proposal.id)}"><label>MANAGER PAPER FILL / USD<input name="price" type="number" min="0.0001" step="any" required placeholder="Enter the executed simulation price"></label><button class="button button-accent">Record fill ↗</button></form>` : ''}
  </article>`;
}

function portfolioPage(state) {
  if (!state.user) return authGate('Your paper book is private to your club account.', 'Sign in to review holdings and cash from approved paper fills.');
  if (state.role === 'pending') return memberGate();
  const canViewAssigned = can(state, 'portfolios.read_assigned') || can(state, 'portfolios.read_all');
  const owners = canViewAssigned
    ? state.portfolioMembers.filter((member) => member.role === 'intern' || member.user_id === state.user.id)
    : [{ user_id: state.user.id, full_name: 'Your paper account', role: state.role }];
  const portfolioUserId = owners.some((member) => member.user_id === state.selectedPortfolioUserId)
    ? state.selectedPortfolioUserId
    : (owners[0]?.user_id || state.user.id);
  const selectedAccount = owners.find((member) => member.user_id === portfolioUserId);
  const selectedAccountName = selectedAccount?.full_name || (portfolioUserId === state.user.id ? 'Your paper account' : 'Intern account');
  const accountSelector = canViewAssigned && owners.length > 1
    ? `<label class="history-account-select">HISTORY ACCOUNT<select id="portfolio-history-account">${owners.map((member) => `<option value="${h(member.user_id)}" ${member.user_id === portfolioUserId ? 'selected' : ''}>${h(member.full_name || 'Intern account')}</option>`).join('')}</select></label>`
    : '';
  const coverageName = state.role === 'owner' ? 'Owner oversight' : state.role === 'manager' ? 'Assigned Manager scope' : state.role === 'quant' ? 'HTQF research scope' : 'Personal book';
  const books = owners.map((member) => ({
    member,
    portfolio: calculatePortfolio(state.trades, member.user_id, state.market.quotes),
  }));
  const totals = books.reduce((sum, row) => ({
    equity: sum.equity + row.portfolio.equity,
    cash: sum.cash + row.portfolio.cash,
    marketValue: sum.marketValue + row.portfolio.marketValue,
    totalPnl: sum.totalPnl + row.portfolio.totalPnl,
    unrealizedPnl: sum.unrealizedPnl + row.portfolio.unrealizedPnl,
    costBasis: sum.costBasis + row.portfolio.costBasis,
    positionCount: sum.positionCount + row.portfolio.positions.length,
  }), { equity: 0, cash: 0, marketValue: 0, totalPnl: 0, unrealizedPnl: 0, costBasis: 0, positionCount: 0 });
  const allPositions = books.flatMap(({ member, portfolio }) => portfolio.positions.map((position) => ({ ...position, ownerName: member.full_name || member.email || 'Club member' })));
  const priced = allPositions.filter((position) => position.quoteAvailable).length;
  return `
    ${heading(canViewAssigned ? 'ASSIGNED INTERN BOOKS / PAPER LEDGER' : 'SIMULATED BOOK / MARKED TO SELECTED FEED', 'Portfolio<span class="heading-period">.</span>', canViewAssigned ? 'Assigned intern accounts derived from approved paper fills, marked against the visible feed.' : 'Average-cost holdings from approved manager-recorded paper fills. Marks use the visible feed.', `${accountSelector}<a class="button" href="#activity">Open trade ledger ↗</a>`)}
    <div class="portfolio-summary">
      ${summaryMetric(canViewAssigned ? 'Assigned paper equity' : 'Paper equity', formatMoney(totals.equity), `${formatSignedMoney(totals.totalPnl)} total simulated P/L`, classForChange(totals.totalPnl))}
      ${summaryMetric('Available cash', formatMoney(totals.cash), 'Starting cash less buys, plus sells', '')}
      ${summaryMetric('Open market value', formatMoney(totals.marketValue), `${totals.positionCount} open positions`, '')}
      ${summaryMetric('Unrealized P/L', formatSignedMoney(totals.unrealizedPnl), `${formatPercent(totals.costBasis ? (totals.unrealizedPnl / totals.costBasis) * 100 : 0)} on cost basis`, classForChange(totals.unrealizedPnl))}
    </div>
    ${portfolioHistoryPanel(state, portfolioUserId, selectedAccountName)}
    ${canViewAssigned ? `<section class="panel assigned-books"><div class="panel-heading"><div><div class="eyebrow">PORTFOLIO COVERAGE / ${books.length} ACCOUNTS</div><h2>Assigned intern books</h2></div><span class="quiet-count">${h(coverageName)}</span></div>${books.length ? `<div class="table-frame"><table class="data-table"><thead><tr><th>Intern / account</th><th>Team</th><th>Equity</th><th>Cash</th><th>Market value</th><th>Total P/L</th></tr></thead><tbody>${books.map(({member,portfolio}) => `<tr><td>${h(member.full_name || member.email || 'Club member')}</td><td>${h(member.team || '—')}</td><td class="numeric">${formatMoney(portfolio.equity)}</td><td class="numeric">${formatMoney(portfolio.cash)}</td><td class="numeric">${formatMoney(portfolio.marketValue)}</td><td class="numeric ${classForChange(portfolio.totalPnl)}">${formatSignedMoney(portfolio.totalPnl)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="table-empty"><b>No Intern portfolios are assigned to this view.</b><span>The Owner assigns HTQF teams and Manager coverage in Users & Permissions.</span></div>'}</section>` : ''}
    <section class="panel positions-panel"><div class="panel-heading"><div><div class="eyebrow">LONG POSITIONS / AVERAGE COST</div><h2>Holdings</h2></div><span class="quiet-count">${priced} of ${allPositions.length} marked from ${state.market.source === 'iex' ? 'IEX' : 'training data'}</span></div>
      ${allPositions.length ? `<div class="table-frame"><table class="data-table positions-table"><thead><tr>${canViewAssigned ? '<th>Intern</th>' : ''}<th>Security</th><th>Shares</th><th>Avg. cost</th><th>Mark</th><th>Market value</th><th>Unrealized P/L</th></tr></thead><tbody>${allPositions.map((position) => `<tr>${canViewAssigned ? `<td>${h(position.ownerName)}</td>` : ''}<td><button class="instrument-select" type="button" data-action="open-symbol" data-symbol="${h(position.symbol)}"><b>${h(position.symbol)}</b><span>${h(instrument(position.symbol).name)}</span></button></td><td class="numeric">${formatNumber(position.shares, 4)}</td><td class="numeric">${formatMoney(position.averageCost)}</td><td class="numeric">${position.quoteAvailable ? formatMoney(position.mark) : `<span class="at-cost">${formatMoney(position.averageCost)} · cost</span>`}</td><td class="numeric">${formatMoney(position.marketValue)}</td><td class="numeric ${classForChange(position.unrealizedPnl)}">${formatSignedMoney(position.unrealizedPnl)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="table-empty"><b>${canViewAssigned ? 'No assigned holdings yet.' : 'No holdings yet.'}</b><span>Propose an idea, wait for manager approval, then the manager records the paper fill.</span><a class="text-action" href="#proposals">Open research queue ↗</a></div>`}
    </section>
    <div class="data-footnote">MARKET VALUE IS IEX PRICED WHEN CONNECTED; OTHERWISE OPEN POSITIONS DISPLAY AT COST. PAPER TRADES DO NOT ROUTE TO A BROKER.</div>
  `;
}

function summaryMetric(label, value, foot, tone = '') {
  return `<article class="summary-metric"><small>${h(label)}</small><b class="${tone}">${h(value)}</b><span>${h(foot)}</span></article>`;
}

function portfolioHistoryPanel(state, userId, accountName) {
  const history = state.portfolioHistoryUserId === userId ? state.portfolioHistory : null;
  const sourceIsTraining = state.portfolioHistorySource !== 'iex';
  const sourceLabel = sourceIsTraining ? 'TRAINING SIMULATION · SYNTHETIC DAILY SERIES' : 'ALPACA IEX · HISTORICAL DAILY BARS';
  const metrics = history?.metrics || {};
  const unpricedSymbols = [...new Set((history?.points || []).flatMap((point) => point.unpricedSymbols || []))];
  const sharpe = Number.isFinite(metrics.sharpeRatio) ? metrics.sharpeRatio.toFixed(2) : '—';
  const vol = Number.isFinite(metrics.annualizedVolatilityPercent) ? `${metrics.annualizedVolatilityPercent.toFixed(2)}%` : '—';
  const drawdown = Number.isFinite(metrics.maxDrawdownPercent) ? `−${metrics.maxDrawdownPercent.toFixed(2)}%` : '—';
  const totalReturn = Number.isFinite(metrics.cumulativeReturnPercent) ? formatPercent(metrics.cumulativeReturnPercent) : '—';
  const marketValues = history?.points.flatMap((point) => [point.equity, point.benchmarkEquity]).filter(Number.isFinite) || [];
  const empty = state.portfolioHistoryLoading
    ? '<div class="history-empty">Loading daily bars and replaying paper fills…</div>'
    : state.portfolioHistoryError && !history
      ? `<div class="history-empty">${h(state.portfolioHistoryError)}</div>`
      : !history?.points.length
        ? '<div class="history-empty">No daily bars are available for this account yet.</div>'
        : !marketValues.length
          ? '<div class="history-empty">Held symbols have no close in the available daily history window.</div>'
          : '';
  return `<section class="panel portfolio-history-panel">
    <div class="panel-heading"><div><div class="eyebrow">DAILY MARKS / ${h(accountName)}</div><h2>Equity vs. SPY</h2></div><span class="source-label ${sourceIsTraining ? 'source-simulated' : 'source-connected'}"><i></i>${sourceLabel}</span></div>
    ${state.portfolioHistoryError ? `<div class="history-warning" role="status">${h(state.portfolioHistoryError)}</div>` : ''}
    ${unpricedSymbols.length ? `<div class="history-warning" role="status">Portfolio equity is omitted on dates before a prior close exists for: ${h(unpricedSymbols.join(', '))}.</div>` : ''}
    <div class="history-chart-wrap">${empty || historySvg(history)}</div>
    <div class="history-legend"><span><i class="equity-swatch"></i>${h(accountName)} equity</span><span><i class="benchmark-swatch"></i>SPY buy &amp; hold · $100,000</span><small>${history?.points.length ? `${history.points[0].date} — ${history.points.at(-1).date} · ${history.points.length} daily marks` : '—'}</small></div>
    <div class="history-metrics">
      ${summaryMetric('Cumulative return', totalReturn, 'Against $100,000 starting capital', classForChange(metrics.cumulativeReturnPercent || 0))}
      ${summaryMetric('Maximum drawdown', drawdown, 'Peak-to-trough decline', 'is-down')}
      ${summaryMetric('Annualized volatility', vol, 'Daily returns · 252 trading days', '')}
      ${summaryMetric('Sharpe ratio', sharpe, 'Zero risk-free rate · daily returns', '')}
    </div>
    <p class="history-method">Daily points replay this account’s fills through each date and mark holdings at the latest available close. SPY starts at $100,000 on the first date in this period. ${sourceIsTraining ? 'Synthetic training bars are deterministic and are not market data.' : 'Alpaca IEX is an exchange-limited feed; dates shown are daily bars.'}</p>
  </section>`;
}

function historySvg(history) {
  const points = history?.points || [];
  const finite = points.flatMap((point) => [point.equity, point.benchmarkEquity]).filter(Number.isFinite);
  if (!finite.length) return '';
  const width = 760;
  const height = 224;
  const left = 72;
  const right = 14;
  const top = 12;
  const bottom = 26;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const pad = Math.max((high - low) * 0.08, high * 0.0005, 1);
  const min = low - pad;
  const max = high + pad;
  const x = (index) => left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * (width - left - right));
  const y = (value) => top + ((max - value) / (max - min)) * (height - top - bottom);
  const pathsFor = (key, color) => {
    const fragments = [];
    let segment = [];
    const flush = () => {
      if (!segment.length) return;
      if (segment.length === 1) {
        fragments.push(`<circle cx="${segment[0][0]}" cy="${segment[0][1]}" r="2.5" fill="${color}"/>`);
      } else {
        const d = segment.map(([pointX, pointY], index) => `${index ? 'L' : 'M'}${pointX.toFixed(1)},${pointY.toFixed(1)}`).join(' ');
        fragments.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`);
      }
      segment = [];
    };
    points.forEach((point, index) => {
      if (Number.isFinite(point[key])) segment.push([x(index), y(point[key])]);
      else flush();
    });
    flush();
    return fragments.join('');
  };
  const grid = Array.from({ length: 4 }, (_, index) => {
    const value = max - ((max - min) * index) / 3;
    const gridY = top + ((height - top - bottom) * index) / 3;
    return `<g><line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" stroke="#263137"/><text x="${left - 8}" y="${(gridY + 3).toFixed(1)}" text-anchor="end">${h(formatMoney(value, { digits: 0 }))}</text></g>`;
  }).join('');
  return `<svg class="equity-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${h(points.length ? `${points.length} daily marks for portfolio equity and SPY` : 'Portfolio equity chart')}"><g class="equity-grid">${grid}</g>${pathsFor('benchmarkEquity', '#8c9ca4')}${pathsFor('equity', '#52c3a2')}<text class="equity-date" x="${left}" y="${height - 5}">${h(points[0]?.date || '')}</text><text class="equity-date" x="${width - right}" y="${height - 5}" text-anchor="end">${h(points.at(-1)?.date || '')}</text></svg>`;
}

function activityPage(state) {
  if (!state.user) return authGate('The paper execution ledger is access controlled.', 'Sign in to review trade history recorded for your account.');
  if (state.role === 'pending') return memberGate();
  const trades = state.trades;
  const query = String(state.tradeSearch || '').trim().toLowerCase();
  const filteredTrades = trades.filter((trade) => {
    const member = memberName(state, trade.author_id).toLowerCase();
    return (!query || trade.symbol.toLowerCase().includes(query) || member.includes(query) || String(trade.proposal_id).toLowerCase().includes(query))
      && (state.tradeFilterSide === 'all' || trade.side === state.tradeFilterSide);
  }).sort((left, right) => {
    if (state.tradeSort === 'oldest') return new Date(left.created_at) - new Date(right.created_at);
    if (state.tradeSort === 'value-high') return Number(right.quantity) * Number(right.price) - Number(left.quantity) * Number(left.price);
    if (state.tradeSort === 'value-low') return Number(left.quantity) * Number(left.price) - Number(right.quantity) * Number(right.price);
    return new Date(right.created_at) - new Date(left.created_at);
  });
  return `
    ${heading('AUDIT JOURNAL / MANAGER RECORDED FILLS', 'Activity<span class="heading-period">.</span>', can(state, 'paper_trades.read_all') ? 'Club fills are linked to their approved proposal and attributed to the recording manager.' : 'Your recorded fills, with price, side, quantity, and proposal link.', `<span class="source-label source-neutral">${trades.length} LEDGER ENTRIES</span>`)}
    <section class="panel ledger-table-panel"><div class="panel-heading"><div><div class="eyebrow">${can(state, 'paper_trades.read_all') ? 'CLUB LEDGER' : 'MY PAPER LEDGER'}</div><h2>Execution history</h2></div><button class="button" type="button" data-action="export-trades">Export CSV ↓</button></div>
      <div class="trade-filters"><label>SEARCH / SYMBOL, MEMBER, PROPOSAL<input id="trade-filter-symbol" value="${h(state.tradeSearch || '')}" placeholder="Filter ledger" autocomplete="off"></label><label>SIDE<select id="trade-filter-side"><option value="all" ${state.tradeFilterSide === 'all' ? 'selected' : ''}>All sides</option><option value="buy" ${state.tradeFilterSide === 'buy' ? 'selected' : ''}>Buy</option><option value="sell" ${state.tradeFilterSide === 'sell' ? 'selected' : ''}>Sell</option></select></label><label>SORT BY<select id="trade-sort"><option value="newest" ${state.tradeSort === 'newest' ? 'selected' : ''}>Newest first</option><option value="oldest" ${state.tradeSort === 'oldest' ? 'selected' : ''}>Oldest first</option><option value="value-high" ${state.tradeSort === 'value-high' ? 'selected' : ''}>Largest notional</option><option value="value-low" ${state.tradeSort === 'value-low' ? 'selected' : ''}>Smallest notional</option></select></label><span>${filteredTrades.length} / ${trades.length} entries</span><button type="button" class="text-action" data-action="clear-trade-filters">Reset</button></div>
      <div class="table-frame"><table class="data-table"><thead><tr><th>Recorded</th><th>Security</th><th>Account</th><th>Side</th><th>Shares</th><th>Fill price</th><th>Notional</th><th>Proposal</th></tr></thead><tbody>${filteredTrades.length ? filteredTrades.map((trade) => `<tr><td>${h(formatTime(trade.created_at))}</td><td><button class="instrument-select single-line" data-action="open-symbol" data-symbol="${h(trade.symbol)}"><b>${h(trade.symbol)}</b></button></td><td>${h(memberName(state, trade.author_id))}</td><td class="side-${h(trade.side)}">${h(trade.side.toUpperCase())}</td><td class="numeric">${formatNumber(trade.quantity, 4)}</td><td class="numeric">${formatMoney(trade.price)}</td><td class="numeric">${formatMoney(Number(trade.quantity) * Number(trade.price))}</td><td><a class="inline-link" href="#proposals">${h(String(trade.proposal_id).slice(0, 8))} ↗</a></td></tr>`).join('') : `<tr><td colspan="8" class="empty-cell">${trades.length ? 'No trades match these filters.' : 'No paper fills recorded.'}</td></tr>`}</tbody></table></div>
    </section>
    <div class="data-footnote">APPROVED PROPOSAL → MANAGER-ENTERED PAPER FILL → IMMUTABLE TRADE ROW.</div>
  `;
}

function managerPage(state) {
  if (!can(state, 'proposals.review')) return authGate('Manager desk is restricted.', 'Only members with proposal-review permission can view the review queue and club ledger.');
  const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
  const open = state.proposals.filter((proposal) => proposal.status === 'approved');
  const participation = calculateClubActivity(state.trades, (userId) => memberName(state, userId));
  const today = new Date();
  const todaysFills = state.trades.filter((trade) => new Date(trade.created_at).toDateString() === today.toDateString()).length;
  return `
    ${heading('MANAGER CONSOLE / CLUB CONTROL', 'Manager desk<span class="heading-period">.</span>', 'Review intern research, manage membership, and record paper execution after approval.', `<a class="button" href="#members">Open member roster ↗</a>`)}
    <div class="manager-kpis">${summaryMetric('Pending decisions', String(pending.length).padStart(2, '0'), 'Awaiting manager review', pending.length ? 'is-warning' : '')}${summaryMetric('Approved / unfilled', String(open.length).padStart(2, '0'), 'Ready for manual paper entry', '')}${summaryMetric('Club paper fills', String(state.trades.length).padStart(2, '0'), `${todaysFills} recorded today`, '')}${summaryMetric('Active members', String(state.members.filter((member) => member.role).length).padStart(2, '0'), `${state.members.filter((member) => !member.role).length} pending activation`, '')}</div>
    <div class="manager-grid"><section class="panel review-queue"><div class="panel-heading"><div><div class="eyebrow">DECISIONS REQUIRED</div><h2>Pending research</h2></div><span class="quiet-count">${pending.length}</span></div>${pending.length ? `<div class="proposal-list">${pending.map((proposal) => compactProposal(proposal, true)).join('')}</div>` : `<div class="table-empty"><b>No proposals need review.</b><span>New intern submissions will appear here.</span></div>`}</section>
      <section class="panel execution-queue"><div class="panel-heading"><div><div class="eyebrow">APPROVED THESIS / PAPER EXECUTION</div><h2>Ready to record</h2></div><span class="quiet-count">${open.length}</span></div>${open.length ? `<div class="proposal-list">${open.map((proposal) => compactProposal(proposal, true)).join('')}</div>` : `<div class="table-empty"><b>No approved proposals are waiting.</b><span>When you approve an idea, record the simulated fill price in the proposal queue.</span></div>`}</section>
    </div>
    <div class="manager-bottom-grid"><section class="panel manager-recent"><div class="panel-heading"><div><div class="eyebrow">RECENT EXECUTIONS</div><h2>Latest fills</h2></div><a href="#activity" class="inline-link">View full ledger ↗</a></div>${state.trades.length ? `<div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Symbol</th><th>Intern</th><th>Side</th><th>Quantity</th><th>Fill</th><th>Recorded by</th></tr></thead><tbody>${state.trades.slice(0, 7).map((trade) => `<tr><td>${h(relativeTime(trade.created_at))}</td><td><b>${h(trade.symbol)}</b></td><td>${h(memberName(state, trade.author_id))}</td><td class="side-${h(trade.side)}">${h(trade.side.toUpperCase())}</td><td class="numeric">${formatNumber(trade.quantity, 4)}</td><td class="numeric">${formatMoney(trade.price)}</td><td>${h(memberName(state, trade.executed_by))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="table-empty"><b>No executions recorded.</b><span>Approvals and manual paper entries will be logged here.</span></div>'}</section>
      <section class="panel member-activity"><div class="panel-heading"><div><div class="eyebrow">MEMBER PARTICIPATION / NOT RETURNS</div><h2>Trading activity</h2></div><a class="inline-link" href="#members">Roster ↗</a></div>${participation.length ? `<div class="table-frame"><table class="data-table"><thead><tr><th>Member</th><th>Fills</th><th>Buys / sells</th><th>Notional</th></tr></thead><tbody>${participation.slice(0, 8).map((member) => `<tr><td>${h(member.name)}</td><td class="numeric">${member.count}</td><td class="numeric">${member.buys} / ${member.sells}</td><td class="numeric">${formatMoney(member.notional)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="table-empty"><b>No member activity yet.</b><span>Notional tracks recorded trade size only. It is not a return ranking.</span></div>'}<div class="manager-footnote">NOTIONAL IS PAPER FILL SIZE; IT DOES NOT MEASURE PERFORMANCE.</div></section></div>
  `;
}

function membersPage(state) {
  if (!can(state, 'members.read')) return authGate('Member roster is restricted.', 'The roster contains private account details.');
  const members = state.members;
  const canManage = can(state, 'members.manage');
  return `
    ${heading('MEMBER DIRECTORY / CLUB TEAMS', 'Members<span class="heading-period">.</span>', canManage ? 'Manage member roles in Users & Permissions; changes are checked by Postgres and written to the audit log.' : 'Your club account and currently active members.', `<span class="source-label source-neutral">${members.length} ACTIVE ACCOUNTS</span>`)}
    ${state.role === 'manager' ? '<section class="panel bootstrap-owner"><div><b>Initialize the club Owner</b><p>One-time setup is limited to the email configured in Supabase Edge Function secrets and is disabled after an Owner exists.</p></div><button class="button button-accent" type="button" data-action="bootstrap-owner">Set up Owner ↗</button></section>' : ''}
    <section class="panel member-roster"><div class="panel-heading"><div><div class="eyebrow">CLUB ROSTER</div><h2>Active accounts</h2></div><span class="quiet-count">${members.length}</span></div>
      ${members.length ? `<div class="table-frame"><table class="data-table"><thead><tr><th>Member</th><th>Access</th><th>Joined</th><th>Role controls</th></tr></thead><tbody>${members.map((member) => {
        const fullName = member.full_name || member.email?.split('@')[0] || 'New member';
        const controls = canManage
          ? `<form class="role-assignment" data-form="member-role" data-user-id="${h(member.user_id)}"><select name="role" aria-label="Role for ${h(fullName)}"><option value="intern" ${member.role === 'intern' ? 'selected' : ''}>Intern</option><option value="manager" ${member.role === 'manager' ? 'selected' : ''}>Manager</option><option value="quant" ${member.role === 'quant' ? 'selected' : ''}>Quant</option><option value="owner" ${member.role === 'owner' ? 'selected' : ''}>Owner</option></select><button class="button compact">Save</button></form>`
          : '<span class="self-role">Owner controls</span>';
        return `<tr><td><div class="member-cell"><span class="avatar small-avatar">${h(fullName.slice(0, 1).toUpperCase())}</span><span><b>${h(fullName)}</b><small>${h(member.email || '')}</small></span></div></td><td><span class="role-tag role-${h(member.role || 'pending')}">${h(member.role || 'pending')}</span>${member.team ? `<small class="member-state">${h(member.team)}</small>` : ''}</td><td>${h(member.joined_at ? formatTime(member.joined_at, { dateOnly: true }) : '—')}</td><td>${controls}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="table-empty"><b>No active users have signed in yet.</b><span>The first Owner can initialize the account after the initial email is configured.</span></div>'}
    </section>
    <div class="data-footnote">REMOVING MEMBERS DISABLES ACCESS WHILE PRESERVING THEIR RESEARCH AND PAPER-TRADE HISTORY.</div>
  `;
}

function quantPage(state) {
  if (!can(state, 'quant.experiments.run')) return authGate('Quant Lab is restricted.', 'HTQF members with experiment access can run models and analyze historical bars.');
  const mark = Number(state.market.quotes.get(state.symbol)?.price || 0);
  const initialPrice = state.quantResults?.parameters?.initialPrice || (mark > 0 ? mark : 100);
  const result = state.quantResults;
  const backtest = state.quantBacktest;
  const finalPrices = result?.finalPrices || [];
  const sorted = [...finalPrices].sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] : null;
  const p10 = percentile(0.1);
  const median = percentile(0.5);
  const p90 = percentile(0.9);
  const above = sorted.length ? sorted.filter((price) => price > initialPrice).length / sorted.length : null;
  return `
    ${heading('HTQF / MODEL, SIMULATE, RISK-MANAGE', 'Quant Lab<span class="heading-period">.</span>', 'Educational GBM scenarios, historical strategy tests, and transparent risk metrics. Model paths are scenarios, never forecasts.')}
    <div class="quant-lab-grid">
      <section class="panel quant-model-panel">
        <div class="panel-heading"><div><div class="eyebrow">GEOMETRIC BROWNIAN MOTION / MONTE CARLO</div><h2>Price-path scenarios</h2></div><span class="source-label ${state.market.source === 'iex' ? 'source-connected' : 'source-simulated'}">${state.market.source === 'iex' ? 'IEX REFERENCE' : 'USER-SET MODEL INPUT'}</span></div>
        <p class="quant-intro">Each path compounds percentage shocks, so simulated prices remain positive. Drift and volatility are assumptions you choose; they are not estimated market forecasts.</p>
        <form class="quant-inputs" data-form="quant-simulation">
          <label>INITIAL PRICE / USD<input name="initialPrice" type="number" min="0.01" max="1000000" step="0.01" value="${Number(initialPrice).toFixed(2)}" required></label>
          <label>ANNUAL DRIFT / %<input name="drift" type="number" min="-100" max="200" step="0.1" value="8" required></label>
          <label>ANNUAL VOLATILITY / %<input name="volatility" type="number" min="0" max="300" step="0.1" value="25" required></label>
          <label>HORIZON / YEARS<input name="horizonYears" type="number" min="0.1" max="10" step="0.1" value="1" required></label>
          <label>PATHS<input name="pathCount" type="number" min="25" max="1000" step="25" value="250" required></label>
          <label>TIME STEPS<input name="steps" type="number" min="12" max="1000" step="12" value="252" required></label>
          <button class="button button-accent" type="submit">Run model ↗</button>
        </form>
        ${result ? `<div class="quant-chart-wrap">${renderSimulationChart(result)}<div class="quant-chart-axis"><span>NOW</span><span>${result.parameters.horizonYears} YR HORIZON</span></div></div>
        <div class="quant-summary-grid">${quantMetric('P10 terminal', formatMoney(p10))}${quantMetric('Median terminal', formatMoney(median))}${quantMetric('P90 terminal', formatMoney(p90))}${quantMetric('Above start', formatPercent(above * 100))}</div>` : '<div class="table-empty quant-empty"><b>No scenario has been run.</b><span>Set assumptions above and run 250 reproducible paths. Results stay in this browser session.</span></div>'}
        <div class="quant-footnote">GBM ASSUMES INDEPENDENT NORMAL SHOCKS, CONSTANT DRIFT AND VOLATILITY, NO FEES, DIVIDENDS, JUMPS, OR STOCHASTIC VOLATILITY.</div>
      </section>
      <section class="panel backtest-panel">
        <div class="panel-heading"><div><div class="eyebrow">HISTORICAL TEST / NO LOOK-AHEAD SIGNALS</div><h2>SMA crossover</h2></div><span class="source-label ${state.quantHistorySource === 'Alpaca IEX' ? 'source-connected' : 'source-simulated'}">${h(state.quantHistorySource || 'TRAINING DATA')}</span></div>
        <p class="quant-intro">A simple long-or-cash moving-average test. A signal uses the previous close and enters at the next session's open. Results are sensitive to the selected period and omit fees, slippage, and dividends.</p>
        <form class="backtest-inputs" data-form="quant-backtest">
          <label>FAST SMA<input name="shortWindow" type="number" min="2" max="100" step="1" value="20" required></label>
          <label>SLOW SMA<input name="longWindow" type="number" min="3" max="240" step="1" value="50" required></label>
          <button class="button" type="submit">Run on ${h(state.symbol)} ↗</button>
        </form>
        ${backtest ? `<div class="backtest-results"><div class="quant-summary-grid">${quantMetric('Strategy return', formatPercent(backtest.strategy.cumulativeReturn * 100))}${quantMetric(backtest.benchmarkName || 'Buy & hold', formatPercent(backtest.benchmark.cumulativeReturn * 100))}${quantMetric('Annualized vol.', backtest.strategy.annualizedVolatility === null ? '—' : formatPercent(backtest.strategy.annualizedVolatility * 100))}${quantMetric('Max drawdown', formatPercent(backtest.strategy.maxDrawdown * 100))}${quantMetric('Sharpe ratio', backtest.strategy.sharpeRatio === null ? '—' : backtest.strategy.sharpeRatio.toFixed(2))}${quantMetric('Signals', String(backtest.trades.length))}</div><p class="backtest-source">Data: ${h(backtest.source)} · ${backtest.strategy.observations} daily observations. Compare windows only when start/end dates match.</p></div>` : '<div class="table-empty quant-empty"><b>No backtest has been run.</b><span>Historical IEX bars are used when connected. Otherwise the app labels a deterministic training series.</span></div>'}
        <div class="quant-footnote">PAST RETURNS DO NOT PREDICT FUTURE RESULTS. THIS TEST IS FOR METHODS PRACTICE, NOT A TRADE SIGNAL.</div>
      </section>
    </div>
  `;
}

function renderSimulationChart(result) {
  const width = 720;
  const height = 205;
  const plotted = result.paths.slice(0, 32);
  const values = plotted.flat();
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, max * 0.04, 0.01);
  const y = (value) => height - ((value - min) / span) * height;
  const colors = ['#d8b36f','#70b9a3','#7da8cf','#c48072','#a995c9','#b0c788'];
  const lines = plotted.map((path, index) => {
    const points = path.map((value, step) => `${(step / (path.length - 1)) * width},${y(value).toFixed(1)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${colors[index % colors.length]}" stroke-opacity=".42" stroke-width="1"/>`;
  }).join('');
  return `<svg class="quant-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Monte Carlo geometric Brownian motion scenario paths"><line x1="0" x2="${width}" y1="${y(result.parameters.initialPrice).toFixed(1)}" y2="${y(result.parameters.initialPrice).toFixed(1)}" stroke="#68757a" stroke-dasharray="4 5"/>${lines}</svg>`;
}

function quantMetric(label, value) {
  return `<div class="quant-metric"><small>${h(label)}</small><b>${h(value)}</b></div>`;
}

function adminPage(state) {
  if (!can(state, 'members.manage')) return authGate('Owner access required.', 'Only the Owner can invite members, assign roles, configure per-user permissions, and view the audit log.');
  const assignable = OWNER_ASSIGNABLE_PERMISSIONS;
  const rosterRows = state.adminMembers.map((member) => {
    const explicit = member.permissions || {};
    const active = member.active;
    const roleForm = `<form class="role-assignment" data-form="member-role" data-user-id="${h(member.user_id)}"><select name="role" aria-label="Role for ${h(member.full_name || member.email)}"><option value="intern" ${member.role === 'intern' ? 'selected' : ''}>Intern</option><option value="manager" ${member.role === 'manager' ? 'selected' : ''}>Manager</option><option value="quant" ${member.role === 'quant' ? 'selected' : ''}>Quant</option><option value="owner" ${member.role === 'owner' ? 'selected' : ''}>Owner</option></select><button class="button compact">Save role</button></form>`;
    const activeManagers = state.adminMembers.filter((candidate) => candidate.active && candidate.role === 'manager');
    const teamCode = member.team || (member.role === 'intern' ? 'HTIG' : 'HTQF');
    const teamOptions = member.role === 'quant'
      ? '<option value="HTQF" selected>HTQF · Quant Group</option>'
      : `<option value="HTIG" ${teamCode === 'HTIG' ? 'selected' : ''}>HTIG · Investment Group</option><option value="HTQF" ${teamCode === 'HTQF' ? 'selected' : ''}>HTQF · Quant Group</option>`;
    const coverage = active && ['intern','quant'].includes(member.role)
      ? `<form class="portfolio-coverage" data-form="portfolio-coverage" data-user-id="${h(member.user_id)}"><label>TEAM<select name="team_code">${teamOptions}</select></label>${member.role === 'intern' ? `<label>ASSIGNED PORTFOLIO MANAGERS<select name="manager_user_ids" multiple size="${Math.max(2, Math.min(4, activeManagers.length || 2))}" aria-label="Assigned managers for ${h(member.full_name || member.email)}">${activeManagers.map((manager) => `<option value="${h(manager.user_id)}" ${(member.assigned_manager_ids || []).includes(manager.user_id) ? 'selected' : ''}>${h(manager.full_name || manager.email)}</option>`).join('')}</select><small>Use Ctrl/Cmd to select more than one.</small></label>` : '<small>HTQF portfolio research is shared with Quant and Manager roles.</small>'}<button class="button compact">Save team / coverage</button></form>`
      : active ? '<span class="self-role">Assign a team to Intern or Quant members.</span>' : '<span class="self-role">Activate a role first.</span>';
    const access = active ? 'ACTIVE' : member.role ? 'REMOVED' : 'INVITED / PENDING';
    const permissionForm = active ? `<form class="permission-assignment" data-form="member-permission" data-user-id="${h(member.user_id)}"><select name="permission_key" aria-label="Permission for ${h(member.email)}">${assignable.map((key) => `<option value="${key}">${h(PERMISSION_LABELS[key])} · ${h(key)}</option>`).join('')}</select><select name="effect" aria-label="Permission setting"><option value="none">Inherit role</option><option value="allow">Allow</option><option value="deny">Deny</option></select><button class="button compact">Save</button></form><div class="permission-badges">${Object.entries(explicit).map(([key, effect]) => `<span class="permission-badge">${h(PERMISSION_LABELS[key] || key)}: ${h(effect)}</span>`).join('') || '<span class="permission-badge inherited">Role defaults only</span>'}</div>` : '<span class="self-role">Activate a role to configure permissions.</span>';
    return `<tr><td><div class="member-cell"><span class="avatar small-avatar">${h((member.full_name || member.email || '?').slice(0,1).toUpperCase())}</span><span><b>${h(member.full_name || member.email || 'Unknown user')}</b><small>${h(member.email || '')}</small></span></div></td><td><span class="role-tag role-${h(member.role || 'pending')}">${h(member.role || 'pending')}</span><small class="member-state">${access}${member.team ? ` · ${h(member.team)}` : ''}</small></td><td>${h(member.joined_at ? formatTime(member.joined_at, { dateOnly: true }) : '—')}</td><td>${roleForm}${active ? `<button class="text-action remove-member" type="button" data-action="remove-member" data-user-id="${h(member.user_id)}">Remove access</button>` : ''}</td><td>${coverage}</td><td>${permissionForm}</td></tr>`;
  }).join('');
  const auditRows = state.auditLog.map((event) => `<tr><td>${h(formatTime(event.created_at))}</td><td>${h(event.action)}</td><td>${h(memberName(state, event.actor_id))}</td><td>${h(memberName(state, event.target_user_id))}</td><td><code>${h(JSON.stringify(event.details || {}))}</code></td></tr>`).join('');
  return `
    ${heading('PLATFORM ADMINISTRATION / OWNER ONLY', 'Users & Permissions<span class="heading-period">.</span>', 'Invite by email, assign club roles, tune delegated capabilities, and review the append-only audit trail.', `<span class="source-label source-neutral">${state.adminMembers.filter((member) => member.active).length} ACTIVE MEMBERS</span>`)}
    <section class="panel invite-panel"><div><div class="eyebrow">MEMBER ACCESS / EMAIL INVITATION</div><h2>Add a club member</h2><p>Invites are sent by Supabase Auth. The role is stored in Postgres and checked on every protected operation.</p></div><form class="invite-form" data-form="owner-invite"><label>EMAIL ADDRESS<input name="email" type="email" autocomplete="email" placeholder="student@school.edu" maxlength="254" required></label><label>ROLE<select name="role"><option value="intern">Intern</option><option value="manager">Manager</option><option value="quant">Quant</option><option value="owner">Owner</option></select></label><button class="button button-accent" type="submit">Invite member</button></form></section>
    <section class="panel admin-roster"><div class="panel-heading"><div><div class="eyebrow">USERS & PERMISSIONS</div><h2>Club access roster</h2></div><span class="quiet-count">${state.adminMembers.length} accounts</span></div>
      <div class="table-frame"><table class="data-table admin-table"><thead><tr><th>Member</th><th>Role / state</th><th>Joined</th><th>Role and access</th><th>Team / portfolio coverage</th><th>Per-user permission override</th></tr></thead><tbody>${rosterRows || '<tr><td colspan="6" class="empty-cell">No Auth accounts are registered yet.</td></tr>'}</tbody></table></div>
    </section>
    <section class="panel admin-audit"><div class="panel-heading"><div><div class="eyebrow">APPEND-ONLY / SECURITY EVENTS</div><h2>Audit log</h2></div><span class="quiet-count">LATEST ${state.auditLog.length}</span></div>
      <div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead><tbody>${auditRows || '<tr><td colspan="5" class="empty-cell">No administrative or trade events are recorded yet.</td></tr>'}</tbody></table></div>
    </section>
    <div class="data-footnote">OWNER-ONLY ROLE CHANGES, OVERRIDES, INVITATIONS, ACCESS REMOVALS, REVIEWS, AND PAPER EXECUTIONS ARE DATABASE-CHECKED AND AUDITED.</div>
  `;
}

function setupPage(state) {
  const connected = state.market.source === 'iex';
  return `
    ${heading('CONNECTIONS / MARKET DATA', 'Feed setup<span class="heading-period">.</span>', 'Use the no-cost Alpaca IEX plan for exchange quotes and historical bars. Keys stay server-side in Supabase.', marketStatus(state))}
    <div class="setup-layout"><section class="panel setup-main"><div class="setup-title"><span class="setup-step">01</span><div><div class="eyebrow">FREE MARKET DATA / EQUITIES</div><h2>${connected ? 'Alpaca IEX is connected' : 'Connect Alpaca IEX'}</h2><p>The free stock-data plan provides real-time prints from IEX only. It is a single exchange feed, not consolidated NYSE/Nasdaq/SIP coverage.</p></div></div>
      <ol class="setup-steps"><li><span>1</span><div><b>Create a free Alpaca account</b><small>Open the Alpaca dashboard and create paper-trading API keys. Choose the paper environment; this app only reads market data.</small><a href="https://app.alpaca.markets/signup" target="_blank" rel="noopener">Alpaca sign-up ↗</a></div></li><li><span>2</span><div><b>Deploy the market-data function</b><small>Publish <code>supabase/functions/market-data/index.ts</code> to project <code>nftmbvwzeahcnfycdoam</code>. The function verifies the Supabase session and club role before it proxies data.</small><code>npx supabase functions deploy market-data --project-ref nftmbvwzeahcnfycdoam</code></div></li><li><span>3</span><div><b>Add server secrets in Supabase</b><small>Supabase → Edge Functions → Secrets. Add your Alpaca paper API key ID and secret as these names:</small><code>ALPACA_API_KEY_ID<br>ALPACA_API_SECRET_KEY</code></div></li><li><span>4</span><div><b>Refresh the terminal</b><small>Secrets never go into Vite, GitHub, or the browser bundle. Return to Markets and refresh; the status changes to Alpaca IEX when a valid snapshot arrives.</small><button class="text-action" type="button" data-action="retry-data">Test connection ↗</button></div></li></ol>
    </section><aside class="panel setup-side"><div class="eyebrow">CURRENT FEED STATE</div><h2>${connected ? 'Connected' : 'Training tape active'}</h2><p>${connected ? 'The terminal is receiving Alpaca IEX snapshots. The source timestamp is shown next to each selected security.' : 'A synthetic training model is active so the interface remains usable. It is not live, delayed, or historical market data.'}</p><div class="feed-status-card ${connected ? 'connected' : 'simulated'}"><i></i><div><b>${connected ? 'ALPACA IEX' : 'SYNTHETIC TRAINING'}</b><span>${connected ? `Last response ${state.market.asOf ? relativeTime(state.market.asOf) : 'just now'}` : 'Do not use values for proposal fills'}</span></div></div><div class="data-notes"><b>What the IEX feed means</b><p>Quotes and bars represent the IEX exchange. Trading volume and last price can differ from consolidated US market totals. Club paper fills remain manually entered by a manager.</p><a href="https://docs.alpaca.markets/us/docs/about-market-data-api" target="_blank" rel="noopener">Alpaca market-data plans ↗</a><a href="https://docs.alpaca.markets/us/docs/market-data-faq" target="_blank" rel="noopener">Feed coverage FAQ ↗</a></div></aside></div>
    <section class="panel integration-note"><div><div class="eyebrow">CHART ENGINE / OPEN SOURCE</div><h2>Interactive candles, rendered in the app</h2><p>The terminal draws candlesticks, volume, crosshair readouts, and moving averages locally with TradingView Lightweight Charts. No chart iframe or hosted widget supplies the interface.</p></div><span class="source-label source-neutral">TradingView Lightweight Charts™</span></section>
  `;
}

function compactProposal(proposal, link = false) {
  const row = `<div class="compact-proposal"><span class="proposal-symbol">${h(proposal.symbol)}</span><span class="compact-copy"><b>${h(proposal.side.toUpperCase())} / ${formatNumber(proposal.quantity, 4)} sh.</b><small>${h(String(proposal.thesis || '').slice(0, 90))}${proposal.thesis?.length > 90 ? '…' : ''}</small></span><span class="status-tag status-${h(proposal.status)}">${h(proposal.status)}</span></div>`;
  return link ? `<a class="compact-proposal-link" href="#proposals">${row}</a>` : row;
}

function compactTrade(state, trade) {
  return `<div class="compact-trade"><span class="trade-side-marker side-${h(trade.side)}">${trade.side === 'buy' ? 'B' : 'S'}</span><span><b>${h(trade.symbol)} <i>·</i> ${h(trade.side.toUpperCase())}</b><small>${h(memberName(state, trade.author_id))} / ${h(relativeTime(trade.created_at))}</small></span><strong>${formatMoney(Number(trade.price) * Number(trade.quantity))}</strong></div>`;
}

function memberName(state, userId) {
  if (!userId) return 'Club member';
  if (userId === state.user?.id) return 'You';
  const member = state.members.find((item) => item.user_id === userId);
  return member?.full_name || member?.email || `Member ${String(userId).slice(0, 7)}`;
}

function authGate(title, description) {
  return `<section class="panel access-gate"><span class="gate-kicker">MEMBER ACCESS</span><h2>${h(title)}</h2><p>${h(description)}</p><button class="button button-accent" type="button" data-action="signin">Sign in or create account ↗</button></section>`;
}

function memberGate() {
  return `<section class="panel access-gate"><span class="gate-kicker">PENDING ACTIVATION</span><h2>Your club role is not active yet.</h2><p>Ask the club Owner to assign your account as a Manager, Intern, or Quant. The database withholds shared records until your membership is active.</p><a href="#setup" class="inline-link">Explore data setup ↗</a></section>`;
}

function renderProposalDialog(state) {
  const suggestedSymbol = state.proposalSymbol || state.symbol || '';
  return `<dialog id="proposal-dialog" aria-labelledby="proposal-title"><form id="proposal-form" data-form="proposal">
    <div class="dialog-top"><div><div class="eyebrow">RESEARCH SUBMISSION / NEW IDEA</div><h2 id="proposal-title">Write an investment thesis</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Close dialog">×</button></div>
    <p class="dialog-intro">A manager reviews the reasoning and risk before any paper trade is recorded. This submission does not place an order.</p>
    <label>SECURITY<input name="symbol" value="${h(suggestedSymbol)}" maxlength="12" pattern="[A-Za-z0-9.\-]{1,12}" placeholder="e.g. NVDA" required></label>
    <div class="form-two"><label>PROPOSED SIDE<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label>SHARES<input name="quantity" type="number" min="0.0001" max="1000000" step="any" placeholder="0.00" required></label></div>
    <div class="proposal-pricing-grid"><label>ENTRY PRICE / USD<input name="entry_price" type="number" min="0.0001" max="99999999" step="any" placeholder="0.00" required></label><label>TARGET PRICE / USD<input name="target_price" type="number" min="0.0001" max="99999999" step="any" placeholder="0.00" required></label><label>STOP-LOSS / USD<input name="stop_loss" type="number" min="0.0001" max="99999999" step="any" placeholder="0.00" required></label></div>
    <div class="form-two"><label>TIME HORIZON<select name="time_horizon" required><option value="">Select horizon</option><option value="intraday">Intraday</option><option value="swing">Swing · days/weeks</option><option value="short-term">Short term · weeks/months</option><option value="long-term">Long term · 1+ years</option></select></label><label>PORTFOLIO ALLOCATION / %<input name="allocation_pct" type="number" min="0.01" max="100" step="0.01" placeholder="Optional"></label></div>
    <label>THESIS / CATALYST<textarea name="thesis" minlength="20" maxlength="4000" rows="5" placeholder="What does the market miss? State the thesis, catalyst, and why this horizon fits." required></textarea><small>20–4,000 characters</small></label>
    <label>RISK / INVALIDATION<textarea name="risks" minlength="1" maxlength="2000" rows="3" placeholder="What would make you change your view?" required></textarea></label>
    <label>SUPPORTING RESEARCH / HTTPS LINK<input name="research_url" type="url" maxlength="2048" placeholder="https://…"><small>Link to a filing, article, or your research document</small></label>
    <div class="dialog-actions"><button class="button" type="button" data-action="close-dialog">Cancel</button><button class="button button-accent">Submit for review ↗</button></div>
  </form></dialog>`;
}

function renderAuthDialog(state) {
  const mode = state.authMode || 'sign-in';
  const recovery = mode === 'recovery';
  const reset = mode === 'reset';
  const signUp = mode === 'sign-up';
  const title = recovery ? 'Choose a new password' : reset ? 'Reset your password' : signUp ? 'Create your member account' : 'Sign in to the terminal';
  const action = recovery ? 'Update password' : reset ? 'Send reset link' : signUp ? 'Create account' : 'Sign in';
  return `<dialog id="auth-dialog" class="auth-dialog" aria-labelledby="auth-title">
    <div class="dialog-top"><div><div class="eyebrow">HTIG · HTQF / MEMBER ACCESS</div><h2 id="auth-title">${h(title)}</h2></div><button class="dialog-close" type="button" data-action="close-auth" aria-label="Close sign in">×</button></div>
    ${!recovery ? `<div class="auth-modes"><button class="${signUp ? '' : 'selected'}" type="button" data-action="auth-mode" data-mode="sign-in">Sign in</button><button class="${signUp ? 'selected' : ''}" type="button" data-action="auth-mode" data-mode="sign-up">Create account</button></div>` : ''}
    <form class="auth-form" data-form="email-auth">
      ${recovery ? `<label>NEW PASSWORD<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>` : `<label>EMAIL ADDRESS<input name="email" type="email" autocomplete="email" maxlength="254" required></label>${reset ? '' : `<label>PASSWORD<input name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" minlength="8" required></label>`}`}
      ${state.authMessage ? `<p class="auth-message" role="status">${h(state.authMessage)}</p>` : ''}
      <button class="button button-accent auth-submit" type="submit">${h(action)} ↗</button>
    </form>
    ${!recovery && !reset ? `<button class="button auth-google" type="button" data-action="google-signin">Continue with Google ↗</button>` : ''}
    ${mode === 'sign-in' ? '<button class="text-action auth-secondary" type="button" data-action="auth-mode" data-mode="reset">Forgot password?</button>' : reset ? '<button class="text-action auth-secondary" type="button" data-action="auth-mode" data-mode="sign-in">Back to sign in</button>' : ''}
    <p class="auth-footnote">New accounts need an Owner to assign their club role before shared proposals or portfolios unlock.</p>
  </dialog>`;
}

function titleCase(value) {
  return value[0].toUpperCase() + value.slice(1);
}
