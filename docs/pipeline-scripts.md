# Pipeline Script Internals

Load this when debugging or modifying `jobs.mjs`, `apply.mjs`, `score.mjs`, `train.mjs`, `write-potential.mjs`, or `prune.mjs` — the write flows, filter order, and flags each script depends on.

**Daily workflow:** `npm run scan` → review Potential sheet (sorted by Match Score) → check ✓ → `npm run apply`

---

## Job Scanner (src/jobs.mjs)

`npm run scan` = `node src/jobs.mjs && node src/prune.mjs && node src/score.mjs` — scan all API companies, filter, write to Potential, prune dead links, then score + sort in one step.

**Cost optimization:** `/scanall` and `/websearch-jobs` are token-heavy (95 web searches). Always invoke them with the cheapest available model: `claude --model claude-haiku-4-5-20251001 /scanall`. Prune is a plain Node.js script (`node src/prune.mjs`) — run it directly, not inside a Claude session.

**Flags:**
- `--companies "Stripe, OpenAI, Glean"` — scan only these companies (comma-separated, case-insensitive). Websearch-only companies are skipped with a clear error.
- `--all` — skip the recency filter; returns all currently open jobs. Use when adding new companies or doing a full refresh.
- `--dry-run` — preview without writing to the sheet.
- `--no-desc` — skip description fetching. **Descriptions are fetched by default** during every scan. For each job that passes the earlier filters, the full description is fetched and (a) used for description-level YOE filtering and (b) persisted to `data/job-descriptions.json` keyed by link for later ML scoring. Ashby/Amazon/Lever/Oracle/Atlassian include descriptions inline (free); Greenhouse (`/v1/boards/{board}/jobs/{id}` `.content`) and SmartRecruiters (`/v1/companies/{slug}/postings/{id}` `jobAd.sections`) are fetched per-job (~1 extra req/job that passes other filters).

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

---

## Apply (src/apply.mjs)

**Flow:**
1. Read `Potential!A:J` (all rows including header; col J carries Source)
2. `categorizeRows(rows.slice(1))` — split into `toApply` (checked) and `toIgnore` (unchecked/blank)
3. Fetch Applied col E + Ignored col E → `seenLinks` Set for dedup
4. Filter out any job whose link is already in `seenLinks` (printed counts reflect post-dedup totals)
5. `values.append` checked jobs → `Applied!A:G` with status `"Applied"`
6. `values.append` unchecked jobs → `Ignored!A:E`
7. `values.clear` → `Potential!A2:T` (includes Source, Match Score, and the L–T feature columns)

Between steps 6 and 7, apply also feeds the training loop: each processed row is saved as a label (applied=1, ignored=0) and the model retrains — see **Train** below for details. After labeling, ignored jobs' descriptions are evicted from `data/job-descriptions.json` (their text is already snapshotted in the training store; applied jobs stay cached). Wrapped in try/catch so a training failure never blocks the apply flow; `--dry-run` skips it.

Running `/apply` twice is safe — duplicates are skipped by the link dedup in step 3.
Source is not propagated to Applied/Ignored (those sheets stay 7 / 5 columns).

---

## Train (src/train.mjs) — the feedback loop

The scoring model is a logistic regression over the **9 named features** in `src/ml/features.mjs` (domain_match, skill_overlap, language_overlap, penalty_overlap, anti_margin, yoe_gap, company_prior, history_similarity, title_match), trained on your apply/ignore decisions and warm-started from the hand-tuned prior (`DEFAULT_MODEL`). Every learned weight is directly interpretable — training prints a `prior → trained` table per feature.

Features are recomputed at train time from each entry's snapshot (`embedding`, `text`, `role`, `company`). `company_prior` and `history_similarity` are computed **leave-one-out** (the example's own label is excluded) so labels can't leak into their own features.

**Trains only on description-bearing labels** — entries whose stored text contains a real job description (`buildJobText` inserts `\n\n` only in the description path). Title-only entries embed near-identical vectors for very different jobs and teach the model title phrasing rather than preferences; excluding them raised holdout precision from 14% to 21% (7-seed avg, 2026-07-10). Structured features (YOE/intern/remote flags appended to the embedding) were tried and deprecated the same day — at ×1 scale they hurt recall, at ×0.1 they were neutral; the description-only filter beat them outright.

**Label capture (runs inside apply.mjs):** each processed row is stored in `data/training-data.json` keyed by link, with `{ label, company, role, text, embedding }`. Text uses the same `buildJobText()` formula as scoring (description joined from the cache, title-only fallback) and the embedding is snapshotted at label time — retraining never re-embeds or touches Sheets. Relabeling a link overwrites, so re-runs can't duplicate.

**Retraining** (`retrain()`, called by apply.mjs in-process or via CLI):

```bash
node src/train.mjs              # retrain from stored labels
node src/train.mjs --bootstrap  # first seed labels from historical Applied (→1) / Ignored (→0) sheets
```

- Skipped (existing model kept) until ≥10 examples of each class exist.
- Class imbalance (few applied, many ignored) is handled by upweighting positives `nNeg/nPos`.
- **Skill is reported via a stratified 80/20 holdout** (`evaluateHoldout` in model.mjs, seeded shuffle → reproducible): precision + recall on the positive class, measured on unseen labels. Training accuracy is never reported — at ~4% positive rate the always-ignore baseline scores 96%, making it meaningless. The final model still trains on all labels; the holdout is measurement only.
- Bootstrap only adds links not already in the store; when a link appears in both sheets, the applied label wins.
- Output: `data/model.json` `{ weights[9], bias, meta: { trainedAt, nPos, nNeg, features } }`. Both data files are gitignored. `loadModel` ignores legacy models without `meta.features` (pre feature-model 384-dim weights), so a stale file just means the prior is used until the next retrain.
- If labels are ever lost (e.g. a failed apply run), `--bootstrap` rebuilds them from the sheets.

---

## Score (src/score.mjs)

Productionizes `scoreJobs()` from `src/ml/scorer.mjs` against the Potential sheet (same function `test/test-ml.mjs` exercises). Runs automatically as the last step of `npm run scan`, or standalone via `node src/score.mjs`.

**Scoring formula** (lives in scorer.mjs + features.mjs): `score = sigmoid(bias + Σ weightᵢ·featureᵢ)` over the 9 named features. Weights come from `data/model.json` when trained, otherwise from the hand-tuned prior (`DEFAULT_MODEL` in features.mjs) — there is no blending or anchor; the feature model IS the score, and every job carries a `.features` map plus an `.explanation` with per-feature `weight×value` contributions. The console prints which weights are active (trained vs prior cold start).

**Flow:**
1. Find the data extent via the column-B (Date Found) counter — `getFirstEmptyRow()` — and read exactly `Potential!A2:K{lastDataRow}` (avoids the hundreds of trailing checkbox-only rows that an open-ended `A:K` read returns, which previously overflowed the grid on clear).
2. Join each row's description from `data/job-descriptions.json` (by link, via `loadDescriptions()`); rows without one are scored on title-only text.
3. `scoreJobs(jobs)` → sigmoid probability 0–1 per job (rubric embedded once; label history loaded for company_prior / history_similarity).
4. Map to 1–10 (`score10 = round(1 + score·9, 1)`) and `values.update` → `Potential!K1:K{lastDataRow}` (header "Match Score" + one score per row, aligned by row).
5. Write the per-feature breakdown to `Potential!L1:T{lastDataRow}` — one column per feature in `FEATURE_NAMES` order, headers in row 1, each cell the feature's **contribution** (weight×value) to that row's score. Contributions are signed and sum with the model bias to the score's logit, so the sheet shows *why* each job ranked where it did.
6. Sort the data rows A–T by Match Score descending (checkboxes and feature values move with their rows), then `values.clear` → `Potential!K{firstEmpty}:T` to wipe stale scores/features below the current data.

`--dry-run` prints the ranked summary without writing. `--top N` sets how many rows the console summary lists (default 20). `--explain N` additionally prints the full per-feature breakdown (`value × weight = contribution`, largest first) for the top N jobs — the fastest way to see *why* something ranked where it did.

### rubric.yml — where the preference features come from

The hand-edited **`rubric.yml`** at the repo root expresses what you *want*: preferred domains (weighted full-sentence descriptions), anti-preferences, preferred titles, YOE window, and literal-match skill/language/penalty keyword lists. It feeds 7 of the 9 features (domain_match, skill_overlap, language_overlap, penalty_overlap, anti_margin, yoe_gap, title_match); without the file those features are all 0 and only company_prior + history_similarity carry signal, so keep it around. The top-N listing tags each row with its matched domain plus `[anti:…]`/`[YOE]` flags.

**Validate before trusting a rubric edit:** `node scripts/eval-rubric.mjs` replays your stored apply/ignore labels (`data/training-data.json`, description-bearing entries) and reports precision@25, precision@50, and mean positive rank — no Sheets access. If an edit ranks your real applies lower (higher mean positive rank), tune the domain descriptions/weights and re-run.

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

**Scope: checks every row by default.** Rows sit in Potential from scan time until `apply` runs — sometimes days — so a scan-sourced row being live when written doesn't guarantee it's still live now. Pass `--websearch-only` to skip `Source = scan` rows (column J) and restore the old cheap/fast pass.

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

