# Biotech dashboard

Pharmaceutical and biotech investment dashboard served at `/biotech` on jiayangzh.com, with an admin area at `/biotech/admin`.

**Status: Phase 1 of 3.** Built and tested: shared foundations and Module A (Stock Performance Tracker). Not built yet: Module C (Catalyst Calendar, Phase 2) and Module B (Clinical Trial Intelligence Feed, Phase 3).

## Architecture

The site is a static Jekyll build on GitHub Pages, which cannot run server code. The dashboard is therefore split in two:

| Part | Where it runs | Code |
|---|---|---|
| Frontend (Preact + TypeScript) | Bundled into `assets/biotech/`, loaded only by the two `/biotech` pages | `web/` |
| API, scheduled jobs, database | One Cloudflare Worker at `api.jiayangzh.com` with a D1 (SQLite) database | `worker/` |
| Types, configuration, calculations | Imported by both | `shared/` |

- Visitors never trigger provider calls. A cron job writes quotes to D1; `GET /v1/market` reads D1 through a short cache.
- Every `/admin/*` route goes through one middleware: rate limit, then authentication, then a CSRF check for writes.
- Authentication is Cloudflare Access. The Worker verifies the Access JWT with `jose` and checks the email against an allow-list. There is no password handling in this code.
- All non-secret settings live in `shared/config.ts`. It is bundled into the public frontend, so it must never hold secrets.

Files changed outside this folder: `_tabs/biotech.md`, `biotech/admin.md`, `_includes/biotech-app.html`, `_config.yml` (exclude entry and `biotech.api_base`), `.gitignore`, `.github/workflows/pages-deploy.yml` (Node build step).

## Local development

```bash
cd biotech-app
npm install
cp worker/.dev.vars.example worker/.dev.vars   # mock data, local admin bypass
npm run migrate:local
npm run dev:worker                             # API on http://localhost:8787
npm run build                                  # or: npm run dev:web
cd .. && bundle exec jekyll s --config _config.yml,biotech-app/_config.dev.yml
```

Open `http://localhost:4000/biotech/`. The table is empty until a refresh runs: open `/biotech/admin/` and press "Refresh prices now". Mock mode shows a MOCK DATA banner.

Checks: `npm run typecheck`, `npm test`, `npm run build && npm run check:bundle`.

## Deployment

### 1. Accounts and keys

| Account | Used for | Secret |
|---|---|---|
| Cloudflare (zone `jiayangzh.com` must be on Cloudflare DNS) | Worker, D1, Access | none in the repo; `wrangler login` |
| Finnhub | Quotes and market cap | `FINNHUB_API_KEY` |

### 2. Database and Worker

```bash
npx wrangler login
npx wrangler d1 create biotech          # copy database_id into worker/wrangler.toml
npm run migrate:remote
npx wrangler secret put FINNHUB_API_KEY --config worker/wrangler.toml
npm run deploy:worker
```

### 3. Administrator account (Cloudflare Access)

1. In the Cloudflare dashboard open Zero Trust, then Access, then Applications, and add a self-hosted application for `api.jiayangzh.com` with path `admin`.
2. Add one Allow policy whose only rule is your email address. Choose a login method (one-time PIN by email needs no extra setup).
3. In the application's CORS settings allow origin `https://jiayangzh.com`, allow credentials, allow the header `X-Biotech-Admin`, and enable the option that passes `OPTIONS` requests through to the origin.
4. Put three values in `[vars]` in `worker/wrangler.toml` and deploy again:
   - `ACCESS_TEAM_DOMAIN`: `https://<your-team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the application's audience (AUD) tag
   - `ADMIN_EMAILS`: your email

Until all three are set, every admin route returns 401. Do not set `DEV_ADMIN_EMAIL` in production; it is only honoured on localhost in any case.

### 4. Site

In the GitHub repository settings, set Pages, Build and deployment, Source to "GitHub Actions". The workflow tests and builds the dashboard, then builds the Jekyll site.

## Configuration variables

| Name | Where | Secret | Purpose |
|---|---|---|---|
| `FINNHUB_API_KEY` | Worker secret | yes | Market data |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS` | `wrangler.toml` vars | no | Admin authentication |
| `ALLOWED_ORIGINS` | `wrangler.toml` vars | no | Browser origins allowed to call the API |
| `DATA_MODE` | `wrangler.toml` vars | no | `live` or `mock` |
| `DEV_ADMIN_EMAIL` | `worker/.dev.vars` only | no | Local admin bypass |
| `biotech.api_base` | `_config.yml` | no | API URL the pages call |

## Market data: budget and conventions

20 tickers (18 companies, 2 benchmarks).

| Call | Frequency | Calls |
|---|---|---|
| Finnhub `/quote`, one per ticker | Every 5 minutes, 09:30 to 16:00 New York, weekdays, plus one run after the close | 20 per run, about 79 runs, about 1,580 a day |
| Finnhub `/stock/profile2`, one per company | Once each weekday | 18 a day |

Peak is 20 calls in one minute against a free-tier limit of about 60 a minute. At 40 tickers the peak is 40 a minute, still inside it. No polling happens outside the session.

- **Daily change** is `(latest price / previous close - 1) * 100`, from Finnhub's `c` and `pc`.
- **Relative performance** is the company's change minus its benchmark's change, in percentage points. It is left as N/A unless both quotes come from the same trading day.
- **Sparkline** uses closes this system records itself after each session, because free access to Finnhub's historical candles is unreliable. It shows N/A until two closes exist and fills over five trading days. These closes are as reported, not split-adjusted: after a split, delete that ticker's rows from `daily_closes`.
- **Market cap** is shown only when Finnhub reports it in USD. No currency conversion is done, so ADRs reported in another currency show N/A. ETFs have none.
- **Holidays** are not modelled. On an exchange holiday the job polls and gets unchanged quotes.

### Not yet verified against a real Finnhub key

Everything above ran against mock data and unit-tested fakes. Before relying on it, confirm with your key that the free tier returns `/quote` for all 20 tickers including the ADRs and ETFs, that `/stock/profile2` returns market cap, and which currency it reports for NVO, AZN, GSK and ARGX. Finnhub's free tier is described as personal use; check its terms for a public site.

### Cloudflare limits

Workers free plan: 100,000 requests a day and 10 ms CPU per invocation. Module A fits. Parsing filings in Phase 3 may need the paid plan (5 USD a month). D1 free plan: 5 million row reads and 100,000 writes a day; this module writes about 3,200 rows a day.

## Requires manual input or later work

- Modules B and C are not implemented.
- Cloudflare Access, D1 and the Finnhub key must be set up by hand as described above.
- Market cap for foreign-currency ADRs, exchange holidays and split adjustment of the sparkline (see above).
- The in-memory rate limiter is a per-isolate fallback; the `WRITE_LIMITER` binding in `wrangler.toml` is the real limit.
