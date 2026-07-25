# career-ops

Personal job search pipeline for Eric Chen — MS CS student at Northeastern University, targeting backend / distributed systems / infrastructure roles (new grad, fall 2026 intern), graduating August 2026.

Zero-token scanning across **567 companies** spanning 14 ATS platforms. No AI required for day-to-day use.

---

## How it works

```
npm run scan           # scan all 567 portals → filter → write to Potential → prune dead links
                       # review in Google Sheets, check ✓ on jobs you applied to
node src/apply.mjs     # ✓ rows → Applied, rest → Ignored
```

That's the full loop. Run `npm run scan` daily. Review and process with `apply.mjs`.

To scan specific companies or get all currently open jobs (not just last 48h):
```
node src/jobs.mjs --companies "Stripe, OpenAI, Glean" --all && node src/prune.mjs
```

---

## ML Scoring (Feedback Loop)

Every time you run `/apply`, the pipeline learns from your decisions and improves ranking for next time.

### How it works

1. **Job embedding** — Each job (title + company + full description when available) is embedded into a 384-dimensional vector using [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), a lightweight transformer that runs locally with zero API cost (~25 MB, cached after first use).

2. **9 named features** — Every job is scored through a fixed set of interpretable features extracted from its embedding and text:

   | Feature | What it measures |
   |---|---|
   | `domain_match` | Max weighted cosine between the job and your rubric's preferred domains |
   | `skill_overlap` | Fraction of `preferred_skills` keywords found in the JD |
   | `language_overlap` | Fraction of `programming_languages` keywords found in the JD |
   | `penalty_overlap` | Fraction of `penalty_keywords` found in the JD — penalty signal |
   | `anti_margin` | Best anti-preference cosine minus best domain cosine — fires only when a JD resembles an anti more than any preferred domain |
   | `yoe_gap` | max(0, demanded YOE − rubric yoe.max), clamped at 5; unknown and under-max both score 0 |
   | `company_prior` | Smoothed apply rate at this company from past decisions |
   | `history_similarity` | Mean cosine to the top-3 nearest jobs you previously applied to |
   | `title_match` | Max cosine between the job title and your `preferred_titles` list |

3. **Scoring formula** — Match Score = `sigmoid(bias + Σ weightᵢ · featureᵢ)`. Weights come from `data/model.json` when a trained model exists; otherwise the hand-tuned prior (`DEFAULT_MODEL` in `src/ml/features.mjs`) serves as the cold-start scorer. Either way, `score.mjs` writes a full per-feature breakdown to Potential columns L–T so every score is explainable.

4. **Feedback model** — When you run `/apply`:
   - Each job you checked → label 1 (applied), unchecked → label 0 (ignored)
   - Features are recomputed for every description-bearing label with a leave-one-out guard on `company_prior` and `history_similarity` so an example's own label can't leak into its own features
   - A logistic regression trains over those 9-dim feature vectors (gradient descent, L2 regularization, minority class upweighted by nNeg/nPos) warm-starting from the hand-tuned prior
   - Training requires ≥ 10 description-bearing examples of each class; otherwise the prior is kept
   - Training happens in-process: no external API calls

5. **Explainability** — Because the model operates over 9 named features rather than an opaque embedding vector, every score decomposes cleanly. `node src/score.mjs --dry-run --explain 5` prints which features drove each job's score up or down.

### Performance

Current precision/recall is printed at the end of every training run:

```
node src/train.mjs
```

The holdout is a stratified 80/20 split (seeded shuffle, reproducible across runs). Only description-bearing labels are used — title-only entries ("Software Engineer at X") embed near-identically across wildly different roles and would teach the model title phrasing rather than your actual preferences.

### Evaluation metrics — what they mean and why these ones

Two different questions get two different metric sets.

**1. Is the feedback model learning?** (`src/train.mjs`, printed after every retrain)

The model is evaluated on a **stratified 80/20 holdout**: 20% of labels are hidden during training and predicted afterwards, with "stratified" meaning the apply/ignore ratio is preserved in both halves (the shuffle is seeded, so runs are reproducible). On that held-out set we report, for the *positive* class only:

- **Precision** — of the jobs the model flags "would apply," what fraction did you actually apply to? Low precision = the score cries wolf.
- **Recall** — of the jobs you actually applied to, what fraction did the model flag? Low recall = good jobs get buried.

Plain *accuracy* is deliberately never reported: with ~9% positives, a model that says "ignore everything" scores 91% accurate while being useless. Precision/recall on the rare class is the honest view. Because a single 80/20 split of ~390 labels is noisy, any change to the training pipeline is judged over **multiple seeds** (typically 7 different splits) — a "win" that only appears on one split is split luck, not signal.

**2. Does the anchor (rubric or resume) rank well?** (`scripts/eval-rubric.mjs`)

The anchor isn't a classifier — it produces a *ranking* of the Potential sheet, and what matters is whether jobs you'd apply to float to the top. So it's measured with ranking metrics over all stored labels (no holdout needed — the rubric is hand-written, not fit to the labels, so it can't memorize them the way a trained model can):

- **Mean positive rank** — sort all ~390 labeled jobs by score, then average the positions of your 36 actual applies. Random ordering ≈ 196; lower is better. This is the primary tuning target because it uses every positive, so it's the most stable number at this sample size.
- **Precision@25 / precision@50** — of the top 25 (or 50) ranked jobs, what fraction are actual applies? This mirrors real usage: you review the top of the sorted sheet, so it measures "how good is the first screenful." It's coarser (one job moving across the cutoff swings p@25 by 4 points), which is why it's the sanity check rather than the target.

A change must not trade these off blindly — several experiments improved mean rank while dropping p@25, meaning the *middle* of the ranking got better while the top got worse; those were rejected. The standing caveat: all of this is computed on 36 positives, so small deltas (a few rank points, one p@25 step) are noise — only changes that move mean rank by ~10%+ with flat-or-better precision get adopted.

### Key insight

The model trains **only on description-bearing labels** — entries where the job description was available. Title-only entries ("Software Engineer at X") embed nearly-identically for wildly different jobs and teach the model title phrasing rather than your actual preferences. Descriptions are fetched automatically during `npm run scan` and cached in `data/job-descriptions.json`.

### Rubric mode

Cosine similarity measures what your resume *resembles*; it can't know what you *want*. Drop a hand-edited **`rubric.yml`** at the repo root and scoring auto-switches to "rubric mode": the rubric score replaces resume cosine as the anchor in the blend above (the feedback model is untouched). The rubric declares:

- `preferred_domains` — weighted, full-sentence descriptions of the work you want (they're embedded, so sentences beat keyword lists)
- `anti_preferences` — full-sentence descriptions of work you want to avoid (a job is penalized only when it resembles an anti *more* than any preferred domain)
- `preferred_skills` — plain keywords matched literally against the JD (small bonus per hit)
- `yoe` — an experience window; jobs demanding more than `yoe.max` are discounted

Edit it freely, then **validate before you trust it**:

```bash
node scripts/eval-rubric.mjs   # resume vs rubric ranking on your real apply/ignore labels
```

It replays your stored labels and prints precision@25/@50 and mean positive rank for both anchors, with a verdict on whether the rubric ranks your actual applies higher than the resume does. Tune the domain descriptions/weights until it beats the resume. Delete/rename `rubric.yml` to return to resume mode.

### How the rubric was tuned (and why it beats the resume)

The rubric wasn't written once and trusted — every change was measured against the real apply/ignore labels. The journey, with mean positive rank (lower = your actual applies rank higher; resume baseline 178.7):

| Iteration | Mean rank | What changed |
|---|---|---|
| First draft (aspirational domains) | 224.8 | Hand-written "what I want" sentences — **lost to the resume** |
| Resume-derived content | 200.6 | Rebuilt domains from coursework + projects (work history excluded); removed a Frontend anti-preference that penalized actual applies at 2× the rate of ignores |
| Weight grid search | 132.5 | Discovery: a *general new-grad SWE* catch-all domain at dominant weight beats every specialist emphasis — first config to beat the resume |
| Parallel experiments (3 agents) | 90.1 | Title-list catch-all, mined domains, keyword penalties (below) |
| Structural experiments (5 agents) | **80.8** | `preferred_titles` blend — job title embedded separately, blended at β=0.3 (below) |

The final round ran three independent, parallel experiments against the same labels:

1. **Domain wording** — the single biggest lever: writing the catch-all domain as a bare **job-title list** ("Software Engineer, New Grad, Software Engineer I, …") instead of prose. JDs lead with their title, so title phrases embed far closer to them than candidate-perspective sentences. Also added two domains mined from the actual applied set (Fintech & Trading, Developer Tools). Null results worth knowing: "job-ad voice" prose tested *worse*, shorter prose hurt, an AI-infra domain didn't help.
2. **Scoring mechanics** — confirmed `max` over domains beats mean/softmax aggregation; found the anti-preference and YOE gates never fire on current data (harmless insurance, unproven).
3. **Keyword mining** — the honest split: *positive* keyword tuning is statistical noise at 36 applies (greedy "improvements" fail leave-one-out stability), but *negative* keywords carry real signal at high counts: `terraform` appears in 0 applies / 40 ignores, `azure` 0/32, `agile` 1/46. These became the `penalty_keywords` bucket (subtract 0.2 × fraction matched).

**Why a rubric can beat the resume at all:** the resume is one long document — its embedding is an average of everything you've ever done, so it matches generic JDs indiscriminately. The rubric is a *set* of targeted vectors scored by best-match, plus literal keyword signals the embedding can't express (nothing in embedding space says "terraform in a JD means Eric skips it" — the label data does).

**Caveats:** everything is tuned on 36 historical applies — a compass, not a guarantee. The tuning also revealed that stated and revealed preferences disagree (kubernetes/devops are *penalty* keywords despite infra being an aspirational domain); the yml documents this so you can override it deliberately. Re-run the eval as labels accumulate.

A second round tested five *structural* changes (new sections/mechanics rather than content), each in an isolated worktree against the same labels. Four were discarded on the evidence: phrase-level domain embeddings (splitting prose into short phrases *lost* ~18 rank points — isolated phrases let single-keyword matches dominate), base+additive specialist bonuses (every τ/weight combo lost to max-over-domains), per-keyword statistical weights (low-count keyword weights flip sign under resampling; cost 8 points of p@25), and a continuous anti-preference penalty (safe but moved mean rank only 90.1 → 88.6 with zero precision change). One shipped: a **`preferred_titles` section** — a handful of target titles embedded and compared against the job *title* alone (the body embedding dilutes the title in ~500 words of JD), blended as `0.7·body + 0.3·titleScore`. That took mean rank 90.1 → **80.8** and p@50 26% → 32%, stable for β in 0.2–0.4.

Final: **mean rank 80.8 vs 178.7, precision@25 40% vs 20%, precision@50 32% vs 12%**.

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

node src/probe-ats.mjs                     # find ATS APIs for websearch-only companies
node src/probe-ats.mjs --apply             # also patch portals.yml with found APIs
node src/probe-ats.mjs --company "Stripe"  # probe a specific company

node src/check-liveness.mjs              # health-check every API endpoint in portals.yml
node src/check-liveness.mjs --verbose    # also show HTTP status per company

npm test                       # run 95-test suite (filters, parsers, classifiers)
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
- node:test + node:assert — 95-test suite, zero extra deps
- Playwright MCP — optional, only for link verification of generic websearch URLs
- Anthropic SDK — optional (legacy `evaluate.mjs` removed; deep evaluation now via Claude Code skills)

---

## Repo layout

```
src/
  jobs.mjs              ← daily scanner (entry point)
  apply.mjs             ← Potential → Applied/Ignored + record labels + retrain model
  score.mjs             ← write Match Score (col K) + per-feature contributions (cols L–T), sort by score
  train.mjs             ← retrain feedback model from apply/ignore labels (--bootstrap seeds from sheets)
  prune.mjs             ← remove dead links from Potential
  write-potential.mjs   ← stdin JSON → Potential (used by /websearch-jobs)
  check-liveness.mjs    ← health-check all API endpoints in portals.yml
  probe-ats.mjs         ← discover ATS APIs for websearch-only companies
  config.mjs            ← portals.yml loader with defaults
  sheets-client.mjs     ← Google Sheets auth + helpers
  filters.mjs           ← isUS, extractMinYOE, buildTitleFilter, looksLikeJobUrl
  ats.mjs               ← all 17 ATS adapters (boardApi, parse, parseLink, fetchAll)
  fetch.mjs             ← fetchJson/fetchResponse with timeout + retry/backoff
  potential-writer.mjs  ← appendToPotential, fetchSeenLinks, buildCheckboxRequest
  ml/
    scorer.mjs          ← job scoring: sigmoid over 9 named features (MiniLM embeddings)
    features.mjs        ← the 9 named features + prior weights, extraction + explainScore
    model.mjs           ← logistic-regression feedback model (train/predict/holdout-eval)
    rubric.mjs          ← preference-rubric signals (loadRubric/embedRubric/rubricSignals)
    parser.mjs          ← resume parser (PDF→pdf-parse→Gemini cleanup, or TXT/MD direct)
    descriptions.mjs    ← job-description cache (data/job-descriptions.json)
    training-data.mjs   ← labeled apply/ignore store (data/training-data.json)

scripts/
  eval-rubric.mjs       ← offline harness: resume vs rubric ranking on stored labels (no Sheets)

test/
  test-all.mjs          ← main test suite (95 tests: filters, parsers, classifiers)
  test-ml.mjs           ← standalone ML pipeline test (no Sheets needed)

portals.yml             ← 567 companies + scan config
rubric.yml              ← hand-edited preference rubric (source of 7 of the 9 scoring features)
.claude/skills/         ← /scan, /scanall, /apply, /websearch-jobs
```
