# Biotech dashboard

Pharmaceutical and biotech investment dashboard served at `/biotech` on jiayangzh.com, with an admin area at `/biotech/admin`.

**Status: all three modules built.** Module A (Stock Performance Tracker), Module C (Catalyst Calendar) and Module B (Clinical Trial Intelligence Feed). Nothing is deployed until the steps under Deployment are done. What has and has not been verified against live services is listed under "Verification status".

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
| Anthropic | Classifying filings for the clinical feed | `ANTHROPIC_API_KEY` |
| SEC EDGAR | Filings (no account) | none; needs `SEC_USER_AGENT` with your contact email |
| ClinicalTrials.gov | Estimated readouts | none needed |

### 2. Database and Worker

```bash
npx wrangler login
npx wrangler d1 create biotech          # copy database_id into worker/wrangler.toml
npm run migrate:remote
npx wrangler secret put FINNHUB_API_KEY --config worker/wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY --config worker/wrangler.toml
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
| `ANTHROPIC_API_KEY` | Worker secret | yes | Clinical event classifier. Without it filings are collected but not classified |
| `SEC_USER_AGENT` | `wrangler secret put` | no (kept private) | Identifies you to SEC, e.g. `jiayangzh.com biotech dashboard (you@example.com)`. EDGAR is not called until it contains an email address |
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

## Catalyst calendar

Shows events for watchlist companies from 30 days back (labelled overdue) to 90 days ahead.

| Event type | Where it comes from |
|---|---|
| PDUFA target action dates | Manual entry only. No free API publishes them reliably. |
| FDA advisory committee meetings | Manual entry only. |
| Expected data readouts | Manual entry, plus estimates generated from ClinicalTrials.gov |

**Registry estimates.** Once an hour the Worker asks ClinicalTrials.gov (API v2, no key) for each company's Phase II and III trials whose primary completion date falls in the window: 18 requests an hour, about 430 a day. Checked against the live API on 2026-10-10 this produced 90 entries for 14 of the 18 companies.

- Entries are labelled Estimated and state that the primary completion date is not a results date.
- The registry often gives only a month. Those entries are shown as a whole-month range.
- When a registry date moves, the entry shows "Date changed" with the old date for 30 days. When a trial leaves the window it is removed. If a company's request fails, its entries are left as they were.
- Phase I/II trials are excluded unless `clinical.includePhase1_2Trials` is set.
- Only trials where the company is lead sponsor are found. Partnered trials led by another sponsor, and trials under a subsidiary name missing from `registrySponsors` in `shared/config.ts`, are not.
- A manual entry carrying the same NCT number replaces the estimate for that trial.

**Manual entries** are managed at `/biotech/admin` and stored in D1. Required fields: company, programme, event type, date, verification status. Notes are admin-only and never sent to visitors. Saving an entry sets its "last verified" date. Registry entries cannot be edited or deleted directly.

The public feed is cached by browsers for 60 seconds, so an admin change can take up to a minute to appear on `/biotech`.

## Clinical trial feed

Tracks five kinds of event for watchlist companies: Phase II success, Phase II failure, Phase III initiation, Phase III success, Phase III failure.

### Pipeline

1. **Discover.** Every hour the Worker reads each company's filing list from SEC EDGAR (18 requests) and records new 8-Ks, or 6-Ks for NVO, AZN, GSK and ARGX. The first run covers the last 12 months (`news.backfillMonths`).
2. **Pre-filter, no download.** 8-Ks without item 7.01 or 8.01, and 6-Ks whose description is routine (share dealings, voting rights and so on), are stored as excluded.
3. **Fetch and pre-filter text.** Every 15 minutes a batch of 10 filings is downloaded: the main document and its first `ex99` press-release exhibit. A filing must mention a Phase II/III trial and outcome or start language, or it is excluded.
4. **Classify.** The text goes to Claude (`clinical.llmModel`, default `claude-opus-5-5`) with a structured-output schema. Each document is classified once; the model, prompt version and token counts are stored with it.
5. **Validate.** Output that fails the schema, or whose supporting excerpt is not found in the source text, creates no event; the document goes to the review queue uncategorised.
6. **Rules.** Completion or enrolment is never success. Terminations for commercial or administrative reasons are recorded as excluded, not as failures. Phase I/II is excluded unless `clinical.includePhase1_2Trials` is set. Phase II/III trials are classified by the portion concerned, and held for review when that is unclear. "Positive topline data" with no primary endpoint stated is stored with evidence basis Company-characterised.
7. **Review.** Everything is saved as Pending review. At `/biotech/admin` you confirm (optionally correcting fields), save edits, or reject. Only confirmation makes an event Verified.

Set `clinical.classificationMode` to `"manual-only"` to skip step 4: filings that pass the pre-filters go straight to the review queue for you to categorise.

### What visitors see

Verified events always. Pending events only while `news.showUnreviewedEvents` is true, with an Unreviewed badge. Rejected events and uncategorised candidates are never returned by the public API. The excerpt, review notes and model details are admin-only.

### Deduplication

A second report of the same event attaches a source link instead of creating a new event. Two reports match when ticker and category are equal and either the NCT numbers match, or the programme names match (ignoring punctuation and case) and the reports are within 14 days of each other or name the same indication. The earliest report sets the announcement date. Sources are ranked SEC filing, then press release, then registry; the highest is shown as primary. A rejected event stays rejected when another report arrives.

### Registry status changes

The hourly job also reads ClinicalTrials.gov for Phase II/III trials updated in the last 14 days (18 requests) and compares each status with the last one seen. A change is a prompt to look, never proof:

- Completed: nothing is created.
- Not yet recruiting to recruiting, Phase III: a pending Phase III initiation, or supporting evidence on one already reported.
- Terminated, suspended or withdrawn: the registry's "why stopped" text is read. Commercial and administrative wording is excluded. Stated futility or safety on a terminated trial proposes a failure, pending review. Anything else is held uncategorised.

The first time a trial is seen only its baseline is stored, so changes that happened before the dashboard was set up are not detected.

### Press-release feeds

`news.rssFeeds` in `shared/config.ts` takes `{ ticker, url }` entries for company RSS or Atom feeds. It is empty: no feed URLs were verified. Only the text carried in the feed is used; linked pages are not fetched.

### Measured on 2026-10-11 against live EDGAR

666 filings in 12 months. 337 were excluded from metadata alone. Of the first 27 downloaded, 13 passed the text pre-filter. That suggests roughly 160 documents to classify in the backfill and about 13 a month afterwards. Stored documents ran from 9,000 to 40,000 characters; longer ones are cut at 40,000 and flagged "Source truncated" in the review queue.

### Classifier cost (estimate, not measured)

No API key was available during development, so no real classification was run. Assuming about 5,000 input and 1,500 output tokens per document:

| Model | Backfill (about 160 documents) | Ongoing (about 13 a month) |
|---|---|---|
| `claude-opus-5-5`, 4 and 20 USD per million tokens | about 8 USD | about 0.65 USD a month |
| `claude-sonnet-5-5`, 2 and 10 USD | about 4 USD | about 0.35 USD a month |
| `claude-haiku-5-5`, 0.10 and 0.50 USD | about 0.20 USD | under 0.05 USD a month |

Actual token use is shown on the admin page. The Batch API (half price) is not used, because requests enable the server-side refusal fallback, which the Batch API rejects. If Claude declines a document, the request is retried on a fallback model within the same call.

### Timing and limits

- The backfill downloads about 30 filings an hour, so the first 12 months take roughly half a day to work through.
- **The clinical feed needs the Workers Paid plan (5 USD a month).** The free plan allows 50 outbound requests and 50 D1 queries per invocation and 10 ms of CPU; a batch of 10 filings needs more of all three. Lowering `clinical.batchSize` reduces the load but was not tested on the free plan.
- Coverage is not complete. Results announced only at a conference, in an earnings release (8-K item 2.02 is excluded) or by a partner are missed. Trials led by another sponsor are not tracked in the registry.
- The filing index page is linked as the source, not the exhibit itself.

### Not yet verified against a real Finnhub key

Everything above ran against mock data and unit-tested fakes. Before relying on it, confirm with your key that the free tier returns `/quote` for all 20 tickers including the ADRs and ETFs, that `/stock/profile2` returns market cap, and which currency it reports for NVO, AZN, GSK and ARGX. Finnhub's free tier is described as personal use; check its terms for a public site.

#### Cloudflare limits

Workers free plan: 100,000 requests a day and 10 ms CPU per invocation. Modules A and C fit. The clinical feed needs the paid plan (see above). Four cron triggers are configured; check your plan's trigger limit. D1 free plan: 5 million row reads and 100,000 writes a day; the price job writes about 3,200 rows a day and the catalyst sync up to about 2,200.

## Verification status

| Part | Checked against the live service | Checked with fakes only |
|---|---|---|
| ClinicalTrials.gov (catalysts, status changes) | yes, through a local Worker | |
| SEC EDGAR (discovery, download, pre-filters) | yes, through a local Worker | |
| Finnhub | | yes |
| Claude classifier | | yes: request shape and response handling only |
| Cloudflare Access login | | yes: tokens signed locally |
| Deployed Worker, cron triggers, production D1 | not run | |

## Requires manual input or later work

- PDUFA dates and advisory committee meetings must be entered by hand.
- Every clinical event needs your confirmation to become Verified.
- The clinical feed needs an Anthropic API key and the Workers Paid plan.
- Press-release feeds are supported but none is configured.
- Cloudflare Access, D1 and the Finnhub key must be set up by hand as described above.
- Market cap for foreign-currency ADRs, exchange holidays and split adjustment of the sparkline (see above).
- The in-memory rate limiter is a per-isolate fallback; the `WRITE_LIMITER` binding in `wrangler.toml` is the real limit.
