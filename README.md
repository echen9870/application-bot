# career-ops

Personal job search pipeline for Eric Chen — MS CS student at Northeastern University, targeting backend / distributed systems / infrastructure roles (new grad, fall 2026 intern), graduating August 2026.

Zero-token scanning across **525 companies** spanning 14 ATS platforms. No AI required for day-to-day use.

---

## How it works

```
npm run scan           # scan all 525 portals → filter → write to Potential → prune dead links
                       # review in Google Sheets, check ✓ on jobs you applied to
node src/apply.mjs     # ✓ rows → Applied, rest → Ignored
```

That's the full loop. Run `npm run scan` daily. Review and process with `apply.mjs`.

To scan specific companies or get all currently open jobs (not just last 48h):
```
node src/jobs.mjs --companies "Stripe, OpenAI, Glean" --all && node src/prune.mjs
```

---

## Sheets

| Sheet | Purpose |
|-------|---------|
| **Potential** | New jobs from the last 48h. Check the box in column A for jobs you applied to. |
| **Applied** | Jobs you applied to, with status tracking. |
| **Ignored** | Jobs you passed on. Excluded from future scans automatically. |

---

## Filters applied during scan

- **Title filter** — must match positive keywords (Software Engineer, Backend, etc.) and not match seniority negatives (Senior, Sr., Lead, Staff, Architect)
- **YOE filter** — drops roles requiring > 3 YOE in title or description
- **Recency filter** — last 48 hours only (based on API date)
- **Location filter** — US only; rejects non-US country names, Canadian cities, bare ISO country codes (e.g. "HU"), and "Remote [country]" patterns
- **Dedup** — skips URLs already in Potential, Applied, or Ignored

After every scan, an **"Empty ATS"** section flags companies whose API returned 0 jobs total — these are likely misconfigured (wrong ATS or stale slug) and need a custom adapter or slug fix, not just an empty board.

---

## Commands

```bash
# ── Full pipeline (recommended) ──────────────────────────────────────────
npm run scan                   # scan all API companies → filter → write → prune dead links
npm run scan:all               # same but skips 48h recency filter (all open jobs, not just today's)

# Or with specific companies:
node src/jobs.mjs --companies "Stripe, OpenAI, Glean" --all && node src/prune.mjs

# ── Individual steps ──────────────────────────────────────────────────────
node src/jobs.mjs              # scan all portals, add new jobs to Potential (last 48h only)
node src/jobs.mjs --dry-run    # preview without writing anything
node src/jobs.mjs --all        # scan without 48h recency filter
node src/jobs.mjs --companies "Stripe, Anthropic"  # scan specific companies only
node src/jobs.mjs --no-desc     # skip JD fetching (descriptions fetched by default → data/job-descriptions.json)

node src/score.mjs             # score Potential rows vs resume (ml/scorer.mjs), write Match Score (col K)
node src/score.mjs --dry-run   # print the ranking without writing

node src/apply.mjs             # process Potential: ✓ → Applied, rest → Ignored
node src/apply.mjs --dry-run   # preview without writing

node src/prune.mjs             # remove dead links from Potential via HTTP (no browser, ~30s)
node src/prune.mjs --dry-run   # preview which rows would be removed

node src/gmail-sync.mjs        # sync Gmail → update Applied sheet statuses
node src/gmail-sync.mjs --dry-run

node src/probe-ats.mjs                     # find ATS APIs for websearch-only companies
node src/probe-ats.mjs --apply             # also patch portals.yml with found APIs
node src/probe-ats.mjs --company "Stripe"  # probe a specific company

node src/check-liveness.mjs              # health-check every API endpoint in portals.yml
node src/check-liveness.mjs --verbose    # also show HTTP status per company

npm test                       # run 86-test suite (filters, parsers, classifiers)
```

### Websearch (Claude Code skill)

For companies with no public ATS API (Eightfold, Phenom, BrassRing, custom portals), use the Claude Code skill:

```
/websearch-jobs              # search all websearch-only companies via Google
/websearch-jobs Microsoft    # search a specific company

/scanall                     # full pipeline: API scan + websearch + prune + Playwright verify
```

**Important:** Web search results go stale quickly — jobs indexed weeks ago may already be closed.
After `/websearch-jobs`, clean up dead links:

1. **HTTP prune first** (fast, free):
   ```
   node src/prune.mjs
   ```
   Removes dead Greenhouse/Ashby/Lever/Workday/Amazon/iCIMS links via ATS APIs in ~30s with no browser. Conservative by design — only deletes confirmed-404 links.

2. **Playwright for the rest** (slower, token cost):
   ```
   use playwright to verify this
   ```
   Handles Stripe, Apple, custom portals, and any links prune couldn't determine. Expect ~30–50% of web search results to still be live after both passes.

---

## Setup

```bash
npm install

# Copy service-account.json from Windows Downloads (gitignored)
cp /mnt/c/Users/echen/Downloads/application-bot-494504-*.json service-account.json

# Set spreadsheet ID in .env
echo 'GOOGLE_SPREADSHEET_ID=1yt7LzUNz_wG-HEiRmhmHk826EGeskgBOrk7ABGNV5lY' > .env

# Run first scan
npm run scan
```

For Gmail sync (optional):
```bash
# In GCP Console: enable Gmail API, create OAuth Desktop credentials
mv ~/Downloads/client_secret_*.json gmail-credentials.json
node src/gmail-auth.mjs    # authorize, saves gmail-token.json
node src/gmail-sync.mjs    # sync inbox → Applied statuses
```

---

## Configuration

**`portals.yml`** — companies to scan, scan tuning, and title filter keywords.

```yaml
scan_config:
  recency_hours: 48       # how far back to look for new jobs
  max_yoe: 3              # reject roles requiring more than this many YOE
  concurrency: 10         # parallel company fetches
  fetch_timeout_ms: 10000 # per-request HTTP timeout
  retries: 3              # retry attempts with linear backoff (500ms × attempt)

title_filter:
  positive: [Software Engineer, Backend Engineer, Infrastructure Engineer, ...]
  negative: [Senior, Sr., Lead, Staff, Architect, ...]

tracked_companies:
  - name: Vercel
    careers_url: https://job-boards.greenhouse.io/vercel
    api: https://boards-api.greenhouse.io/v1/boards/vercel/jobs
    scan_method: greenhouse
    enabled: true            # omit or set false to skip
```

### Supported `scan_method` values

| Method | Coverage | Notes |
|--------|----------|-------|
| `greenhouse` | ~145 companies | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` |
| `ashby` | ~70 companies | `api.ashbyhq.com/posting-api/job-board/{slug}` (descriptions included) |
| `lever` | ~25 companies | `api.lever.co/v0/postings/{slug}` |
| `smartrecruiters` | ~110 companies | `api.smartrecruiters.com/v1/companies/{slug}/postings` |
| `workday` | ~50 companies | POST to `{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with pagination |
| `oraclecloud` | ~7 companies | Oracle Cloud HCM REST API |
| `amazon` | 1 (Amazon) | Custom adapter for `amazon.jobs/en/search.json` |
| `googlecareers` | 1 (Google) | HTML scrape of `google.com/about/careers/applications/jobs/results` |
| `applecareers` | 1 (Apple) | HTML scrape of `jobs.apple.com/en-us/search` |
| `plaidcareers` | 1 (Plaid) | Custom JSON adapter |
| `saicjobs` | (currently disabled) | SAIC Jobvite API — site is now Cloudflare-protected |
| `bainrss` | 1 (Bain) | RSS feed scrape |
| `schwabicims` | 1 (Charles Schwab) | iCIMS HTML scrape (custom layout) |
| `atlassian` | 2 (Atlassian, Cvent) | Jibe-on-iCIMS JSON API |
| `icims` | 4 (Peraton, Joby, Berkley, GD) | Generic iCIMS HTML scrape (`careers-{slug}.icims.com`) |
| `workable` | (adapter exists, not used) | Workable widget API — Hugging Face's endpoint now blocks scrapers |
| `websearch` | ~95 companies | No public API. Skipped by scanner — handled by `/websearch-jobs` skill |

### Adding a company

```bash
# Auto-probe Greenhouse/Ashby/Lever/SmartRecruiters with slug variations
node src/probe-ats.mjs --company "Stripe"

# Or auto-patch portals.yml (atomic write via portals.yml.tmp + rename)
node src/probe-ats.mjs --company "Stripe" --apply

# For Workday/iCIMS/custom platforms: scrape careers page for ATS hints
curl -sL https://example.com/careers | grep -oE 'myworkdayjobs\.com/[^"]+|icims\.com[^"]*'
```

### "Empty ATS" diagnostic

When a company shows up in the scan summary's "Empty ATS" section (HTTP 200 but 0 jobs), the API is reachable but the company doesn't actually use the configured platform anymore. Either:

- Update `api:` URL with correct slug (e.g., Temporal: `temporal` → `temporaltechnologies`)
- Change `scan_method:` to the actual platform (e.g., SmartRecruiters → Workday)
- Add a custom adapter to `src/ats.mjs` (see `saicjobs`, `bainrss`, `icims` for patterns)
- Move to `scan_method: websearch` if the platform has no public API

See `CLAUDE.md` for the full Empty ATS playbook.

---

## Stack

- Node.js (ES modules, no transpilation)
- js-yaml — portals config
- googleapis — Google Sheets API
- node:test + node:assert — 86-test suite, zero extra deps
- Playwright MCP — optional, only for link verification of generic websearch URLs
- Anthropic SDK — optional (legacy `evaluate.mjs` removed; deep evaluation now via Claude Code skills)

---

## Repo layout

```
src/
  jobs.mjs              ← daily scanner (entry point)
  apply.mjs             ← Potential → Applied/Ignored
  prune.mjs             ← remove dead links from Potential
  gmail-sync.mjs        ← Gmail → Applied status sync
  write-potential.mjs   ← stdin JSON → Potential (used by /websearch-jobs)
  check-liveness.mjs    ← health-check all API endpoints in portals.yml
  probe-ats.mjs         ← discover ATS APIs for websearch-only companies
  gmail-auth.mjs        ← one-time OAuth setup for Gmail
  config.mjs            ← portals.yml loader with defaults
  sheets-client.mjs     ← Google Sheets auth + helpers
  filters.mjs           ← isUS, extractMinYOE, buildTitleFilter, looksLikeJobUrl
  ats.mjs               ← all 17 ATS adapters (boardApi, parse, parseLink, fetchAll)
  fetch.mjs             ← fetchJson/fetchResponse with timeout + retry/backoff
  potential-writer.mjs  ← appendToPotential, fetchSeenLinks, buildCheckboxRequest

test/test-all.mjs       ← 86 tests covering filters, parsers, classifiers
portals.yml             ← 525 companies + scan config
.claude/skills/         ← /scan, /scanall, /apply, /websearch-jobs, /probe-ats
```
