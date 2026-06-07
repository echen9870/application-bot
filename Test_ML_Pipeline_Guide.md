# Test ML Pipeline (test-ml.mjs)

## Purpose
**Standalone end-to-end test of the ML scoring system** — validates that resume parsing, job fetching, filtering, and embedding/scoring all work together **before integrating into the live jobs.mjs pipeline**.

No Google Sheets credentials required. No impact on real data.

---

## When to Use It

### ✅ Use test-ml.mjs when:
- **Developing the ML scoring feature** — test in isolation
- **Debugging embeddings or filters** — understand why jobs score the way they do
- **Validating resume parsing** — ensure your resume loads correctly
- **Testing new ATS integrations** — fetch jobs from new platforms without touching Sheets
- **Tuning filter thresholds** — try different YOE, recency, or title settings
- **No Google Sheets API key available** — test ML without auth

### ❌ Don't use test-ml.mjs when:
- **Running the production job scan** — that's `jobs.mjs`
- **Writing results to Google Sheets** — test-ml only prints to console
- **Appending to the Potential sheet** — test-ml doesn't touch Sheets

---

## How It Works: Five-Stage Pipeline

### Stage 1: Load Resume
```bash
node test/test-ml.mjs                    # Load from data/resume.{pdf,txt,md}
node test/test-ml.mjs --mock-resume      # Use built-in sample resume (no file needed)
```

**Input:** Resume file or mock
**Output:** Plain text resume (same as parser.mjs produces)

### Stage 2: Fetch Jobs from Multiple ATS Platforms
```
For each TEST_COMPANY in list:
  ✓ Notion (Ashby)
  ✓ Linear (Ashby)
  ✓ Stripe (Greenhouse)
  ✓ Segment (Greenhouse)
  ✓ Twilio (Greenhouse)
  ✓ Shopify (Greenhouse)
  ✓ AngelList (Lever)
  ✓ Rippling (Lever)
  ✓ Intel (SmartRecruiters)
  ✓ Cisco (SmartRecruiters)
```


**Output:** ~200–500 raw job listings (all companies combined, descriptions not yet fetched for Greenhouse)

### Stage 2.5: Fetch Greenhouse Descriptions
Greenhouse returns job listings **without** descriptions in the list API. For jobs marked with `_id` and `_slug` (Greenhouse metadata), fetch the full job description:

```
For each Greenhouse job:
  API call → fetch full job description
  Strip HTML tags
  Normalize whitespace
  Store as job.description
```

**Why separate?** Greenhouse requires an individual API call per job description. This is parallel (async/await) but still expensive, so it's optional via `--desc` flag in jobs.mjs.

**In test-ml:** Always run to ensure descriptions are rich for scoring.

**Output:** All jobs now have a `.description` field (or empty string if fetch failed)

### Stage 3: Apply Filters
Same filters as jobs.mjs:

```
For each job:
  ✗ Title doesn't match titleFilter config     → titleFiltered++
  ✗ Posted >48 hours ago (unless --all flag)  → oldFiltered++
  ✗ Non-US location                            → nonUS++
  ✗ Minimum YOE > MAX_YOE config               → yoeFiltered++
  ✓ Passes all filters                         → kept for scoring
```

**Example filters (from portals.yml `scan_config`):**
```yaml
max_yoe: 3              # Filter out jobs requiring 3+ years experience
recency_hours: 48       # Only jobs posted in last 48 hours
title_filter:
  include: ["engineer", "backend", "infra"]
  exclude: ["principal", "staff", "sales"]
```

**Output:** Filtered job list (typically 20–100 jobs from 200–500 fetched)

### Stage 4: Score Filtered Jobs
```
1. Embed resume text once
   resume_vec = embed(resume_text)

2. For each filtered job:
   job_vec = embed(job.description or fallback)
   similarity_score = cosine_similarity(resume_vec, job_vec)
   job.score = similarity_score  (0.0 to 1.0)

3. Sort jobs by score descending (best first)
```

**Scoring uses local embeddings (@xenova/transformers):**
- First run: downloads ~25MB model, caches it
- Subsequent runs: reuses cached model (zero cost)

**Output:** Sorted list of scored jobs

### Stage 5: Print Results
```
Top 20 matches (or --top N):
  1. [0.842] ██████░░░░  Acme Corp — Senior Engineer
       📍 Boston, MA
  2. [0.781] ██████░░░░  TechCo — Staff Engineer
       📍 New York, NY
  ...
```

Visual score bar shows relative match quality.

---

## Command-Line Flags

### `--mock-resume`
Use a built-in sample resume instead of loading from `data/`. Useful for testing when you don't have a resume file yet.

```bash
node test/test-ml.mjs --mock-resume
```

### `--top N`
Show top N matches (default: 20).

```bash
node test/test-ml.mjs --top 30
```

### `--all`
Skip the recency filter (show all jobs regardless of posting date). Useful for testing with small job pools.

```bash
node test/test-ml.mjs --all
```

### Combine flags:
```bash
node test/test-ml.mjs --mock-resume --top 50 --all
```

---

## Key Differences: test-ml.mjs vs jobs.mjs

| Aspect | test-ml.mjs | jobs.mjs |
|--------|-------------|----------|
| **Output** | Console only | Appends to Google Sheets Potential |
| **Auth** | None required | Requires Google Sheets API key |
| **Data Impact** | None (read-only) | Writes new rows to Sheets |
| **Resume Source** | Hardcoded companies (10) or --mock-resume | Configured via portals.yml |
| **Filtering** | Same filters as jobs.mjs | Identical |
| **Scoring** | Full embedding + cosine similarity | _(Future: will integrate ML scoring)_ |
| **Use Case** | Development, debugging, validation | Production job scanning |

---

## How test-ml.mjs Prepares for Integration into jobs.mjs

### Current Flow (jobs.mjs):
```
1. Fetch jobs from all enabled companies
2. Filter jobs (title, location, YOE, recency)
3. Deduplicate against Sheets
4. ✓ Append to Potential (all qualified jobs have equal weight)
```

### Future Flow (jobs.mjs + ML scoring):
```
1. Fetch jobs from all enabled companies
2. Filter jobs (title, location, YOE, recency)
3. Deduplicate against Sheets
4. ✗ Score remaining jobs against cached resume (NEW)
5. ✓ Append to Potential with .score column
6. ✓ User sorts by score to see best matches first
```

**What test-ml.mjs validates:**
- ✓ Parser loads and caches resume correctly
- ✓ Jobs fetch across multiple ATS platforms
- ✓ Greenhouse descriptions can be fetched in parallel
- ✓ Filters work as expected
- ✓ Scorer embeds and ranks jobs correctly
- ✓ Output is human-readable and sensible

Once test-ml.mjs passes, the `scoreJobs()` function is ready to be called in jobs.mjs's append-to-Sheets flow.

---

## Example Output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ML Pipeline Test — Resume × Job Scoring (Filtered)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1/4] Loading resume...
      47 lines loaded.

[2/4] Fetching job listings from multiple ATS platforms...
      ✓ Notion             (ashby)              12 jobs
      ✓ Linear             (ashby)              8 jobs
      ✓ Stripe             (greenhouse)         45 jobs
      ✓ Segment            (greenhouse)         22 jobs
      ✓ Twilio             (greenhouse)         38 jobs
      ✓ Shopify            (greenhouse)         67 jobs
      ✓ AngelList          (lever)              15 jobs
      ✓ Rippling           (lever)              19 jobs
      ✓ Intel              (smartrecruiters)    31 jobs
      ✓ Cisco              (smartrecruiters)    29 jobs
      Total fetched: 286 jobs

[2.5/4] Fetching descriptions for 202 Greenhouse job(s)...
      ✓ Fetched 198 descriptions
      ✗ 4 descriptions failed (will use fallback)

[3/4] Filtering jobs (title, location, YOE, recency)...
      Title filtered: 92
      Non-US removed: 48
      YOE > 3: 31
      Old (>48h): 18
      Remaining to score: 97

[4/4] Scoring 97 job(s) against resume...
  [scorer] Embedding resume...
  [scorer] Scoring 97 job(s)...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Top 20 Matches (out of 97 qualified)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. [0.842] ████████░░  Stripe — Backend Engineer, Infrastructure
       📍 San Francisco, CA
   2. [0.831] ████████░░  Twilio — Senior Software Engineer
       📍 San Francisco, CA
   3. [0.798] ███████░░░  Shopify — Platform Engineer
       📍 Toronto, ON (remote-friendly)
   4. [0.781] ███████░░░  Linear — Full Stack Engineer
       📍 San Francisco, CA
   5. [0.764] ███████░░░  Segment — Data Engineer
       📍 San Francisco, CA
   6. [0.742] ██████░░░░  Notion — Backend Engineer
       📍 San Francisco, CA
   7. [0.725] ██████░░░░  AngelList — Software Engineer
       📍 Remote
   8. [0.698] ██████░░░░  Twilio — Full Stack Engineer
       📍 Remote
   9. [0.687] ██████░░░░  Rippling — Infrastructure Engineer
       📍 San Francisco, CA
  10. [0.672] █████░░░░░  Stripe — Full Stack Engineer
       📍 New York, NY
  ... (11–20 omitted)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Score range: 0.623 – 0.842
  Average    : 0.743
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Troubleshooting

### "No jobs fetched — check your internet connection"
- One or more ATS APIs timed out or are unreachable
- Check network connectivity
- Try running with a single company: `node src/jobs.mjs --companies "Stripe"`

### Embedding model slow on first run
- First run downloads ~25MB from Hugging Face (~30 sec on 4G)
- Subsequent runs use cached model (instant)
- Once downloaded, embedding is fully offline (zero API calls)

### Greenhouse descriptions show as empty
- Greenhouse list API doesn't include descriptions
- You must run with `--desc` flag to fetch them individually
- Each fetch is one API call, runs in parallel (configurable concurrency)

### Scores seem low (all <0.7)
- This is normal if the resume and job descriptions are semantically different
- Use `--mock-resume` to test with a generic resume
- Review job descriptions: if they're very brief or domain-specific, scores will be lower

---

## Next Steps

Once test-ml.mjs consistently produces good scores:

1. **Integrate `scoreJobs()` into jobs.mjs**
   - After filtering, call `scoreJobs(resumeText, filteredJobs)`
   - Add `score` column to the Potential sheet write

2. **Add score column to Google Sheets**
   - Add "Score" header to Potential sheet
   - User can sort by Score descending to see best matches first

3. **Run production:**
   ```bash
   node src/jobs.mjs --desc
   # Jobs append to Potential with scores
   ```
