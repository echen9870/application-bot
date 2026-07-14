# Module APIs (exports reference)

Load this when writing or modifying code in `src/` and you need exact function signatures instead of re-reading every file.

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
export function deleteDescriptions(links) // remove entries by link, persist; returns count removed (apply.mjs evicts ignored jobs)
```
`jobs.mjs` calls `saveDescriptions(newJobs)` after writing to Potential. The cache is keyed by job **link** (same value stored in Potential col G), so the ML scorer joins jobs→descriptions by link. Gitignored — derived data, can be large.

### src/ml/scorer.mjs
```js
export async function embed(text)                     // → number[] (384-dim, all-MiniLM-L6-v2, local, free)
export async function scoreMatch(resumeText, jobText) // → number 0–1 (cosine similarity; ad-hoc use only)
export async function scoreJobs(jobs)                 // → jobs[] sorted desc, each with:
//   .score        sigmoid(bias + Σ weight·feature) over the 9 named features (features.mjs)
//   .features     { domain_match, ..., title_match } — the values that made the score
//   .explanation  { z, prob, contributions: [{name, value, weight, contribution}] } sorted by |contribution|
//   .rubricInfo   { topDomain, antiHit, yoeCapped } (only when rubric.yml exists)
// Weights: data/model.json (trained) or DEFAULT_MODEL prior (cold start). No blending —
// the feature model IS the score. Uses job.description, falls back to title-only text.
export function buildJobText(job)                     // → the exact text embedded for a job (shared with training)
```

### src/ml/features.mjs
```js
export const FEATURE_NAMES   // ['domain_match','skill_overlap','language_overlap','penalty_overlap',
                             //  'anti_margin','yoe_gap','company_prior','history_similarity','title_match']
export const DEFAULT_MODEL   // hand-tuned prior { weights[9], bias: -0.5, meta: { source: 'prior', features } }
export function buildFeatureContext({ embeddedRubric, trainingStore })
// → { rubric, applied: {link,company,vec}[], companyStats, globalRate, nLabeled } — per-session precompute
export function extractFeatures(ctx, { jobVec, roleVec?, jobText, jobRole?, company?, excludeLink? })
// → { features: {name: value}, info: { topDomain, antiHit, yoeCapped } }
//   rubric features 0 without a rubric; yoe_gap = max(0, demanded − yoe.max) clamped at 5
//   (penalty-only: under-max and unknown are both 0, so unparseable titles aren't disadvantaged);
//   company_prior = (nApplied + 3·globalRate)/(nTotal + 3); history_similarity = mean cosine
//   to top-3 nearest applied embeddings. excludeLink = leave-one-out (training only).
export function featuresToVector(features)      // → number[9] in FEATURE_NAMES order
export function explainScore(model, features)   // → { z, prob, contributions[] sorted by |contribution| }
```

### src/ml/rubric.mjs
```js
export function loadRubric(path = 'rubric.yml')  // → parsed rubric | null (missing/unparseable → null, warns, never throws)
export async function embedRubric(rubric)        // → { domains: {name,weight,vec}[], antis: {name,vec}[], titles: {name,vec}[], skills, languages, penalties: string[] (lowercased), yoe }
//   embeds each domain/anti/preferred-title description once via embed() from scorer.mjs.
export function keywordFraction(list, text)      // → 0–1 fraction of keywords in text (word-boundary, literal)
export function rubricSignals(embeddedRubric, jobVec, jobText, jobRole, roleVec?)
//   → { domainMatch, topDomain, bestRawDomain, bestAnti, antiName, skillFrac, langFrac,
//       penaltyFrac, titleMatch, yoeGap|null } — raw signals shared by rubricScore and features.mjs
export function rubricScore(embeddedRubric, jobVec, jobText, jobRole, roleVec?)
//   → { score: 0–1, topDomain: string|null, antiHit: string|null, yoeCapped: boolean }
//   domainScore = max over domains of cosine(jobVec, domain.vec)·(weight/maxWeight).
//   anti margin: penalize (×0.5) only when best anti cosine > best raw domain cosine.
//   keyword buckets (all word-boundary literal matches against jobText):
//     preferred_skills ×0.1 + programming_languages ×0.1 added;
//     penalty_keywords ×0.2 subtracted (data-backed ignore signals).
//   title blend: with roleVec (caller-embedded job title) + preferred_titles,
//     score = 0.7·body + 0.3·max cosine(roleVec, title.vec); no roleVec → pure body.
//   YOE gate: extractMinYOE(jobRole)/extractMinYOEFromDesc(jobText) > yoe.max → ×0.3.
//   score clamped to [0,1]. Pure function (takes vecs) — testable without the model.
```
`rubricScore` is kept for `scripts/eval-rubric.mjs`; production scoring consumes `rubricSignals` via `features.mjs`.

### src/ml/model.mjs
```js
export function trainLogistic(X, y, { epochs=300, lr=0.1, lambda=0.01, init? })
// → { weights, bias, meta: { trainedAt, nPos, nNeg } } — dims follow X
// Gradient descent, L2 regularization, positives upweighted nNeg/nPos. Throws on empty/single-class input.
// init = optional { weights, bias } warm start (train.mjs passes DEFAULT_MODEL).
export function predictLogistic(model, featureVec)  // → probability 0–1 (sigmoid)
export function evaluateHoldout(X, y, { testFrac=0.2, seed=42, threshold=0.5, trainOpts={} })
// → { precision, recall, nTestPos, nTestNeg } | null (class < 5 examples)
// Stratified 80/20 split, seeded shuffle (reproducible), throwaway model on train split.
export function saveModel(model)                   // → data/model.json (atomic tmp+rename)
export function loadModel()                        // → model | null; requires meta.features naming each
// weight (legacy 384-dim embedding models are ignored → scorer uses the DEFAULT_MODEL prior)
```

### src/ml/training-data.mjs
```js
export function loadTrainingData()        // → { [link]: { label: 0|1, company, role, text, embedding, labeledAt } }
export function saveTrainingData(entries) // merge into data/training-data.json (atomic); keyed by link, relabels overwrite
```

### src/train.mjs
```js
export async function retrain()  // → { trained, nPos, nNeg, accuracy? } — trains from stored labels;
// skips (keeps old model) unless ≥10 examples per class. Called in-process by apply.mjs.
// CLI: node src/train.mjs [--bootstrap]  (bootstrap seeds labels from Applied/Ignored sheets)
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
