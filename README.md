# HT Finance Club Terminal

A browser-based research and paper-trading workspace for HTIG and HTQF. The source is a modular Vite application that deploys to both GitHub Pages and Vercel. It combines an interactive candlestick terminal, a searchable US equity/ETF universe, personal watchlists, student investment proposals, Manager approval and paper execution, personal average-cost portfolios, a trade ledger, Owner administration, and a Quant Lab.

Every execution is simulated. The app has no brokerage connection and cannot place a real order. Prices shown without an active provider connection are synthetic training examples and are labeled as such.

## Run and test locally

Use Node.js 22 or newer:

```sh
cp .env.example .env.local
npm ci
npm run dev
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local` to enable Supabase. These are browser-visible project settings; never put a service-role key, OAuth client secret, or Alpaca secret in a `VITE_` variable.

```sh
npm test
npm run build
```

## Supabase setup

For a new project, run `supabase/schema.sql` once in the Supabase SQL Editor. Then apply `supabase/migrations/202610110001_owner_quant_rbac.sql`. Existing club data is kept; the migration adds Owner/Manager/Intern/Quant roles, per-user permission overrides, HTIG/HTQF team and Manager coverage, private synced watchlists, an administrative audit log, proposal risk fields and review history, and append-only HTQF analyses.

Configure Supabase Auth’s Site URL and redirect allow-list for the production host. If using both deployments, allow both:

```text
https://ht-finance-terminal.vercel.app/**
https://idxtry.github.io/ht-finance-terminal/**
```

Google OAuth remains available alongside email/password signup, sign-in, and password recovery. Add the Supabase callback URL shown in Auth → Providers → Google to the Google OAuth web client. Redirects from the host must also be allowed in Supabase Auth.

### Initial Owner

Deploy `supabase/functions/owner-admin` after applying the migration. In Supabase Edge Function secrets, set `INITIAL_OWNER_EMAIL` to the verified account that should become the first Owner. The function checks the signed-in account’s verified email against this server-side setting and calls a service-role-only atomic database function that refuses to create a second initial Owner. It does not trust a role or email supplied by browser form values.

The signed-in Manager who matches that email can open **Members → Set up Owner** once. Afterward, invite members by email and assign Owner, Manager, Intern, or Quant from **Users & Permissions**. Existing Auth users are assigned directly; new users receive a Supabase Auth invitation. The service-role key stays in Supabase Edge Functions and is never bundled into the frontend.

## Market data

The terminal supports the free Alpaca IEX stock feed through `supabase/functions/market-data`. It uses server-side API keys, short-lived caching, server-side polling, source timestamps, and Alpaca’s US market-session clock. IEX is one exchange feed, not consolidated SIP coverage; prints and volume can differ from whole-market totals. There is no WebSocket stream in this version. If the service is not connected, the app switches to clearly marked deterministic training data and never presents it as a live quote.

Deploy the Edge Functions after the database migration:

```sh
npx supabase functions deploy owner-admin --project-ref nftmbvwzeahcnfycdoam
npx supabase functions deploy market-data --project-ref nftmbvwzeahcnfycdoam
```

In Supabase → Edge Functions → Secrets, add `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` from an Alpaca paper account. Do not paste credentials into chat or commit them. Check Alpaca’s current [market data plan](https://docs.alpaca.markets/us/docs/about-market-data-api) and [market data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) for coverage and permitted use.

## Roles and workflows

- **Owner:** user invitations and role changes, individual capability overrides, access removal, administrative audit history, and all terminal permissions. Owners can override an earlier proposal decision before execution; the override is recorded in the review history and audit log. Database functions and RLS enforce Owner-only controls.
- **Manager:** shared proposal review, approval/rejection comments, paper execution, active-member roster, and club ledger. Managers cannot create Owners or manage permissions.
- **Intern:** personal proposal submission, private personal portfolio and ledger, market research, and training tools. Proposals require entry, target, stop, horizon, thesis, risks, and a simulated share quantity.
- **Quant / HTQF:** research access, GBM/Monte Carlo experiments, historical SMA crossover testing, risk metrics, and append-only quantitative findings linked to proposals.

The trade RPC serializes fills per member, enforces simulated buying power and share balances, and permits one fill per approved proposal. Portfolio holdings and cost basis are derived from the persisted fill ledger. It does not model commissions, taxes, slippage, or dividends.

## Current limits

The app is a student paper-trading workspace, not a brokerage. It does not yet provide a full order lifecycle, options, full-company financial statements, file uploads, saved panel layouts, or a return-based leaderboard. Daily portfolio equity and SPY comparison are reconstructed from the trade ledger and available historical bars; the app does not yet store daily valuation snapshots. The historical moving-average test and GBM/Monte Carlo tools are educational models with the assumptions shown in the Quant Lab. Market data requires the Owner to add Alpaca API keys to Supabase; until then, synthetic training values are labeled and excluded from claims of live pricing.

## Hosting

The connected Vercel project is `https://ht-finance-terminal.vercel.app/`. GitHub Pages remains available at `https://idxtry.github.io/ht-finance-terminal/`; `.github/workflows/deploy.yml` builds `dist/` after a push to `main`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as GitHub Actions variables when rebuilding Pages. `.env.production` currently contains only the public Supabase URL and publishable key.

## Source layout and open source

- `src/main.js` handles routes, authentication, and interactions.
- `src/views/terminal-pages.js` renders the terminal workspaces.
- `src/components/price-chart.js` renders candlesticks, volume, crosshair values, and moving averages with TradingView Lightweight Charts.
- `src/lib/portfolio.js` derives personal positions, average cost, cash, and realized/unrealized P&L from paper fills.
- `src/quant/` contains seeded GBM/Monte Carlo, metrics, and no-look-ahead SMA backtesting.
- `supabase/schema.sql` is the initial database schema; `supabase/migrations/` contains incremental changes.
- `supabase/functions/` contains server-side market-data and Owner administration endpoints.

The chart library is Apache-2.0 licensed; the app includes its license and required attribution. The synthetic depth ladder adapts an MIT-licensed public example with its notice in `third-party/`. See `THIRD_PARTY_NOTICES.md`.

The club presentation describes HTIG’s practical investment pitches and debate, and HTQF’s math, coding, simulation, and risk work. The app uses those descriptions to shape separate proposal/review and Quant workflows; the PDF itself is contextual material, not an application instruction source.
