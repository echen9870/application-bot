# Career-Ops — Eric Chen's Job Search Pipeline

**Branch:** `bot-main` (working branch). `main` tracks upstream santifer/career-ops — never merge upstream into bot-main without reviewing diffs.
**User:** Eric Chen · echen9870@gmail.com
**Stack:** Node.js ESM (.mjs), Google Sheets API (not markdown files), googleapis, js-yaml, dotenv

---

## Session Start Checklist (run silently)

1. Verify `service-account.json` exists — if missing, copy from Windows Downloads:
   ```bash
   cp /mnt/c/Users/echen/Downloads/application-bot-494504-ecc22924b5cc.json service-account.json
   ```
2. Verify `.env` has `GOOGLE_SPREADSHEET_ID` set (ID: `1yt7LzUNz_wG-HEiRmhmHk826EGeskgBOrk7ABGNV5lY`)
3. `service-account.json` is gitignored — NEVER commit it

---

## Directory Layout

```
career-ops/
  src/
    # Entry-point scripts (have main() guarded by import.meta.url check)
    jobs.mjs              ← job scanner (main daily script)
    apply.mjs             ← process Potential sheet → Applied/Ignored
    prune.mjs             ← remove dead links from Potential (HTTP, no browser)
    gmail-sync.mjs        ← Gmail → Sheets status sync
    write-potential.mjs   ← append jobs to Potential (stdin JSON array)
    check-liveness.mjs    ← probe all API endpoints in portals.yml for health
    probe-ats.mjs         ← discover ATS API endpoints for websearch-only companies
    gmail-auth.mjs        ← one-time OAuth setup for Gmail

    # Shared modules (no main(); imported by the above)
    config.mjs            ← single portals.yml loader with consistent defaults
    sheets-client.mjs     ← Google Sheets auth + getColumn/getSheetId/redRowRequest
    filters.mjs           ← isUS, extractMinYOE, buildTitleFilter, yoeLabel, country lists
    ats.mjs               ← Greenhouse/Ashby/Lever/SmartRecruiters URLs + parsers + parseLink
    fetch.mjs             ← fetchJson/fetchResponse with timeout + retry/backoff
    potential-writer.mjs  ← appendToPotential, fetchSeenLinks, buildCheckboxRequest
    ml/
      parser.mjs          ← resume parser (PDF→pdf-parse→Gemini cleanup, or TXT/MD direct)
      scorer.mjs          ← resume×job match scoring via local embeddings (@xenova/transformers)
      descriptions.mjs    ← job-description cache (data/job-descriptions.json, keyed by link)
  test/
    test-all.mjs          ← test suite (node:test, no deps)
    test-ml.mjs           ← standalone ML pipeline test (no Sheets needed)
  portals.yml             ← company list + scan config
  .env                    ← secrets (gitignored)
  service-account.json    ← Google service account (gitignored)
  gmail-credentials.json  ← Gmail OAuth app credentials (gitignored, user-provided)
  gmail-token.json        ← Gmail OAuth token (gitignored, created by gmail-auth.mjs)
  package.json            ← scripts: jobs, apply, prune, probe, gmail, test
```

**Run scripts:** always `node src/<file>.mjs`, never `node <file>.mjs` (flat root is stale).

---

## Google Sheets Architecture

**Spreadsheet ID:** `1yt7LzUNz_wG-HEiRmhmHk826EGeskgBOrk7ABGNV5lY`
**Service account:** `application-bot@application-bot-494504.iam.gserviceaccount.com`

### Sheet tabs — columns and 0-based array indices

**Potential** (raw scan output; user checks ✓ then runs apply):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Applied? (BOOLEAN checkbox) |
| B | B | 1 | Date Found (YYYY-MM-DD) |
| C | C | 2 | Date Posted (YYYY-MM-DD) |
| D | D | 3 | Company |
| E | E | 4 | Role |
| F | F | 5 | Location |
| G | G | 6 | Link (URL) |
| H | H | 7 | YOE label ("New Grad", "2+ YOE", etc.) |
| I | I | 8 | Notes |
| J | J | 9 | Source ("scan" or "websearch") — controls what prune checks |
| K | K | 10 | Match Score (1–10, written by `score.mjs`; blank until scored) |

**Applied** (active applications):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Date Applied (YYYY-MM-DD) |
| B | B | 1 | Company |
| C | C | 2 | Role |
| D | D | 3 | Location |
| E | E | 4 | Link (URL) — used for dedup |
| F | F | 5 | Status (Applied / Interview / Rejected / Offer) |
| G | G | 6 | Notes |

**Ignored** (skipped jobs):

| Col | Letter | Index | Field |
|-----|--------|-------|-------|
| A | A | 0 | Date Found |
| B | B | 1 | Company |
| C | C | 2 | Role |
| D | D | 3 | Location |
| E | E | 4 | Link (URL) — used for dedup |

### Critical Sheets API behaviors

- **Checkbox cells** return `"TRUE"`/`"FALSE"` strings (not booleans) from `values.get`. `apply.mjs` handles both `"TRUE"` and the legacy `"✓"`.
- **Trailing empty rows** are omitted from `values.get` responses. Intermediate empty rows are included. This makes **column B (Date Found) a reliable row counter**: `(await sheets.spreadsheets.values.get({ range: 'Potential!B2:B' })).data.values.length + 2` = first empty row number. Both `jobs.mjs` and `write-potential.mjs` use this pattern.
- **Always use `values.update` (not `values.append`) when writing to Potential.** `values.append` detects a "table" ending at the last row with a checkbox `FALSE` value (row 1001) and appends below it. `values.update` with an explicit range writes to the correct row.
- **Column A checkbox validation is wiped when `apply.mjs` clears `Potential!A2:K`.** `jobs.mjs` and `write-potential.mjs` re-apply it via `buildCheckboxRequest()` after every append, dynamically extending the end row past any overflow: `Math.max(1001, lastWrittenRow + 1)`.

If checkboxes disappear, restore them:
```bash
node -e "import('./src/sheets-client.mjs').then(async ({createSheetsClient,getSheetId,SPREADSHEET_ID})=>{const s=createSheetsClient();const id=await getSheetId(s,'Potential');await s.spreadsheets.batchUpdate({spreadsheetId:SPREADSHEET_ID,requestBody:{requests:[{setDataValidation:{range:{sheetId:id,startRowIndex:1,endRowIndex:1001,startColumnIndex:0,endColumnIndex:1},rule:{condition:{type:'BOOLEAN'},showCustomUi:true}}}]}});console.log('done')})"
```

---

## Module APIs (exports reference)

### src/config.mjs
```js
export function loadConfig(path = 'portals.yml')   // → { scan, titleFilter, companies }
// scan = { recency_hours, max_yoe, concurrency, fetch_timeout_ms, retries } with defaults
// {48, 3, 10, 10_000, 3}. Cached after first call. Throws if portals.yml missing.
export function resetConfigCache()                 // test helper
```

### src/fetch.mjs
```js
export async function fetchWithTimeout(url, timeoutMs=10_000, options={})  // → Response
export async function fetchJson(url, { timeoutMs=10_000, retries=3 } = {}) // → parsed JSON
export async function fetchResponse(url, { timeoutMs=10_000, retries=3 } = {}) // → Response
export function isPermanentError(err)        // → true for 4xx (except 429); false for 5xx, 429, network
// Retries use linear backoff (500ms × attempt). fetchJson skips retries on permanent 4xx
// errors so dead links fail fast (~100ms) instead of burning 4 attempts. fetchResponse
// never throws on !ok status — only network errors / timeouts trigger retries.
```

### src/ats.mjs
```js
export const ATS = { greenhouse, ashby, lever, smartrecruiters, workday, oraclecloud, amazon, googlecareers, applecareers }
// Each: { boardApi(slug), [jobApi(slug,id)], parse(json, company, slug?), parseLink(host, path), [fetchAll(url, fetchJson, opts)] }

export function detectApi(company)                   // portals.yml entry → { type, url } | null
export function extractGHSlug(apiUrl)                // → 'stripe' from /v1/boards/stripe/jobs
export function parseJobs(type, json, company, apiUrl?)  // dispatch to ATS[type].parse
export function parseLink(url)                       // job URL → { type, slug, id } | { type:'generic', url } | null
export function cleanDescription(html)               // decode entities + strip tags + collapse + lowercase
```

**`fetchDescription` (optional, per-ATS hook):** `async fetchDescription(job, fetchJson, opts) → string` returns the cleaned, lowercased job description (or `''` on failure). Defined for the two ATSes whose list API omits descriptions: `greenhouse` (fetches `jobApi(_slug, _id)` → `.content`) and `smartrecruiters` (fetches `jobApi(_slug, _id)` → joins `jobAd.sections.{jobDescription,qualifications,additionalInformation}.text`). Both rely on the parser carrying `_slug`/`_id` on each job. ATSes that include descriptions inline (`ashby`, `amazon`, `lever`, `oraclecloud`, `atlassian`) set `job.description` in `parse()` and define no hook.

**`fetchAll` (optional, per-ATS hook):** for ATSes that don't fit the "one GET → one JSON page" pattern. Defined by:
- `workday` — POSTs to `/wday/cxs/{tenant}/{site}/jobs` with `{appliedFacets, limit, offset, searchText}`; paginates 5 pages × 20 = 100 jobs.
- `oraclecloud` — GETs `/hcmRestApi/.../recruitingCEJobRequisitions` with finder/expand/facetsList; injects `offset=N` into finder query for pagination, 5 pages × 200 = 1000 jobs.
- `amazon` — GETs `amazon.jobs/en/search.json`; paginates 5 pages × 100 = 500 jobs (sorted by recent).
- `googlecareers` — GETs `google.com/about/careers/applications/jobs/results?page=N`; regex-extracts `(id, title)` pairs from server-rendered HTML (`aria-label="Learn more about {title}"`); 8 pages, breaks early on no-new-results.
- `applecareers` — GETs `jobs.apple.com/en-us/search?location=united-states-USA&page=N`; regex-extracts `(id, title, posted-date, city)` quadruples; 8 pages.
- `icims` — Generic iCIMS adapter for `careers-{slug}.icims.com/jobs/search?ss=1&in_iframe=1`. Paginates via `&pr={page}` 0-indexed up to 20 pages. Finds anchor positions, then slices each block between consecutive anchors to extract location (US-STATE-City format, multi-location pipe-separated) and posted date (M/D/YYYY format converted to ISO). Used by Peraton, Joby Aviation, Berkley, General Dynamics. Note: some iCIMS portals omit location/date fields (Berkley, Joby) — adapter handles gracefully but `isUS()` filter will reject jobs with empty location.

When `fetchAll` is defined, `jobs.mjs` calls it instead of `fetchJson`. The returned object is then passed to `parse(json, company)` as usual — embed any auxiliary info you need (e.g. `_info` for Workday tenant/site, `_info` for Oracle host/site) on the returned object so `parse` can build correct URLs.

### src/potential-writer.mjs
```js
export async function appendToPotential(sheets, jobs, { dateFound?, source? } = {})
// Writes rows to Potential!A{firstEmpty}:J via values.update, re-applies checkbox validation.
// `source` ('scan' | 'websearch') is written to column J; jobs.mjs passes 'scan', write-potential.mjs 'websearch'.
// Returns { written, firstEmptyRow }.
export async function fetchSeenLinks(sheets)         // → Set<string> from Potential G + Applied E + Ignored E
export async function getFirstEmptyRow(sheets)       // → row number via column B counter
export function buildCheckboxRequest(sheetId, endRow=1001)  // BOOLEAN data-validation request
```

### src/ml/descriptions.mjs
```js
export function loadDescriptions()        // → { [link]: { company, role, description, fetchedAt } }  (whole cache, {} if absent)
export function getDescription(link)      // → cached description string | ''
export function saveDescriptions(jobs)    // merge jobs[].{link,company,role,description} → data/job-descriptions.json (atomic tmp+rename); skips empty descriptions; returns count written
```
`jobs.mjs` calls `saveDescriptions(newJobs)` after writing to Potential. The cache is keyed by job **link** (same value stored in Potential col G), so the ML scorer joins jobs→descriptions by link. Gitignored — derived data, can be large.

### src/ml/scorer.mjs
```js
export async function embed(text)                     // → number[] (384-dim, all-MiniLM-L6-v2, local, free)
export async function scoreMatch(resumeText, jobText) // → number 0–1 (cosine similarity)
export async function scoreJobs(resumeText, jobs)     // → jobs[] each with .score, sorted desc; uses job.description, falls back to "role at company in location"
```

### src/ml/parser.mjs
```js
export async function parseResume({ force? } = {})    // → resume text. PDF→pdf-parse+Gemini cleanup, or data/resume.{txt,md} direct. Caches to data/resume-parsed.txt.
```

### src/sheets-client.mjs
```js
export const SPREADSHEET_ID       // spreadsheet ID string
export const RED_BG               // { red, green, blue } for Rejected row background
export const RED_TEXT             // { red, green, blue } for Rejected row text
export function createSheetsClient()              // → google.sheets v4 client
export async function getColumn(sheets, sheetName, col)  // → Set<string> of non-empty values (skips header)
export async function getSheetId(sheets, tabName)        // → numeric sheetId for batchUpdate requests
export function redRowRequest(sheetId, rowIndex, numCols=7)  // → repeatCell request object for red formatting
```

### src/filters.mjs
```js
export const US_STATES            // Set of 2-letter lowercase state abbreviations + 'dc'
export const NON_US_COUNTRY       // string[] of country/city names to reject
export const NON_US_COUNTRY_CODES // Set of 2-letter lowercase ISO country codes to reject

export function extractMinYOE(title)        // → number | null  (0 = new grad/intern, null = no signal)
export function extractMinYOEFromDesc(desc) // → number | null  (desc must be lowercased; null = no signal)
export function yoeLabel(title)             // → "" | "New Grad" | "N+ YOE"
export function isUS(location)              // → boolean  (true = keep, false = reject)
export function buildTitleFilter(tf)        // tf = { positive: string[], negative: string[] } → (title: string) => boolean
export function looksLikeJobUrl(url)        // → boolean  (rejects /blog/, /news/, /podcast/, etc.)
```

`jobs.mjs` re-exports all filter functions so tests can import from `../src/jobs.mjs` without change.

### src/jobs.mjs
```js
// Re-exports for test suite (tests import from src/jobs.mjs):
export { extractMinYOE, extractMinYOEFromDesc, isUS, buildTitleFilter } from './filters.mjs'
export { buildCheckboxRequest } from './potential-writer.mjs'
```

### src/apply.mjs
```js
export function categorizeRows(dataRows)
// dataRows: array of raw row arrays from Potential!A:J (no header row)
// Returns: { toApply: Entry[], toIgnore: Entry[] }
// Entry: { found, company, role, location, link }
// "checked" = col A is "✓" OR "TRUE" (case-insensitive); blank/unchecked rows → toIgnore
// Skips rows where both company and role are empty.
// Defensive: col A is coerced via String(r[0] ?? '') so native booleans, numbers, null,
// or undefined from formula cells can't crash the apply pipeline.
// Source column (J) is read by the sheet but not propagated to Applied/Ignored.
```

### src/gmail-sync.mjs
```js
export function classify(subject, snippet)               // → 'Offer' | 'Interview' | 'Rejected' | null
export function extractCompany(subject, snippet, sender) // → string | null
export function normalize(name)                          // → lowercase alphanum, strips legal suffixes
export function shouldUpdate(current, next)              // → boolean (respects status rank, never downgrades)
```

Classification priority order: Offer > Interview > Rejected (first match wins).
Status rank: Applied=1, Rejected=2, Interview=3, Offer=6. Rejected only updates from Applied (rank 1).

---

## Job Scanner (src/jobs.mjs)

**Daily workflow:** `npm run scan` → `node src/score.mjs` → review Potential sheet (sort by Match Score) → check ✓ → `node src/apply.mjs`

`npm run scan` = `node src/jobs.mjs && node src/prune.mjs` — scan all API companies, filter, write to Potential, then prune dead links in one step.

**Cost optimization:** `/scanall` and `/websearch-jobs` are token-heavy (95 web searches). Always invoke them with the cheapest available model: `claude --model claude-haiku-4-5-20251001 /scanall`. Prune is a plain Node.js script (`node src/prune.mjs`) — run it directly, not inside a Claude session.

**Flags:**
- `--companies "Stripe, OpenAI, Glean"` — scan only these companies (comma-separated, case-insensitive). Websearch-only companies are skipped with a clear error.
- `--all` — skip the recency filter; returns all currently open jobs. Use when adding new companies or doing a full refresh.
- `--dry-run` — preview without writing to the sheet.
- `--no-desc` — skip description fetching. **Descriptions are fetched by default** during every scan (this was previously opt-in via `--desc`, now removed). For each job that passes the earlier filters, the full description is fetched and (a) used for description-level YOE filtering and (b) persisted to `data/job-descriptions.json` keyed by link for later ML scoring. Ashby/Amazon/Lever/Oracle/Atlassian include descriptions inline (free); Greenhouse (`/v1/boards/{board}/jobs/{id}` `.content`) and SmartRecruiters (`/v1/companies/{slug}/postings/{id}` `jobAd.sections`) are fetched per-job (~1 extra req/job that passes other filters). Use `--no-desc` to suppress all fetches.

**Filters applied in order:**
1. Title keyword filter (`buildTitleFilter` from portals.yml `title_filter`)
2. Posted within recency window (default 48h, `scan_config.recency_hours`) — skipped with `--all`
3. US-only location (`isUS()` from `filters.mjs`)
4. Not already seen (dedup: links from Potential col G + Applied col E + Ignored col E → `seenLinks` Set)
5. YOE title ≤ `max_yoe` (`extractMinYOE` on role title)
6. YOE description ≤ `max_yoe` (`extractMinYOEFromDesc` on description — fetched by default for all ATS that support it; disable with `--no-desc`)

**Write flow:**
1. Fetch column B (Date Found) to find `firstEmptyRow = values.length + 2`
2. `values.update` to `Potential!A{firstEmptyRow}:J` (10 columns including Source)
3. `batchUpdate` to re-apply checkbox validation to col A rows 2–`max(1001, lastWrittenRow+1)`

Rows are tagged `Source = scan` so `prune.mjs` skips them — scan-sourced rows are recent (≤ `recency_hours`) and were known-live at the time of write.

**Scan config** (`portals.yml → scan_config`, loaded by `src/config.mjs`):
```yaml
scan_config:
  recency_hours: 48       # how far back to look for new jobs
  max_yoe: 3              # reject roles requiring more than this many years of experience
  concurrency: 10         # parallel company fetches (shared by jobs, prune, check-liveness, probe-ats)
  fetch_timeout_ms: 10000 # per-request HTTP timeout (shared with the same)
  retries: 3              # retry attempts with linear backoff (500ms × attempt)
```

Defaults live in `src/config.mjs`; missing keys in portals.yml fall back to the above.

**Platform breakdown (portals.yml as of 2026-05-14):**
- SmartRecruiters: ~110 companies
- Greenhouse: ~130 companies
- Ashby: ~56 companies (descriptions included free)
- Lever: ~24 companies
- **Workday: 45+ companies** (Capital One, Adobe, BlackRock, Boeing, Citi, Comcast, Mastercard, Morgan Stanley, PNC, T-Mobile, Walmart, BoA, Wells Fargo, Cisco, GM, Fidelity, AT&T, Salesforce, NVIDIA, HP, HPE, Bloomberg, Snap, F5, Red Hat, Motorola, Palo Alto Networks, Ciena, Guidehouse, Freddie Mac, Leidos, Invesco, Expedia, BD, Home Depot, Northern Trust, Pixar, Rakuten, Rockwell Automation, FIS, Washington Post, Trimble, GlobalFoundries, John Hancock, PWC, Morningstar, Rocket Companies, Barclays, TransUnion)
- **Oracle Cloud HCM: 7 companies** (JP Morgan, Honeywell, GM Financial, Goldman Sachs, Nokia, Amex, Oracle Corp)
- **Custom adapters (9):** `amazon`, `workday`, `oraclecloud`, `googlecareers`, `applecareers`, `plaidcareers`, `saicjobs`, `bainrss`, `schwabicims`, `atlassian`
- Websearch-only (no public ATS API): ~95 companies (Taleo, custom portals, JS-only SPAs) — skipped by scanner; use `/websearch-jobs` + `write-potential.mjs`

### Empty ATS Problem: HTTP 200 but 0 Jobs

**What it is:** A company is configured with an ATS endpoint in `portals.yml`, the endpoint returns HTTP 200 OK (success), but the response contains 0 jobs. This is NOT a network error or API failure — the API is working correctly, but the company doesn't actually use the configured ATS platform.

**Why it happens:** Usually the company was initially added to portals.yml with a default ATS guess (SmartRecruiters, Greenhouse, etc.), but the company actually uses a different platform:
- Configured as SmartRecruiters, but company uses Workday
- Configured as Greenhouse, but company uses Ashby or Lever with a different slug
- Configured as Ashby, but company uses a custom portal or Jobvite API

**Example:** SAIC shows as "Empty ATS (saicjobs)" — the adapter exists and calls the API correctly, but something changed (API endpoint moved, company switched platforms, etc.), causing 0 jobs to be returned.

**Detection:** `src/jobs.mjs` now prints an "Empty ATS" section at the end of every scan summary listing companies that returned HTTP 200 but 0 jobs. Example output:

```
Empty ATS (HTTP 200 but 0 jobs — likely misconfigured, debug manually):
  ◯ SAIC (saicjobs)
  ◯ Invesco (workday)
  ◯ PlayStation Global (workday)
  ◯ John Deere (smartrecruiters)
  ◯ Liberty Mutual (smartrecruiters)
```

**Diagnosis:** To fix a dead endpoint:
1. Visit the company's careers page directly (e.g., saic.com/careers or google.com/careers)
2. Identify which ATS platform it actually uses (look for domain, slug, or API patterns)
3. Use `node src/probe-ats.mjs --company "Company Name"` to auto-probe known ATS endpoints
4. Once correct endpoint is found, update `portals.yml` and test with `node src/jobs.mjs --companies "Company Name"`

**Solutions implemented (2026-05-12 to 2026-05-14):**
- **90+ companies fixed** via custom adapters or slug corrections (from 118 initial dead endpoints down to 25)
- **Custom adapters added:** Workday POST API, Oracle Cloud HCM, Amazon search.json, Google careers HTML scrape, Apple careers HTML scrape, SAIC Jobvite API, Bain RSS feed, Charles Schwab iCIMS HTML scraper
- **Slug corrections:** Temporal, Optiver, HubSpot (Greenhouse); Intuit, Intuitive Surgical (SmartRecruiters); Wealthsimple, Kin Insurance (Ashby); CFS, Plaid (Lever)
- **Remaining hard cases (~25 companies):** Eightfold SPA-lock (John Deere, Liberty Mutual, L3Harris), SuccessFactors no-public-API (SAP, Moodys, IBM), BrassRing no-public-API (Lockheed Martin), iCIMS unknown config (NSA, Charles Schwab —though one adapter exists), custom portals (Bain, Siemens, Pega, Sabre, CGI, Dow Jones, Parsons, Polaris, Philips, Paramount, SAIC, DriveTime, Actalent, Asurion, Uline, Verint, Wolters Kluwer, MicroStrategy, MITRE, Nordstrom), genuinely empty boards (Credit Karma, Ethereum Foundation, Lumen, Tamr, Smartleaf, Brightspot, Forterra, Atlassian, AffiniPay, Maestro AI, CloudKitchens)

See `/home/echen/.claude/projects/-home-echen-career-ops/memory/project_dead_ats_endpoints.md` for the full audit trail and solutions.

**Diagnosing Empty ATS failures — quick reference:**
```bash
# After seeing a company in "Empty ATS" section:
# 1. Check what's configured
grep -A3 "name: Company Name" portals.yml

# 2. Manually test the endpoint
curl -s "https://configured-api.com/..." | jq 'length' 

# 3. Auto-probe for correct endpoint
node src/probe-ats.mjs --company "Company Name"

# 4. Test with all jobs (not just 48h recency)
node src/jobs.mjs --companies "Company Name" --all --dry-run

# 5. After fixing portals.yml, verify and commit
node src/jobs.mjs --companies "Company Name" --all
git add portals.yml && git commit -m "fix: Company Name ATS endpoint"
```

**SPA-locked companies (cannot scrape without a headless browser):** Microsoft (`apply.careers.microsoft.com` — Eightfold API gated behind `PCSX` session token), Meta (`metacareers.com` — internal GraphQL needs rotated `doc_id`/`dyn`/`lsd` tokens), GitHub (`www.github.careers` — Handlebars template placeholders, iCIMS-backed but JS-only). Left on `scan_method: websearch`. Re-evaluate if portals.yml grows another half-dozen SPA-only companies, at which point a Playwright-backed adapter might earn its keep.

---

## Apply (src/apply.mjs)

**Flow:**
1. Read `Potential!A:J` (all rows including header; col J carries Source)
2. `categorizeRows(rows.slice(1))` — split into `toApply` (checked) and `toIgnore` (unchecked/blank)
3. Fetch Applied col E + Ignored col E → `seenLinks` Set for dedup
4. Filter out any job whose link is already in `seenLinks` (printed counts reflect post-dedup totals)
5. `values.append` checked jobs → `Applied!A:G` with status `"Applied"`
6. `values.append` unchecked jobs → `Ignored!A:E`
7. `values.clear` → `Potential!A2:K` (includes Source + Match Score columns)

Running `/apply` twice is safe — duplicates are skipped by the link dedup in step 3.
Source is not propagated to Applied/Ignored (those sheets stay 7 / 5 columns).

---

## Score (src/score.mjs)

Productionizes the embedding model in `src/ml/scorer.mjs` against the Potential sheet — it does **not** introduce a new algorithm, it calls the same `scoreJobs()` that `test/test-ml.mjs` uses. Run after a scan (`node src/score.mjs`).

**Flow:**
1. Find the data extent via the column-B (Date Found) counter — `getFirstEmptyRow()` — and read exactly `Potential!A2:K{lastDataRow}` (avoids the hundreds of trailing checkbox-only rows that an open-ended `A:K` read returns, which previously overflowed the grid on clear).
2. Join each row's description from `data/job-descriptions.json` (by link, via `loadDescriptions()`).
3. `parseResume()` → resume text; `scoreJobs(resumeText, jobs)` → cosine similarity 0–1 per job (jobs without a cached description fall back to "role at company in location").
4. Map cosine → 1–10 (`score10 = round(1 + cosine·9, 1)`, matching the scale in `user.yml`) and `values.update` → `Potential!K1:K{lastDataRow}` (header "Match Score" + one score per row, aligned by row).
5. `values.clear` → `Potential!K{firstEmpty}:K` to wipe stale scores below the current data.

`--dry-run` prints the ranked summary without writing. `--top N` sets how many rows the console summary lists (default 20). **Note:** `user.yml`'s richer rubric (`scoring_weights`, company `tiers`, location/industry prefs) is **not** consumed — scoring is purely the resume↔description embedding similarity. Folding the rubric in is a possible future enhancement.

---

## Write-Potential (src/write-potential.mjs)

Reads a JSON array from stdin (`[{ company, role, location, link, posted }]`), applies the same filters as `jobs.mjs` plus a URL heuristic, and appends to Potential tagged `Source = websearch`. Used by `/websearch-jobs` and `/scanall`.

- Detects TTY: exits with usage message if no pipe is detected
- Loads `max_yoe` and `title_filter` from `portals.yml`
- Same `firstEmptyRow` counter pattern and `values.update` write as `jobs.mjs`
- Deduplicates against Potential col G + Applied col E + Ignored col E
- Rejects URLs that obviously aren't job pages via `looksLikeJobUrl()` — `/blog/`, `/news/`, `/press/`, `/podcast/`, `/insights/`, `/customers/`, `/case-studies/`, etc. Lets Claude dump raw websearch results without pre-filtering in-context.

```bash
echo '[{"company":"Stripe","role":"SWE Intern","location":"Remote","link":"https://...","posted":"2026-05-01"}]' | node src/write-potential.mjs
node src/write-potential.mjs --dry-run   # reads stdin, previews without writing
```

---

## Prune (src/prune.mjs)

Removes dead job links from Potential using ATS APIs — no browser needed, runs in ~30s. Reads `TIMEOUT` / `CONCURRENCY` / `RETRIES` from `portals.yml scan_config`.

**Scope: only checks rows where `Source = websearch` (column J).** Scan-sourced rows are recent (≤ `recency_hours`) and were known-live at the time of write; prune skips them entirely.

**URL detection → liveness check (via `src/ats.mjs:parseLink`):**
- `job-boards.greenhouse.io` or `boards.greenhouse.io` path `/board/jobs/{id}` → individual endpoint `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}` — 404 = dead
- `jobs.lever.co` path `/{company}/{uuid}` → individual endpoint `api.lever.co/v0/postings/{company}/{uuid}` — 404 = dead (was previously board listing, which had false positives — closed jobs remained in the listing)
- `jobs.ashbyhq.com` path `/{company}/{uuid}` → fetch full board once, check UUID present (cached)
- Everything else (generic): GET, check final URL for `?error=true`

Ashby board cache (Map keyed by `ashby:{slug}`) — multi-job companies cost one API call.

**Conservative by design:** network errors and board-fetch failures leave rows intact. Only GH/Lever individual-endpoint 404s and confirmed-absent Ashby IDs trigger deletion. Deletes rows by `deleteDimension` (descending order to avoid index shift).

```bash
node src/prune.mjs            # check and remove dead rows
node src/prune.mjs --dry-run  # preview without deleting
```

**Cost note:** prune is pure Node.js with no Claude involvement — always run it directly (`node src/prune.mjs`), never inside a Claude session where it would burn tokens unnecessarily.

---

## Gmail Sync (src/gmail-sync.mjs)

**First-time setup:**
1. GCP Console → `application-bot-494504` project → APIs → Enable Gmail API
2. Credentials → Create OAuth 2.0 Client ID (Desktop app) → download JSON → save as `gmail-credentials.json`
3. `node src/gmail-auth.mjs` → authorize → saves `gmail-token.json`
4. All future runs: `node src/gmail-sync.mjs`

**Flags:** `--dry-run`, `--days N` (default: 7)

**Classification logic** (pure keyword matching, Offer > Interview > Rejected priority):
- Offer → `Offer`
- Interview signals (schedule, Calendly, HackerRank, coding assessment, take-home, etc.) → `Interview`
- Rejection signals (not selected, move forward with other, unfortunately, decided to move in a different direction, position has been closed, etc.) → `Rejected`
- Unknown → `null` (skipped)

**Gmail subject query** (OR'd together): application, interview, offer, next steps, thank you for applying, your application, we reviewed, decision, candidacy, submission, application status, status update, assessment, coding challenge, take-home, update.

**Status rank** (never downgrades): Applied(1) → Rejected(2) → Interview(3) → Offer(6).
Rejected only ever updates from Applied — never from Interview or Offer.

**Write flow:**
1. `batchUpdate` statuses for matched rows (Applied col F)
2. Apply red row formatting (`redRowRequest` from sheets-client) to rows newly set to Rejected in this run only — not a full re-scan

**Company matching:** `normalize()` strips legal suffixes (Inc/LLC/Corp/etc), lowercases, strips non-alphanum. Matched by substring: `normSheet.includes(normEmail) || normEmail.includes(normSheet)`.

---

## portals.yml Structure

```yaml
scan_config:
  recency_hours: 48
  max_yoe: 3
  concurrency: 10
  fetch_timeout_ms: 10000

title_filter:
  positive: [engineer, developer, ...]
  negative: [senior staff, principal, director, ...]

tracked_companies:
  - name: Stripe
    careers_url: https://stripe.com/jobs
    api: https://boards-api.greenhouse.io/v1/boards/stripe/jobs
    scan_method: greenhouse
    enabled: true           # omit or set false to skip
```

**scan_method values:** `greenhouse`, `ashby`, `smartrecruiters`, `lever`, `workday`, `oraclecloud`, `amazon`, `googlecareers`, `applecareers`, `websearch` (websearch = skipped by scanner; needs `/websearch-jobs`)

**Adding a company:** probe in order — Ashby (`jobs.ashbyhq.com` slug), Lever (`jobs.lever.co`), Greenhouse (`/v1/boards/{slug}/jobs`), SmartRecruiters (`/v1/companies/{Slug}/postings?limit=100&status=PUBLIC`), Workday (`{tenant}.wd{N}.myworkdayjobs.com/{site}`), Oracle Cloud HCM (`{tenant}.fa.oraclecloud.com` or `{tenant}.fa.ocs.oraclecloud.com`). HTTP 200 with JSON = correct endpoint. HTTP 404 = wrong slug. Or: `node src/probe-ats.mjs --company "Name"` to automate; `--apply` to patch portals.yml automatically (uses regex string patching, not yaml.dump — comments are preserved). Both `probe-ats.mjs --apply` and `check-liveness.mjs --fix` write via `portals.yml.tmp` + `rename` so a kill mid-write can't truncate the source-of-truth file.

**Fixing "Empty ATS" problems (HTTP 200 but 0 jobs):**
1. When `npm run scan` reports a company in the "Empty ATS" section, the API is reachable but returns 0 jobs
2. Do NOT assume the company has no openings — they likely use a different platform than configured
3. Visit the company's careers page and identify the actual ATS: look for URL patterns (`.wd1.`, `.ashbyhq.com`, `lever.co`, etc.), page source, or JavaScript network requests
4. Common solutions:
   - **Wrong slug:** Update the `api:` URL with the correct slug (e.g., Temporal from `temporal` to `temporaltechnologies` on Greenhouse)
   - **Wrong ATS family:** Change `scan_method:` to the correct platform (e.g., SmartRecruiters → Workday)
   - **Custom platform:** Create a custom adapter in `src/ats.mjs` (see `saicjobs`, `bainrss`, `schwabicims` as examples) and add to `ATS` export
   - **No public API:** Move to `scan_method: websearch` and use `/websearch-jobs` instead
5. After fixing: test with `node src/jobs.mjs --companies "Company Name" --all` to verify jobs now appear
6. Commit the portals.yml change immediately to avoid re-discovering the same fix later

**SPA-locked companies:** Microsoft (Eightfold), Meta (GraphQL), GitHub (iCIMS frontend). Their listings render exclusively client-side and their XHR endpoints reject external callers without browser-issued session tokens. Stay on `scan_method: websearch` until a Playwright adapter is justified.

---

## Test Suite

```bash
npm test                    # runs test/test-all.mjs
node test/test-all.mjs      # same
```

**89 tests, zero extra dependencies** (Node.js built-in `node:test` + `node:assert`):

| Import source | Functions tested |
|---|---|
| `src/jobs.mjs` (re-exports filters/potential-writer) | `extractMinYOE` (3), `extractMinYOEFromDesc` (8), `buildTitleFilter` (4), `isUS` (7), `buildCheckboxRequest` (2) |
| `src/filters.mjs` | `looksLikeJobUrl` (3) |
| `src/gmail-sync.mjs` | `classify` (5), `extractCompany` (4), `normalize` (2), `shouldUpdate` (4) |
| `src/apply.mjs` | `categorizeRows` (6) — incl. boolean/null/number coercion |
| `src/ats.mjs` | `detectApi` (3), `extractGHSlug` (1), `parseLink` (5), `parseJobs` (5, incl. Lever desc + SR _slug/_id), `cleanDescription` (2), URL templates (1) |
| `src/fetch.mjs` | `isPermanentError` (3) — 4xx fails fast, 429 retries, 5xx retries |

Filter functions live in `src/filters.mjs` but are re-exported from `src/jobs.mjs` — tests always import from `src/jobs.mjs` for backward compatibility.

**Run tests before committing any change to `src/jobs.mjs`, `src/filters.mjs`, `src/apply.mjs`, `src/gmail-sync.mjs`, `src/ats.mjs`, or `src/potential-writer.mjs`.**

---

## npm Scripts

| Script | Command |
|--------|---------|
| `npm run scan` | `node src/jobs.mjs && node src/prune.mjs` — full pipeline |
| `npm run scan:all` | same but with `--all` (skip recency filter) |
| `npm run scan:dry` | `node src/jobs.mjs --dry-run` — preview only |
| `npm run jobs` | `node src/jobs.mjs` — scan only, no prune |
| `npm run jobs:dry` | `node src/jobs.mjs --dry-run` |
| `npm run apply` | `node src/apply.mjs` — deduplicates before writing |
| `npm run apply:dry` | `node src/apply.mjs --dry-run` |
| `npm run prune` | `node src/prune.mjs` |
| `npm run prune:dry` | `node src/prune.mjs --dry-run` |
| `npm run score` | `node src/score.mjs` — score Potential rows, write Match Score (col K) |
| `npm run score:dry` | `node src/score.mjs --dry-run` — print ranking, write nothing |
| `npm run probe` | `node src/probe-ats.mjs` |
| `npm run probe:apply` | `node src/probe-ats.mjs --apply` |
| `npm run gmail` | `node src/gmail-sync.mjs` |
| `npm run gmail:dry` | `node src/gmail-sync.mjs --dry-run` |
| `npm test` | `node test/test-all.mjs` |

---

## Security

- `service-account.json` — gitignored. Key ID `ecc22924b5cc`. Project `application-bot-494504`. Rotate at GCP Console if compromised.
- Old key `2b632b48` was exposed in git history — scrubbed via `git filter-repo` on 2026-05-02, history force-pushed. Anyone with old clones should re-clone.
- `gmail-credentials.json` and `gmail-token.json` — gitignored, never commit.
- `.env` — gitignored. Required vars: `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_PATH`.

---

## Known Quirks

- **Checkbox values from Sheets API:** BOOLEAN checkbox cells return `"TRUE"`/`"FALSE"` strings (not booleans) under the default `FORMATTED_VALUE` render. Formula cells (e.g. `=IF(...)`) can return real booleans, so `categorizeRows` coerces via `String(r[0] ?? '')` to handle both safely.
- **`values.append` writes to wrong row:** Sheets detects checkbox `FALSE` values as table content; append lands below row 1001. Always use `values.update` with an explicit range computed from the column B counter.
- **SmartRecruiters rate limiting:** During bulk scans (300+ companies), some SR endpoints return 404 transiently. These are rate-limiting artifacts. Safe to ignore.
- **Checkbox loss:** `apply.mjs` clears `Potential!A2:K` which wipes column A data validation. `jobs.mjs` re-applies it via `buildCheckboxRequest()` after every append. If checkboxes vanish, run the one-liner above or re-run `jobs.mjs`.
- **portals.yml not committed history:** API endpoint additions were lost once in a `git filter-repo` rewrite. Always commit `portals.yml` changes immediately after bulk probe runs.
- **Stale jobs in Potential:** The ATS scanner only adds new jobs. Run `node src/prune.mjs` periodically (or after `/websearch-jobs`) to remove dead links.
- **Websearch results are stale:** After `/websearch-jobs`, always run `node src/prune.mjs` first (HTTP check), then Playwright for links prune can't determine.
- **write-potential.mjs requires piped input:** Running without stdin prints usage and exits. Always pipe: `echo '[...]' | node src/write-potential.mjs`.
- **apply.mjs deduplicates before writing:** Running `/apply` twice is safe — links already in Applied/Ignored are skipped.
- **Lever board API false positives — FIXED.** Prune now hits `api.lever.co/v0/postings/{slug}/{id}` (individual endpoint, 404 = dead) instead of the board listing. Lever links no longer need Playwright verification.
- **Filter-set difference between jobs.mjs and write-potential.mjs:** Both apply title + US + dedup + title-YOE. `jobs.mjs` also applies recency and description-level YOE. `write-potential.mjs` additionally applies `looksLikeJobUrl()` (rejects blog/news/podcast URLs from websearch noise).
- **Descriptions are fetched by default and cached for ML scoring:** `jobs.mjs` fetches every new job's full description during the scan (inline for Ashby/Amazon/Lever/Oracle/Atlassian; per-job for Greenhouse/SmartRecruiters) and writes them to `data/job-descriptions.json` keyed by link. This was previously opt-in via `--desc`; that flag is gone — use `--no-desc` to suppress. Descriptions are NOT written to the Potential sheet (too large) — the cache and sheet join by link. The ML scorer (`src/ml/scorer.mjs`) consumes the cache via `loadDescriptions()`.
- **Source column drives prune scope:** `jobs.mjs` tags rows `Source = scan`; `write-potential.mjs` tags `Source = websearch`. `prune.mjs` only checks the websearch ones. Don't manually clear column J — it's how the pipeline decides what's verified.
- **Retry/backoff is automatic:** `fetch.mjs` retries 3 times by default with linear backoff (500ms, 1s, 1.5s) — but only on transient errors (5xx, 429, network/timeout). Permanent 4xx errors (404, 401, 403) fail fast in one attempt via `isPermanentError()` so dead links don't burn 4× wall-time. The retry count is `scan_config.retries`.
- **`portals.yml` writes are atomic:** `probe-ats.mjs --apply` and `check-liveness.mjs --fix` both stage to `portals.yml.tmp` then `rename`, so a Ctrl+C or crash mid-write can't truncate the source-of-truth file.
- **Concurrent Ashby board fetches share one Promise:** `prune.mjs:getBoardIds` caches the in-flight Promise (not the resolved Set), so concurrent workers hitting the same Ashby company share a single fetch instead of racing it.
- **Empty ATS endpoints (HTTP 200 but 0 jobs):** The scanner returns HTTP 200 but finds 0 jobs for ~25 companies in portals.yml. These are NOT failures — the API is working, the company just doesn't use the configured ATS anymore (or never did). Each run's "Empty ATS" section at the end of the scan output lists these offenders. **Do not ignore empty results** — investigate and either fix the endpoint (custom adapter, slug correction, or platform change) or move to `scan_method: websearch`. Audit trail at `/home/echen/.claude/projects/-home-echen-career-ops/memory/project_dead_ats_endpoints.md` documents all 118 initial dead endpoints and which 90+ have been fixed.

---

## Ethical Use

**Never submit without user review.** Fill forms, generate PDFs, draft answers — always stop before clicking Submit/Apply. The user makes the final call.

---

## Offer Verification (MANDATORY)

Never trust WebSearch/WebFetch to verify if a job posting is still active. For individual link verification always use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Footer/navbar only (no JD text) = closed. Title + description + Apply button = active.

**For bulk sheet verification, prefer `node src/prune.mjs` first** — it checks Greenhouse/Ashby/Lever links via API (free, fast, no tokens). Only fall back to Playwright for links prune can't determine (Stripe, Apple, ByteDance, custom portals).

Exception in batch mode (`claude -p`): use WebFetch and mark report with `**Verification:** unconfirmed (batch mode)`.

---

## CI

`.github/workflows/test.yml` runs `node test/test-all.mjs` on every PR to `main`. Tests are pure Node.js, no secrets required — all pure-function unit tests.
