# HT Finance Club Terminal

A browser-based research and paper-trading workspace for HTIG and HTQF. The source is a modular Vite application that deploys to both GitHub Pages and Vercel. It combines an interactive candlestick terminal, a searchable US equity/ETF universe, personal watchlists, student investment proposals, Manager approval and paper execution, personal average-cost portfolios, a trade ledger, Owner administration, and a Quant Lab.

Every execution is simulated. The app has no brokerage connection and cannot place a real order. Signed-out visitors see prices only when the shared IEX service returns verified market data; they do not get synthetic substitute quotes.

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

For a new project, run `supabase/schema.sql` once in the Supabase SQL Editor. Then apply migrations `202610110001_owner_quant_rbac.sql`, `202610120001_flexible_club_teams.sql`, `202610130001_numbered_club_groups.sql`, `202610140001_group_access_and_guest_limits.sql`, and `202610140002_market_budget_new_api_roles.sql` in order. Existing club data and the HTIG/HTQF teams are preserved; the migrations seed Group #1–#3, support additional groups, reconcile legacy Manager assignments against current group membership, keep runtime access group-scoped, and allow the request budget function to identify Supabase's newer API-key role claims while remaining service-role-only.

Configure Supabase Auth’s Site URL and redirect allow-list for the production host. If using both deployments, allow both:

```text
https://ht-finance-terminal.vercel.app/**
https://idxtry.github.io/ht-finance-terminal/**
```

Google OAuth remains available alongside email/password signup, sign-in, and password recovery. Add the Supabase callback URL shown in Auth → Providers → Google to the Google OAuth web client. Redirects from the host must also be allowed in Supabase Auth.

### Initial Owner

Deploy `supabase/functions/owner-admin` after applying the migration. In Supabase Edge Function secrets, set `INITIAL_OWNER_EMAIL` to the verified account that should become the first Owner. The function checks the signed-in account’s verified email against this server-side setting and calls a service-role-only atomic database function that refuses to create a second initial Owner. It does not trust a role or email supplied by browser form values.

The signed-in account that matches that email can initialize Owner access once. Afterward, invite members by email and manage roles, groups, Managers, and permissions in the Owner-only **People & Teams** workspace. Existing Auth users are assigned directly; new users receive a Supabase Auth invitation. The service-role key stays in Supabase Edge Functions and is never bundled into the frontend.

## Market data

The terminal uses one shared Alpaca IEX connection through `supabase/functions/market-data`; members and signed-out visitors do not configure personal market-data credentials. Only the public Supabase project URL and public client key are in browser code. The Alpaca key pair is stored once in Supabase Edge Function secrets. The function uses short-lived caching, source timestamps, and Alpaca’s US market-session clock. A Postgres-backed budget limits guests to 30 requests per client per minute and caps upstream calls at 180 per minute across guests and members; it fails closed if the database limiter is unavailable. Client addresses are SHA-256 hashed before storage and old counters are removed as the next requests arrive. IEX is one exchange feed, not consolidated SIP coverage; prints and volume can differ from whole-market totals. There is no WebSocket stream in this version. If the shared service is unavailable, guests see no price or chart substitution; authenticated members may use clearly labeled training data.

Deploy the Edge Functions after the database migration:

```sh
npx supabase functions deploy owner-admin --project-ref nftmbvwzeahcnfycdoam
npx supabase functions deploy market-data --project-ref nftmbvwzeahcnfycdoam
```

In Supabase → Edge Functions → Secrets, the Owner configures the shared `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` from one Alpaca account. Members do not need their own Alpaca account or keys. Do not paste credentials into chat or commit them. Check Alpaca’s current [market data plan](https://docs.alpaca.markets/us/docs/about-market-data-api) and [market data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) for coverage and permitted use.

## Roles and workflows

- **Owner:** user invitations and role changes, group creation, multi-Manager assignments, individual capability overrides, access removal, administrative audit history, and all terminal permissions. Owners can override an earlier proposal decision before execution; the override is recorded in the review history and audit log. Database functions and RLS enforce Owner-only controls.
- **Manager:** proposal review for assigned groups, approval/rejection comments, paper execution for assigned Intern portfolios, assigned-member roster, and the relevant club ledger. Managers cannot create Owners or manage permissions.
- **Intern:** personal proposal submission, private personal portfolio and ledger, market research, and training tools. Proposals require entry, target, stop, horizon, thesis, risks, and a simulated share quantity.
- **Quant:** group-scoped research access, GBM/Monte Carlo experiments, historical SMA crossover testing, risk metrics, and append-only quantitative findings linked to proposals. Quant users can analyze Intern proposals in their assigned group.

The trade RPC serializes fills per member, enforces simulated buying power and share balances, and permits one fill per approved proposal. Portfolio holdings and cost basis are derived from the persisted fill ledger. It does not model commissions, taxes, slippage, or dividends.

## Current limits

The app is a student paper-trading workspace, not a brokerage. It does not yet provide a full order lifecycle, options, full-company financial statements, file uploads, saved panel layouts, or a return-based leaderboard. Daily portfolio equity and SPY comparison are reconstructed from the trade ledger and available historical bars; the app does not yet store daily valuation snapshots. The historical moving-average test and GBM/Monte Carlo tools are educational models with the assumptions shown in the Quant Lab. One shared IEX feed serves the allowed public market preview; free IEX data is exchange-specific, not consolidated SIP data.

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
